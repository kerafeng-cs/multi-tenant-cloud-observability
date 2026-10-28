import { MetricsService } from '../../common/metrics/metrics.service';
import { AppConfig } from '../../config/app-config';
import { defaultDataStores } from '../../config/data-stores';

import {
  OpenSearchSecurityClients,
  tenantPrincipal,
  tenantRole,
} from './opensearch-security.client';

type Route = () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  key: string;
  origin: string;
  authorization: string | undefined;
  body: unknown;
}

function setup(
  routes: Record<string, Route>,
  config: AppConfig = AppConfig.forTest(),
) {
  const calls: Call[] = [];

  global.fetch = jest.fn((url: URL, init: RequestInit) => {
    const parsed = new URL(String(url));
    const key = `${String(init.method)} ${parsed.pathname}`;
    const headers = init.headers as Record<string, string>;

    calls.push({
      key,
      origin: parsed.origin,
      authorization: headers.Authorization,
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });

    const route = routes[key];

    return Promise.resolve(route ? route() : json({ status: 'OK' }));
  });

  return {
    clients: new OpenSearchSecurityClients(config, new MetricsService()),
    calls,
  };
}

const API = '/_plugins/_security/api';

describe('tenantRole', () => {
  it('reads only the tenant data stream and its exact backing indices', () => {
    const role = tenantRole('alpha') as {
      index_permissions: { index_patterns: string[] }[];
    };

    const [pattern, backing] = role.index_permissions[0].index_patterns;
    const regex = new RegExp(`^${backing.slice(1, -1)}$`);

    expect(pattern).toBe('otel-logs-alpha');
    expect(regex.test('.ds-otel-logs-alpha-000001')).toBe(true);
    // Another tenant whose key starts with "alpha-" must not match.
    expect(regex.test('.ds-otel-logs-alpha-x-000001')).toBe(false);
    expect(regex.test('.ds-otel-logs-alphax-000001')).toBe(false);
    expect(regex.test('otel-logs')).toBe(false);
  });

  it('names role and user after the tenant', () => {
    expect(tenantPrincipal('beta')).toBe('mtco-tenant-beta');
  });
});

describe('OpenSearchSecurityClient', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('creates role, a new user and the mapping, in the store of the tenant', async () => {
    const { clients, calls } = setup({
      [`GET ${API}/internalusers/mtco-tenant-alpha`]: () =>
        json({ status: 'NOT_FOUND' }, 404),
    });

    await clients.forStore('shared').ensureTenantReader('alpha');

    expect(calls.map((c) => c.key)).toEqual([
      `PUT ${API}/roles/mtco-tenant-alpha`,
      `GET ${API}/internalusers/mtco-tenant-alpha`,
      `PUT ${API}/internalusers/mtco-tenant-alpha`,
      `PUT ${API}/rolesmapping/mtco-tenant-alpha`,
    ]);
    expect(new Set(calls.map((c) => c.origin))).toEqual(
      new Set(['https://opensearch:9200']),
    );
    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from('mtco-security:pw').toString('base64')}`,
    );
    expect(calls[3].body).toEqual({ users: ['mtco-tenant-alpha'] });

    const password = (calls[2].body as { password: string }).password;
    expect(password.length).toBeGreaterThanOrEqual(40);
  });

  it('keeps an existing user (no password churn)', async () => {
    const { clients, calls } = setup({
      [`GET ${API}/internalusers/mtco-tenant-alpha`]: () =>
        json({ 'mtco-tenant-alpha': {} }),
    });

    await clients.forStore('shared').ensureTenantReader('alpha');

    expect(calls.map((c) => c.key)).not.toContain(
      `PUT ${API}/internalusers/mtco-tenant-alpha`,
    );
  });

  it('removes mapping, user and role; 404 is fine', async () => {
    const { clients, calls } = setup({
      [`DELETE ${API}/internalusers/mtco-tenant-alpha`]: () =>
        json({ status: 'NOT_FOUND' }, 404),
    });

    await clients.forStore('shared').removeTenantReader('alpha');

    expect(calls.map((c) => c.key)).toEqual([
      `DELETE ${API}/rolesmapping/mtco-tenant-alpha`,
      `DELETE ${API}/internalusers/mtco-tenant-alpha`,
      `DELETE ${API}/roles/mtco-tenant-alpha`,
    ]);
  });

  it('uses the URL of the store from the catalog', async () => {
    const catalog = defaultDataStores();
    catalog.logs['dedicated-1'] = {
      name: 'dedicated-1',
      kind: 'logs',
      exclusive: true,
      url: 'https://opensearch-dedicated-1:9200',
    };
    const { clients, calls } = setup(
      {},
      AppConfig.forTest({ dataStores: catalog }),
    );

    await clients.forStore('dedicated-1').removeTenantReader('gamma');

    expect(calls[0].origin).toBe('https://opensearch-dedicated-1:9200');
  });

  it('fails for a store missing from the catalog', () => {
    const { clients } = setup({});

    expect(() => clients.forStore('nope')).toThrow(/not in DATA_STORES_JSON/);
  });

  it('fails while the security account is not configured', async () => {
    const { clients, calls } = setup(
      {},
      AppConfig.forTest({ opensearchSecurity: { username: '', password: '' } }),
    );

    await expect(
      clients.forStore('shared').ensureTenantReader('alpha'),
    ).rejects.toThrow(/OPENSEARCH_SECURITY_USERNAME/);
    expect(calls).toEqual([]);
  });

  it('rejects a key that is not a tenant key', async () => {
    const { clients } = setup({});

    await expect(
      clients.forStore('shared').ensureTenantReader('../admin'),
    ).rejects.toThrow(/Invalid tenant key/);
  });

  it('a refused call is an error (the outbox retries it)', async () => {
    const { clients } = setup({
      [`PUT ${API}/roles/mtco-tenant-alpha`]: () =>
        json({ status: 'FORBIDDEN' }, 403),
    });

    await expect(
      clients.forStore('shared').ensureTenantReader('alpha'),
    ).rejects.toThrow(/403/);
  });
});
