import { ConflictError } from '../../common/errors/domain-error';
import { IDS, tenant, user } from '../../common/testing/fixtures';
import type { KeycloakClient } from '../../integrations/keycloak/keycloak.client';
import type { KcUser } from '../../integrations/keycloak/keycloak.types';
import type { TenantRepository } from '../../modules/tenants/tenant.repository';
import type {
  UserRecord,
  UserRepository,
} from '../../modules/users/user.repository';

import { KeycloakUserMirror } from './keycloak-user.mirror';

function account(overrides: Partial<KcUser> = {}): KcUser {
  return {
    id: 'kc-viewer',
    username: 'alice',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'A',
    enabled: true,
    emailVerified: true,
    attributes: { mtco_user_id: [IDS.alphaViewer] },
    ...overrides,
  };
}

function setup(opts: {
  stored?: KcUser | null;
  byName?: KcUser | null;
  /** What getUser returns after a write (marker check). */
  saved?: KcUser | null;
  groups?: { id: string; name: string }[];
  roles?: string[];
  owner?: UserRecord | null;
  tenantGroup?: string | null;
}) {
  const stored = opts.stored === undefined ? null : opts.stored;
  const saved = opts.saved === undefined ? account() : opts.saved;

  // Before any write getUser sees `stored`; afterwards `saved`.
  let written = false;

  const keycloak = {
    getUser: jest.fn(() => Promise.resolve(written ? saved : stored)),
    findUserByUsername: jest.fn().mockResolvedValue(opts.byName ?? null),
    createUser: jest.fn(() => {
      written = true;
      return Promise.resolve<string | null>('kc-new');
    }),
    updateUser: jest.fn(() => {
      written = true;
      return Promise.resolve();
    }),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    resetPassword: jest.fn().mockResolvedValue(undefined),
    logoutUser: jest.fn().mockResolvedValue(undefined),
    getUserGroups: jest.fn().mockResolvedValue(opts.groups ?? []),
    addUserToGroup: jest.fn().mockResolvedValue(undefined),
    removeUserFromGroup: jest.fn().mockResolvedValue(undefined),
    getUserRealmRoles: jest
      .fn()
      .mockResolvedValue(
        (opts.roles ?? []).map((name) => ({ id: `r-${name}`, name })),
      ),
    realmRole: jest.fn((name: string) =>
      Promise.resolve({ id: `r-${name}`, name }),
    ),
    addUserRealmRoles: jest.fn().mockResolvedValue(undefined),
    removeUserRealmRoles: jest.fn().mockResolvedValue(undefined),
  };

  const users = {
    findById: jest.fn().mockResolvedValue(opts.owner ?? null),
    setKeycloakUserId: jest.fn().mockResolvedValue(undefined),
  };

  const tenants = {
    findById: jest.fn().mockResolvedValue(
      tenant({
        keycloakGroupId:
          opts.tenantGroup === undefined ? 'g-alpha' : opts.tenantGroup,
      }),
    ),
  };

  const mirror = new KeycloakUserMirror(
    keycloak as unknown as KeycloakClient,
    users as unknown as UserRepository,
    tenants as unknown as TenantRepository,
  );

  return { mirror, keycloak, users };
}

describe('KeycloakUserMirror (active user)', () => {
  it('creates the account with marker, password, tenant group and role', async () => {
    const { mirror, keycloak, users } = setup({
      saved: account({ id: 'kc-new' }),
    });

    const id = await mirror.apply(user({ keycloakUserId: null }), {
      password: 'pw-123',
    });

    expect(id).toBe('kc-new');
    expect(keycloak.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'alice',
        email: 'alice@example.com',
        enabled: true,
        attributes: { mtco_user_id: [IDS.alphaViewer] },
      }),
    );
    expect(keycloak.resetPassword).toHaveBeenCalledWith('kc-new', 'pw-123');
    expect(keycloak.addUserToGroup).toHaveBeenCalledWith('kc-new', 'g-alpha');
    expect(keycloak.addUserRealmRoles).toHaveBeenCalledWith('kc-new', [
      { id: 'r-viewer', name: 'viewer' },
    ]);
    expect(users.setKeycloakUserId).toHaveBeenCalledWith(
      IDS.alphaViewer,
      'kc-new',
      undefined,
    );
  });

  it('fails loudly when Keycloak drops the marker and removes the account it just created (I-31)', async () => {
    const { mirror, keycloak } = setup({
      saved: account({ id: 'kc-new', attributes: null }),
    });

    await expect(mirror.apply(user({ keycloakUserId: null }))).rejects.toThrow(
      /ADMIN_EDIT/,
    );
    expect(keycloak.deleteUser).toHaveBeenCalledWith('kc-new');
    expect(keycloak.resetPassword).not.toHaveBeenCalled();
  });

  it('keeps the original error when removing the unmarked account fails (I-31)', async () => {
    const { mirror, keycloak } = setup({
      saved: account({ id: 'kc-new', attributes: null }),
    });

    keycloak.deleteUser.mockRejectedValueOnce(new Error('keycloak down'));

    await expect(mirror.apply(user({ keycloakUserId: null }))).rejects.toThrow(
      /ADMIN_EDIT/,
    );
  });

  it('never deletes an existing account whose marker check fails (only fresh creates)', async () => {
    // An orphan of a deleted row: adopted, re-marked, but the marker is dropped.
    const { mirror, keycloak } = setup({
      byName: account({
        id: 'kc-old',
        attributes: { mtco_user_id: [IDS.betaAdmin] },
      }),
      saved: account({ id: 'kc-old', attributes: null }),
    });

    await expect(mirror.apply(user({ keycloakUserId: null }))).rejects.toThrow(
      /ADMIN_EDIT/,
    );
    expect(keycloak.deleteUser).not.toHaveBeenCalled();
  });

  it('409 from Keycloak → identity_conflict', async () => {
    const { mirror, keycloak } = setup({});
    keycloak.createUser.mockResolvedValue(null);

    await expect(
      mirror.apply(user({ keycloakUserId: null })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('stored id pointing at an unmarked account → not ours: refuses', async () => {
    const unmarked = account({ attributes: null });
    const { mirror, keycloak } = setup({ stored: unmarked, byName: unmarked });

    await expect(mirror.apply(user())).rejects.toBeInstanceOf(ConflictError);
    expect(keycloak.updateUser).not.toHaveBeenCalled();
    expect(keycloak.createUser).not.toHaveBeenCalled();
  });

  it('enforces exactly one tenant group and exactly the row role', async () => {
    const { mirror, keycloak } = setup({
      stored: account(),
      groups: [
        { id: 'g-other', name: 'beta-tenant' },
        { id: 'g-alpha', name: 'alpha-tenant' },
      ],
      roles: ['tenant-admin'],
    });

    await mirror.apply(user());

    expect(keycloak.removeUserFromGroup).toHaveBeenCalledWith(
      'kc-viewer',
      'g-other',
    );
    expect(keycloak.removeUserFromGroup).toHaveBeenCalledTimes(1);
    expect(keycloak.addUserRealmRoles).toHaveBeenCalledWith('kc-viewer', [
      { id: 'r-viewer', name: 'viewer' },
    ]);
    expect(keycloak.removeUserRealmRoles).toHaveBeenCalledWith('kc-viewer', [
      { id: 'r-tenant-admin', name: 'tenant-admin' },
    ]);
  });

  it('platform admins are in the platform tenant group (admin-tenant)', async () => {
    const { mirror, keycloak } = setup({
      stored: account({
        id: 'kc-root',
        username: 'root',
        attributes: { mtco_user_id: [IDS.platformAdmin] },
      }),
      groups: [{ id: 'g-alpha', name: 'alpha-tenant' }],
      roles: ['platform-admin'],
      tenantGroup: 'g-admin',
    });

    await mirror.apply(
      user({
        id: IDS.platformAdmin,
        keycloakUserId: 'kc-root',
        username: 'root',
        role: 'platform-admin',
        tenantId: IDS.adminTenant,
        tenantKey: 'admin-tenant',
      }),
    );

    expect(keycloak.removeUserFromGroup).toHaveBeenCalledWith(
      'kc-root',
      'g-alpha',
    );
    expect(keycloak.addUserToGroup).toHaveBeenCalledWith('kc-root', 'g-admin');
  });

  it('disabled: account disabled and sessions ended', async () => {
    const { mirror, keycloak } = setup({ stored: account() });

    await mirror.apply(user({ enabled: false }));

    expect(keycloak.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(keycloak.logoutUser).toHaveBeenCalledWith('kc-viewer');
  });

  it('waits for the tenant group (retry)', async () => {
    const { mirror } = setup({ tenantGroup: null });

    await expect(mirror.apply(user())).rejects.toThrow(/not ready/);
  });

  it('refuses a same-username account that MTCO does not manage', async () => {
    const { mirror } = setup({
      byName: account({ id: 'kc-x', attributes: null }),
    });

    await expect(
      mirror.apply(user({ keycloakUserId: null })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('adopts the account of a DELETED row with the same username (re-created user)', async () => {
    const { mirror, keycloak } = setup({
      byName: account({
        id: 'kc-old',
        attributes: { mtco_user_id: [IDS.betaAdmin] },
      }),
      owner: user({ id: IDS.betaAdmin, status: 'deleted' }),
      saved: account({ id: 'kc-old' }),
    });

    await mirror.apply(user({ keycloakUserId: null }));

    expect(keycloak.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'kc-old',
        attributes: { mtco_user_id: [IDS.alphaViewer] },
      }),
    );
  });
});

describe('KeycloakUserMirror (deleted user)', () => {
  it('deletes its account and clears the pointer', async () => {
    const { mirror, keycloak, users } = setup({ stored: account() });

    await mirror.apply(user({ status: 'deleted' }));

    expect(keycloak.deleteUser).toHaveBeenCalledWith('kc-viewer');
    expect(users.setKeycloakUserId).toHaveBeenCalledWith(
      IDS.alphaViewer,
      null,
      undefined,
    );
  });

  it('never deletes an unmarked account, even by stored id', async () => {
    const { mirror, keycloak, users } = setup({
      stored: account({ attributes: null }),
    });

    await mirror.apply(user({ status: 'deleted' }));

    expect(keycloak.deleteUser).not.toHaveBeenCalled();
    expect(users.setKeycloakUserId).toHaveBeenCalledWith(
      IDS.alphaViewer,
      null,
      undefined,
    );
  });

  it('never deletes an account adopted by another row', async () => {
    const { mirror, keycloak, users } = setup({
      stored: account({ attributes: { mtco_user_id: [IDS.betaAdmin] } }),
    });

    await mirror.apply(user({ status: 'deleted' }));

    expect(keycloak.deleteUser).not.toHaveBeenCalled();
    expect(users.setKeycloakUserId).toHaveBeenCalledWith(
      IDS.alphaViewer,
      null,
      undefined,
    );
  });
});
