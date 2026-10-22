import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { DataStoreRegistry } from '../stores/data-stores';

import type { HttpProxyService } from './http-proxy.service';
import { OpenSearchController } from './opensearch.controller';
import { OpenSearchTenantService } from './opensearch-tenant.service';

// ESM-only packages (see victoriametrics.controller.spec.ts).
jest.mock('./http-proxy.service', () => ({ HttpProxyService: class {} }));
jest.mock('../auth/jwt-auth.guard', () => ({ JwtAuthGuard: class {} }));

type AuthenticatedRequest = Request & { user: AuthUser };

const viewer: AuthUser = {
  sub: 'u1',
  username: 'viewer-a',
  roles: ['viewer'],
  groups: ['tenant-a'],
  vmAccountIds: ['2'],
  metricsStores: ['shared'],
  logsStores: ['shared'],
};

function setup() {
  const forward = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);

  const stores = new DataStoreRegistry({
    metrics: {},
    logs: {
      shared: {
        name: 'shared',
        queryUrl: 'https://opensearch:9200',
        username: 'reader',
        password: 'pw',
      },
      'dedicated-1': {
        name: 'dedicated-1',
        queryUrl: 'https://opensearch-dedicated-1:9200',
        username: 'reader-d1',
        password: 'pw-d1',
      },
    },
  });

  const controller = new OpenSearchController(
    { forward } as unknown as HttpProxyService,
    stores,
    new OpenSearchTenantService(),
  );

  const search = (user: AuthUser, headers: Record<string, string> = {}) =>
    controller.proxyRequest(
      {
        method: 'POST',
        originalUrl: '/query/opensearch/otel-logs*/_search',
        url: '/query/opensearch/otel-logs*/_search',
        user,
        headers,
        query: {},
        body: { query: { match_all: {} } },
      } as unknown as AuthenticatedRequest,
      {} as Response,
    );

  const sent = () => ({
    baseUrl: forward.mock.calls[0][0] as string,
    authorization: (forward.mock.calls[0][4] as { authorization: string })
      .authorization,
  });

  return { search, sent };
}

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('OpenSearchController data stores (TODO-28)', () => {
  it('a tenant user reads its own store with that store read account', async () => {
    const { search, sent } = setup();

    await search({ ...viewer, logsStores: ['dedicated-1'] });

    expect(sent()).toEqual({
      baseUrl: 'https://opensearch-dedicated-1:9200',
      authorization: basic('reader-d1', 'pw-d1'),
    });
  });

  it('shared store and account by default; the scope header is ignored for tenant users', async () => {
    const { search, sent } = setup();

    await search(
      { ...viewer, logsStores: [] },
      { 'x-mtco-scope-store': 'dedicated-1' },
    );

    expect(sent()).toEqual({
      baseUrl: 'https://opensearch:9200',
      authorization: basic('reader', 'pw'),
    });
  });
});
