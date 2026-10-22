import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../common/db/base.repository';
import type { Queryable } from '../../common/db/database.service';
import type { DataStoreKind } from '../../config/data-stores';

export type TenantStatus = 'active' | 'deleted';

export interface TenantRecord {
  id: string;
  tenantKey: string;
  vmAccountId: string;
  /** TODO-28: data store names (catalog), fixed at creation. */
  metricsStore: string;
  logsStore: string;
  keycloakGroupId: string | null;
  grafanaOrgId: number | null;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface TenantRow {
  id: string;
  tenant_key: string;
  vm_account_id: string;
  metrics_store: string;
  logs_store: string;
  keycloak_group_id: string | null;
  grafana_org_id: string | null;
  status: TenantStatus;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const COLUMNS = `
  id, tenant_key, vm_account_id, metrics_store, logs_store,
  keycloak_group_id, grafana_org_id,
  status, created_at, updated_at, deleted_at
`;

/**
 * Tenants are never hard-deleted: tenant_key and vm_account_id are never
 * reused, so a new tenant can never inherit old metrics or logs.
 */
@Injectable()
export class TenantRepository extends BaseRepository<TenantRow, TenantRecord> {
  listActive(): Promise<TenantRecord[]> {
    return this.many(
      `SELECT ${COLUMNS} FROM tenants WHERE status = 'active' ORDER BY vm_account_id`,
    );
  }

  findById(id: string, q?: Queryable): Promise<TenantRecord | null> {
    return this.one(`SELECT ${COLUMNS} FROM tenants WHERE id = $1`, [id], q);
  }

  findByKey(tenantKey: string, q?: Queryable): Promise<TenantRecord | null> {
    return this.one(
      `SELECT ${COLUMNS} FROM tenants WHERE tenant_key = $1`,
      [tenantKey],
      q,
    );
  }

  /** Throws a unique violation (23505) if the key was ever used. */
  async insertActive(
    q: Queryable,
    tenantKey: string,
    stores: { metricsStore: string; logsStore: string },
  ): Promise<TenantRecord> {
    const created = await this.one(
      `INSERT INTO tenants (tenant_key, status, metrics_store, logs_store)
       VALUES ($1, 'active', $2, $3) RETURNING ${COLUMNS}`,
      [tenantKey, stores.metricsStore, stores.logsStore],
      q,
    );

    return created as TenantRecord;
  }

  /**
   * TODO-28: serializes the creates that pick the same store until the
   * caller's transaction ends, so two tenants cannot both take an
   * exclusive (1:1) store.
   */
  async lockStore(
    q: Queryable,
    kind: DataStoreKind,
    store: string,
  ): Promise<void> {
    await this.exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `mtco-data-store:${kind}:${store}`,
    ], q);
  }

  /** Tenants (not deleted) placed in a store. */
  async countInStore(
    q: Queryable,
    kind: DataStoreKind,
    store: string,
  ): Promise<number> {
    const column = kind === 'metrics' ? 'metrics_store' : 'logs_store';

    const result = await q.query<{ n: string }>(
      `SELECT count(*) AS n FROM tenants WHERE status <> 'deleted' AND ${column} = $1`,
      [store],
    );

    return Number(result.rows[0]?.n ?? 0);
  }

  async markDeleted(q: Queryable, id: string): Promise<void> {
    await this.exec(
      `UPDATE tenants SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()) WHERE id = $1`,
      [id],
      q,
    );
  }

  async setKeycloakGroupId(
    id: string,
    groupId: string | null,
    q?: Queryable,
  ): Promise<void> {
    await this.exec(
      `UPDATE tenants SET keycloak_group_id = $2 WHERE id = $1`,
      [id, groupId],
      q,
    );
  }

  async setGrafanaOrgId(
    id: string,
    grafanaOrgId: number | null,
    q?: Queryable,
  ): Promise<void> {
    await this.exec(
      `UPDATE tenants SET grafana_org_id = $2 WHERE id = $1`,
      [id, grafanaOrgId],
      q,
    );
  }

  /**
   * Pointer rule (CLAUDE.md §18.0): live tenants, plus deleted ones that
   * still hold a mirror pointer (cleanup not finished, e.g. a retired
   * Grafana org that Grafana refused to delete).
   */
  /** The ids among `ids` whose tenant is active (Keycloak GC). */
  findActiveIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return this.ids(
      `SELECT id FROM tenants WHERE status = 'active' AND id = ANY($1::uuid[])`,
      [ids],
    );
  }

  findIdsForResync(): Promise<string[]> {
    return this.ids(
      `SELECT id FROM tenants
       WHERE status = 'active'
          OR keycloak_group_id IS NOT NULL
          OR grafana_org_id IS NOT NULL
       ORDER BY vm_account_id`,
    );
  }

  protected map(row: TenantRow): TenantRecord {
    return {
      id: row.id,
      tenantKey: row.tenant_key,
      vmAccountId: String(row.vm_account_id),
      metricsStore: row.metrics_store,
      logsStore: row.logs_store,
      keycloakGroupId: row.keycloak_group_id,
      grafanaOrgId:
        row.grafana_org_id === null ? null : Number(row.grafana_org_id),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }
}
