import { Injectable } from '@nestjs/common';

import type { Actor } from '../../common/auth/actor';
import {
  DatabaseService,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from '../../common/db/database.service';
import { ConflictError, InvalidError } from '../../common/errors/domain-error';
import { AppConfig } from '../../config/app-config';
import {
  DATA_STORE_KINDS,
  DEFAULT_DATA_STORE,
  type DataStoreKind,
} from '../../config/data-stores';
import { KeycloakTenantMirror } from '../../mirrors/keycloak/keycloak-tenant.mirror';
import { OutboxRepository } from '../../sync/outbox.repository';
import { AgentRepository } from '../agents/agent.repository';
import { EnrollmentRepository } from '../enrollments/enrollment.repository';
import { SupportAccessRepository } from '../support-access/support-access.repository';
import { UserRepository } from '../users/user.repository';

import { type TenantRecord, TenantRepository } from './tenant.repository';
import { type TenantView, toTenantView } from './views';

export interface CreateTenantInput {
  tenantKey: string;
  /** Catalog name; default `shared`. Fixed for the tenant's lifetime. */
  metricsStore?: string;
  logsStore?: string;
}

/**
 * Tenant lifecycle. Authorization (platform-admin, tenant scope) is done
 * by the guards before these methods are called.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly agents: AgentRepository,
    private readonly grants: SupportAccessRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly outbox: OutboxRepository,
    private readonly keycloakTenants: KeycloakTenantMirror,
    private readonly config: AppConfig,
  ) {}

  async list(_actor: Actor): Promise<TenantView[]> {
    return (await this.tenants.listActive()).map(toTenantView);
  }

  get(_actor: Actor, tenant: TenantRecord): TenantView {
    return toTenantView(tenant);
  }

  /**
   * One transaction: row + Keycloak group (inline, so users can be created
   * right away) + outbox (Grafana org). Keycloak down → nothing created.
   *
   * TODO-28: the stores must exist in the catalog; an exclusive (1:1)
   * store takes at most one tenant that is not deleted (checked under a
   * per-store lock, so two concurrent creates cannot both get it).
   */
  async create(_actor: Actor, input: CreateTenantInput): Promise<TenantView> {
    const tenantKey = input.tenantKey;

    const stores: Record<DataStoreKind, string> = {
      metrics: input.metricsStore ?? DEFAULT_DATA_STORE,
      logs: input.logsStore ?? DEFAULT_DATA_STORE,
    };

    for (const kind of DATA_STORE_KINDS) {
      if (!this.config.dataStores[kind][stores[kind]]) {
        throw new InvalidError(
          'unknown_data_store',
          `There is no ${kind} store named "${stores[kind]}"`,
          {
            kind,
            store: stores[kind],
            available: Object.keys(this.config.dataStores[kind]).sort(),
          },
        );
      }
    }

    return this.db.transaction(async (tx) => {
      for (const kind of DATA_STORE_KINDS) {
        if (!this.config.dataStores[kind][stores[kind]].exclusive) {
          continue;
        }

        await this.tenants.lockStore(tx, kind, stores[kind]);

        if ((await this.tenants.countInStore(tx, kind, stores[kind])) > 0) {
          throw new ConflictError(
            'data_store_taken',
            `The ${kind} store "${stores[kind]}" is dedicated to another tenant`,
            { kind, store: stores[kind] },
          );
        }
      }

      let tenant: TenantRecord;

      try {
        tenant = await this.tenants.insertActive(tx, tenantKey, {
          metricsStore: stores.metrics,
          logsStore: stores.logs,
        });
      } catch (error) {
        if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
          throw new ConflictError(
            'tenant_key_reserved',
            'This tenant key is already used or was used before',
          );
        }

        throw error;
      }

      await this.keycloakTenants.apply(tenant, tx);
      await this.outbox.enqueue(tx, 'tenant', tenant.id);

      return toTenantView(
        (await this.tenants.findById(tenant.id, tx)) ?? tenant,
      );
    });
  }

  /**
   * One transaction: tenant deleted + its users deleted + its agents
   * revoked (decision Q1) + open support grants and unused enrollments
   * ended; the mirrors then
   * delete the Keycloak group/users/clients and the Grafana org.
   * Metrics and logs stay in storage (TODO-08).
   */
  async delete(actor: Actor, tenant: TenantRecord): Promise<void> {
    if (tenant.tenantKey === this.config.grafana.defaultTenant) {
      throw new ConflictError(
        'tenant_is_platform',
        'The platform tenant cannot be deleted',
      );
    }

    await this.db.transaction(async (tx) => {
      await this.tenants.markDeleted(tx, tenant.id);

      const userIds = await this.users.markTenantUsersDeleted(tx, tenant.id);
      const agentIds = await this.agents.revokeTenantAgents(tx, tenant.id);
      const grantUserIds = await this.grants.revokeOpenForTenant(
        tx,
        tenant.id,
        actor.username,
      );

      // Unused tokens of a deleted tenant must not create agents.
      await this.enrollments.revokeOpenForTenant(tx, tenant.id, actor.userId);

      await this.outbox.enqueue(tx, 'tenant', tenant.id);

      for (const id of new Set([...userIds, ...grantUserIds])) {
        await this.outbox.enqueue(tx, 'user', id);
      }

      for (const id of agentIds) {
        await this.outbox.enqueue(tx, 'agent', id);
      }
    });
  }
}
