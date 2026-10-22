import type { DatabaseService } from '../../common/db/database.service';
import { ACTORS, fakeDb, IDS, tenant } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type { KeycloakTenantMirror } from '../../mirrors/keycloak/keycloak-tenant.mirror';
import type { OutboxRepository } from '../../sync/outbox.repository';
import type { AgentRepository } from '../agents/agent.repository';
import type { EnrollmentRepository } from '../enrollments/enrollment.repository';
import type { SupportAccessRepository } from '../support-access/support-access.repository';
import type { UserRepository } from '../users/user.repository';

import type { TenantRepository } from './tenant.repository';
import { TenantsService } from './tenants.service';

function setup(
  opts: { insertError?: unknown; inStore?: number; config?: AppConfig } = {},
) {
  const { db, tx } = fakeDb();

  const created = tenant({
    id: 'new',
    tenantKey: 'gamma-tenant',
    keycloakGroupId: null,
  });

  const tenants = {
    listActive: jest.fn().mockResolvedValue([tenant()]),
    insertActive: jest.fn(() =>
      opts.insertError
        ? Promise.reject(opts.insertError as Error)
        : Promise.resolve(created),
    ),
    findById: jest
      .fn()
      .mockResolvedValue({ ...created, keycloakGroupId: 'g-new' }),
    markDeleted: jest.fn().mockResolvedValue(undefined),
    lockStore: jest.fn().mockResolvedValue(undefined),
    countInStore: jest.fn().mockResolvedValue(opts.inStore ?? 0),
  };

  const users = {
    markTenantUsersDeleted: jest.fn().mockResolvedValue(['u1', 'u2']),
  };
  const agents = { revokeTenantAgents: jest.fn().mockResolvedValue(['a1']) };
  const grants = {
    revokeOpenForTenant: jest.fn().mockResolvedValue(['u2', 'admin1']),
  };
  const enrollments = {
    revokeOpenForTenant: jest.fn().mockResolvedValue(1),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const keycloakTenants = { apply: jest.fn().mockResolvedValue(undefined) };

  const service = new TenantsService(
    db as unknown as DatabaseService,
    tenants as unknown as TenantRepository,
    users as unknown as UserRepository,
    agents as unknown as AgentRepository,
    grants as unknown as SupportAccessRepository,
    enrollments as unknown as EnrollmentRepository,
    outbox as unknown as OutboxRepository,
    keycloakTenants as unknown as KeycloakTenantMirror,
    opts.config ?? AppConfig.forTest(),
  );

  return {
    service,
    tenants,
    users,
    agents,
    grants,
    enrollments,
    outbox,
    keycloakTenants,
    tx,
    created,
  };
}

describe('TenantsService.create', () => {
  it('row + inline Keycloak group + outbox in one transaction', async () => {
    const { service, tenants, keycloakTenants, outbox, tx, created } = setup();

    const view = await service.create(ACTORS.platformAdmin, {
      tenantKey: 'gamma-tenant',
    });

    expect(tenants.insertActive).toHaveBeenCalledWith(tx, 'gamma-tenant', {
      metricsStore: 'shared',
      logsStore: 'shared',
    });
    expect(tenants.lockStore).not.toHaveBeenCalled();
    expect(keycloakTenants.apply).toHaveBeenCalledWith(created, tx);
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, 'tenant', 'new');
    expect(view).toEqual({
      tenantKey: 'gamma-tenant',
      vmAccountId: '2',
      metricsStore: 'shared',
      logsStore: 'shared',
      grafanaOrgId: 7,
      status: 'active',
      createdAt: created.createdAt,
    });
  });

  it('a key used before → 409 tenant_key_reserved (never reused)', async () => {
    const { service, keycloakTenants } = setup({
      insertError: Object.assign(new Error('dup'), { code: '23505' }),
    });

    await expect(
      service.create(ACTORS.platformAdmin, { tenantKey: 'beta-tenant' }),
    ).rejects.toMatchObject({
      code: 'tenant_key_reserved',
    });
    expect(keycloakTenants.apply).not.toHaveBeenCalled();
  });
});

describe('TenantsService.create (data stores, TODO-28)', () => {
  const catalog = {
    metrics: {
      shared: { name: 'shared', kind: 'metrics' as const, exclusive: false },
      'dedicated-1': {
        name: 'dedicated-1',
        kind: 'metrics' as const,
        exclusive: true,
      },
      pool: { name: 'pool', kind: 'metrics' as const, exclusive: false },
    },
    logs: {
      shared: { name: 'shared', kind: 'logs' as const, exclusive: false },
    },
  };
  const config = AppConfig.forTest({ dataStores: catalog });

  it('a free exclusive store: locked, counted, then the tenant is created in it', async () => {
    const { service, tenants, tx } = setup({ config });

    const view = await service.create(ACTORS.platformAdmin, {
      tenantKey: 'gamma-tenant',
      metricsStore: 'dedicated-1',
    });

    expect(tenants.lockStore).toHaveBeenCalledWith(tx, 'metrics', 'dedicated-1');
    expect(tenants.countInStore).toHaveBeenCalledWith(
      tx,
      'metrics',
      'dedicated-1',
    );
    expect(tenants.insertActive).toHaveBeenCalledWith(tx, 'gamma-tenant', {
      metricsStore: 'dedicated-1',
      logsStore: 'shared',
    });
    expect(view.tenantKey).toBe('gamma-tenant');
  });

  it('an exclusive store already used → 409 data_store_taken, nothing created', async () => {
    const { service, tenants, keycloakTenants } = setup({ config, inStore: 1 });

    await expect(
      service.create(ACTORS.platformAdmin, {
        tenantKey: 'delta-tenant',
        metricsStore: 'dedicated-1',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'data_store_taken' });
    expect(tenants.insertActive).not.toHaveBeenCalled();
    expect(keycloakTenants.apply).not.toHaveBeenCalled();
  });

  it('a shared (non-exclusive) store takes many tenants: no lock, no count', async () => {
    const { service, tenants } = setup({ config, inStore: 5 });

    await service.create(ACTORS.platformAdmin, {
      tenantKey: 'gamma-tenant',
      metricsStore: 'pool',
    });

    expect(tenants.lockStore).not.toHaveBeenCalled();
    expect(tenants.countInStore).not.toHaveBeenCalled();
    expect(tenants.insertActive).toHaveBeenCalled();
  });

  it('a store missing from the catalog → 400 unknown_data_store (before any DB work)', async () => {
    const { service, tenants } = setup({ config });

    await expect(
      service.create(ACTORS.platformAdmin, {
        tenantKey: 'gamma-tenant',
        logsStore: 'dedicated-1',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'unknown_data_store',
      details: { kind: 'logs', store: 'dedicated-1', available: ['shared'] },
    });
    expect(tenants.insertActive).not.toHaveBeenCalled();
  });
});

describe('TenantsService.delete', () => {
  it('cascades users, agents (Q1), grants and unused enrollments in one transaction and enqueues each once', async () => {
    const { service, tenants, users, agents, grants, enrollments, outbox, tx } =
      setup();

    await service.delete(ACTORS.platformAdmin, tenant());

    expect(tenants.markDeleted).toHaveBeenCalledWith(tx, IDS.alpha);
    expect(users.markTenantUsersDeleted).toHaveBeenCalledWith(tx, IDS.alpha);
    expect(agents.revokeTenantAgents).toHaveBeenCalledWith(tx, IDS.alpha);
    expect(grants.revokeOpenForTenant).toHaveBeenCalledWith(
      tx,
      IDS.alpha,
      'root-admin',
    );
    expect(enrollments.revokeOpenForTenant).toHaveBeenCalledWith(
      tx,
      IDS.alpha,
      IDS.platformAdmin,
    );
    expect(
      outbox.enqueue.mock.calls.map(
        (c: unknown[]) => `${String(c[1])}:${String(c[2])}`,
      ),
    ).toEqual([
      `tenant:${IDS.alpha}`,
      'user:u1',
      'user:u2',
      'user:admin1',
      'agent:a1',
    ]);
  });

  it('the platform tenant cannot be deleted', async () => {
    const { service, tenants } = setup();

    await expect(
      service.delete(
        ACTORS.platformAdmin,
        tenant({ tenantKey: 'admin-tenant' }),
      ),
    ).rejects.toMatchObject({ code: 'tenant_is_platform' });
    expect(tenants.markDeleted).not.toHaveBeenCalled();
  });
});
