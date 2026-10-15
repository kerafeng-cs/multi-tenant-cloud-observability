import type { DatabaseService } from '../../common/db/database.service';
import { IDS, tenant, user } from '../../common/testing/fixtures';
import { AppConfig } from '../../config/app-config';
import type {
  TenantRecord,
  TenantRepository,
} from '../tenants/tenant.repository';
import type { UserRecord, UserRepository } from '../users/user.repository';
import type { UsersService } from '../users/users.service';

import { PlatformBootstrapService } from './platform-bootstrap.service';

const ADMIN = {
  username: 'Root-Admin',
  email: 'root@example.com',
  password: 'a-long-password',
  firstName: 'Platform',
  lastName: 'Admin',
};

function setup(opts: {
  admin?: Partial<typeof ADMIN>;
  activeAdmins?: number;
  known?: UserRecord | null;
  lockHeldElsewhere?: boolean;
  platformTenant?: TenantRecord | null;
}) {
  const db = {
    withAdvisoryLock: jest.fn(
      async (_key: number, fn: () => Promise<unknown>) =>
        opts.lockHeldElsewhere
          ? { acquired: false }
          : { acquired: true, result: await fn() },
    ),
  };

  const users = {
    countActivePlatformAdmins: jest
      .fn()
      .mockResolvedValue(opts.activeAdmins ?? 0),
    findLatestByUsername: jest.fn().mockResolvedValue(opts.known ?? null),
  };

  const usersService = {
    createPlatformAdmin: jest.fn().mockResolvedValue(user()),
  };

  const tenants = {
    findByKey: jest
      .fn()
      .mockResolvedValue(
        opts.platformTenant === undefined
          ? tenant({ id: IDS.adminTenant, tenantKey: 'admin-tenant' })
          : opts.platformTenant,
      ),
  };

  const service = new PlatformBootstrapService(
    db as unknown as DatabaseService,
    users as unknown as UserRepository,
    tenants as unknown as TenantRepository,
    usersService as unknown as UsersService,
    AppConfig.forTest({ platformAdmin: { ...ADMIN, ...opts.admin } }),
  );

  return { service, users, usersService, tenants, db };
}

describe('PlatformBootstrapService.run', () => {
  it('creates the initial admin in the platform tenant (lowercased)', async () => {
    const { service, usersService, tenants } = setup({});

    await expect(service.run()).resolves.toBe('created');
    expect(tenants.findByKey).toHaveBeenCalledWith('admin-tenant');
    expect(usersService.createPlatformAdmin).toHaveBeenCalledWith({
      ...ADMIN,
      tenantId: IDS.adminTenant,
      username: 'root-admin',
    });
  });

  it.each([
    ['missing', null],
    ['deleted', tenant({ tenantKey: 'admin-tenant', status: 'deleted' })],
  ])(
    'refuses when the platform tenant is %s',
    async (_label, platformTenant) => {
      const { service, usersService } = setup({ platformTenant });

      await expect(service.run()).resolves.toBe('refused');
      expect(usersService.createPlatformAdmin).not.toHaveBeenCalled();
    },
  );

  it('does nothing when an active platform admin exists (restart is idempotent)', async () => {
    const { service, usersService } = setup({ activeAdmins: 1 });

    await expect(service.run()).resolves.toBe('exists');
    expect(usersService.createPlatformAdmin).not.toHaveBeenCalled();
  });

  it('another replica holds the lock → busy, nothing created (retried later)', async () => {
    const { service, usersService, db } = setup({ lockHeldElsewhere: true });

    await expect(service.run()).resolves.toBe('busy');
    expect(db.withAdvisoryLock).toHaveBeenCalledWith(
      727002,
      expect.any(Function),
    );
    expect(usersService.createPlatformAdmin).not.toHaveBeenCalled();
  });

  it('skips when not configured', async () => {
    const { service } = setup({ admin: { username: '' } });

    await expect(service.run()).resolves.toBe('skipped');
  });

  it.each([
    ['a short password', { password: 'short' }, null],
    ['a missing email', { email: '' }, null],
    [
      'a username of a tenant user',
      {},
      user({ username: 'root-admin', role: 'viewer' }),
    ],
    [
      'a deleted initial admin',
      {},
      user({
        username: 'root-admin',
        role: 'platform-admin',
        status: 'deleted',
      }),
    ],
  ])('refuses %s', async (_label, admin, known) => {
    const { service, usersService } = setup({ admin, known });

    await expect(service.run()).resolves.toBe('refused');
    expect(usersService.createPlatformAdmin).not.toHaveBeenCalled();
  });
});
