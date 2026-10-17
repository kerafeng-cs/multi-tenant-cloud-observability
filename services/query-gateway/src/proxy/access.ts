import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from '../auth/auth-user';

const OBSERVABILITY_ROLES = ['platform-admin', 'tenant-admin', 'viewer'];

export interface QueryAccess {
  platformAdmin: boolean;

  /** Tenant key (Keycloak group name). null only for platform-admin. */
  tenantId: string | null;
}

/**
 * Resolves who the caller is for query purposes.
 *
 * - platform-admin: unrestricted (tenantId = null)
 * - tenant-admin / viewer: bound to exactly one tenant group
 * - anyone else: rejected
 */
export function resolveQueryAccess(user: AuthUser): QueryAccess {
  if (!user.roles.some((role) => OBSERVABILITY_ROLES.includes(role))) {
    throw new ForbiddenException('User has no observability role');
  }

  if (user.roles.includes('platform-admin')) {
    return {
      platformAdmin: true,
      tenantId: null,
    };
  }

  const groups = user.groups
    .map((group) => group.replace(/^\/+/, ''))
    .filter(Boolean);

  if (groups.length !== 1) {
    throw new ForbiddenException(
      'User must belong to exactly one tenant group',
    );
  }

  return {
    platformAdmin: false,
    tenantId: groups[0],
  };
}

/** Set by control-plane on the datasources of each tenant org (TODO-19). */
export const SCOPE_TENANT_HEADER = 'x-mtco-scope-tenant';
export const SCOPE_ACCOUNT_HEADER = 'x-mtco-scope-account';

const TENANT_KEY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const VM_ACCOUNT = /^\d{1,10}$/;

export interface PlatformScope {
  tenantKey: string;
  vmAccountId: string;
}

/**
 * The tenant a PLATFORM ADMIN's request is narrowed to, or null (org 1:
 * every tenant). Only ever narrows: callers apply it to platform admins
 * only; tenant users stay bound to their token.
 *
 * Both headers or none. A partial or malformed scope fails closed (400)
 * instead of silently falling back to "every tenant".
 */
export function platformScope(
  headers: Request['headers'] | undefined,
): PlatformScope | null {
  const tenantKey = single(headers?.[SCOPE_TENANT_HEADER]);
  const vmAccountId = single(headers?.[SCOPE_ACCOUNT_HEADER]);

  if (tenantKey === undefined && vmAccountId === undefined) {
    return null;
  }

  if (
    tenantKey === undefined ||
    vmAccountId === undefined ||
    !TENANT_KEY.test(tenantKey) ||
    !VM_ACCOUNT.test(vmAccountId)
  ) {
    throw new BadRequestException(
      `Invalid tenant scope headers (${SCOPE_TENANT_HEADER}, ${SCOPE_ACCOUNT_HEADER})`,
    );
  }

  return { tenantKey, vmAccountId };
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0].trim() : '';
  }

  return value === undefined ? undefined : value.trim();
}
