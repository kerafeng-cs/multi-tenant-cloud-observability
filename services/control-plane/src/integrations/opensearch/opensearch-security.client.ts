import { Injectable } from '@nestjs/common';

import { randomBytes } from 'node:crypto';

import { UpstreamClient } from '../../common/http/upstream-client';
import { MetricsService } from '../../common/metrics/metrics.service';
import { AppConfig } from '../../config/app-config';
import type { DataStore } from '../../config/data-stores';

/** Same rule as tenant keys (they become part of role and index names). */
const TENANT_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const API = '/_plugins/_security/api';

/**
 * Name of the OpenSearch role AND internal user of a tenant. query-gateway
 * impersonates this user for every request scoped to the tenant (the
 * OpenSearch setting plugins.security.authcz.rest_impersonation_user
 * allows its account to impersonate mtco-tenant-*).
 */
export function tenantPrincipal(tenantKey: string): string {
  return `mtco-tenant-${tenantKey}`;
}

/**
 * What a tenant may read: its own data stream otel-logs-<key> and that
 * stream's backing indices. The backing indices are matched with a REGEX
 * (/.../) and an exact 6-digit generation, never with a wildcard:
 * ".ds-otel-logs-alpha-*" would also match tenant "alpha-x".
 */
export function tenantRole(tenantKey: string): Record<string, unknown> {
  return {
    description: `MTCO tenant ${tenantKey}: read its own logs (managed by control-plane)`,
    cluster_permissions: ['cluster_composite_ops_ro'],
    index_permissions: [
      {
        index_patterns: [
          `otel-logs-${tenantKey}`,
          `/\\.ds-otel-logs-${tenantKey}-[0-9]{6}/`,
        ],
        allowed_actions: [
          'read',
          'indices:admin/mappings/get',
          'indices:admin/resolve/index',
        ],
      },
    ],
  };
}

function assertTenantKey(tenantKey: string): void {
  if (!TENANT_KEY_RE.test(tenantKey)) {
    throw new Error(`Invalid tenant key for an OpenSearch role: ${tenantKey}`);
  }
}

/**
 * OpenSearch security REST API of ONE logs store, as the account of
 * OPENSEARCH_SECURITY_USERNAME (mapped to security_rest_api_access, created by the
 * OpenSearch bootstrap Job). Every method is idempotent.
 */
export class OpenSearchSecurityClient extends UpstreamClient {
  protected readonly service = 'opensearch' as const;

  constructor(
    config: AppConfig,
    metrics: MetricsService,
    private readonly store: DataStore,
  ) {
    super(config, metrics);
  }

  protected baseUrl(): string {
    if (!this.store.url) {
      throw new Error(`Logs store ${this.store.name} has no URL`);
    }

    return this.store.url;
  }

  protected authHeaders(): Promise<Record<string, string>> {
    const { username, password } = this.config.opensearchSecurity;

    if (!username || !password) {
      return Promise.reject(
        new Error(
          'OPENSEARCH_SECURITY_USERNAME / OPENSEARCH_SECURITY_PASSWORD are not set',
        ),
      );
    }

    return Promise.resolve({
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    });
  }

  /** Role + internal user + mapping, so the tenant can read its logs. */
  async ensureTenantReader(tenantKey: string): Promise<void> {
    assertTenantKey(tenantKey);
    const name = tenantPrincipal(tenantKey);

    await this.request({
      method: 'PUT',
      path: `${API}/roles/${name}`,
      body: tenantRole(tenantKey),
    });

    const user = await this.request({
      method: 'GET',
      path: `${API}/internalusers/${name}`,
      accept: [404],
    });

    if (user.status === 404) {
      // Only ever impersonated, never used to log in: a random password
      // nobody knows (required by the internal user database). The fixed
      // suffix satisfies a password policy that demands every character
      // class (upper, lower, digit, symbol).
      await this.request({
        method: 'PUT',
        path: `${API}/internalusers/${name}`,
        body: {
          password: `${randomBytes(32).toString('base64url')}Aa1!`,
          attributes: { managed_by: 'mtco-control-plane' },
        },
      });
    } else {
      await user.body?.cancel().catch(() => undefined);
    }

    await this.request({
      method: 'PUT',
      path: `${API}/rolesmapping/${name}`,
      body: { users: [name] },
    });
  }

  /** Removes mapping, user and role; missing pieces are fine. */
  async removeTenantReader(tenantKey: string): Promise<void> {
    assertTenantKey(tenantKey);
    const name = tenantPrincipal(tenantKey);

    for (const kind of ['rolesmapping', 'internalusers', 'roles']) {
      await this.request({
        method: 'DELETE',
        path: `${API}/${kind}/${name}`,
        accept: [404],
      });
    }
  }
}

/** One client per logs store of the catalog (DATA_STORES_JSON). */
@Injectable()
export class OpenSearchSecurityClients {
  private readonly clients = new Map<string, OpenSearchSecurityClient>();

  constructor(
    private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  /** Throws for a store that is not in the catalog (retried by the outbox). */
  forStore(storeName: string): OpenSearchSecurityClient {
    const existing = this.clients.get(storeName);

    if (existing) {
      return existing;
    }

    const store = this.config.dataStores.logs[storeName];

    if (!store) {
      throw new Error(`Logs store ${storeName} is not in DATA_STORES_JSON`);
    }

    const client = new OpenSearchSecurityClient(
      this.config,
      this.metrics,
      store,
    );
    this.clients.set(storeName, client);

    return client;
  }
}
