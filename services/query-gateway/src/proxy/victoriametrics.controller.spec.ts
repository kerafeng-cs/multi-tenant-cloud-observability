import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { DataStoreRegistry } from '../stores/data-stores';

import type { HttpProxyService } from './http-proxy.service';
import { VictoriaMetricsController } from './victoriametrics.controller';

/*
 * @nestjs/config, @nestjs/axios and @nestjs/passport ship as ESM-only packages that Jest
 * (CommonJS) cannot load. The controller only needs them as DI tokens here.
 */
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('./http-proxy.service', () => ({ HttpProxyService: class {} }));
jest.mock('../auth/jwt-auth.guard', () => ({ JwtAuthGuard: class {} }));

type AuthenticatedRequest = Request & { user: AuthUser };

const viewer: AuthUser = {
  sub: 'u1',
  username: 'viewer-a',
  roles: ['viewer'],
  groups: ['tenant-a'],
  vmAccountIds: ['2'],
  metricsStores: [],
  logsStores: [],
};

const platformAdmin: AuthUser = {
  sub: 'u0',
  username: 'root',
  roles: ['platform-admin'],
  groups: ['admin-tenant'],
  vmAccountIds: ['1'],
  metricsStores: ['shared'],
  logsStores: ['shared'],
};

function setup() {
  const forward = jest
    .fn<Promise<void>, unknown[]>()
    .mockResolvedValue(undefined);

  const proxy = { forward } as unknown as HttpProxyService;

  const stores = new DataStoreRegistry({
    metrics: {
      shared: { name: 'shared', queryUrl: 'http://vmselect:8481' },
      'dedicated-1': {
        name: 'dedicated-1',
        queryUrl: 'http://vmselect-dedicated-1:8481',
      },
    },
    logs: {},
  });

  const controller = new VictoriaMetricsController(proxy, stores);

  const call = (
    user: AuthUser,
    path: string,
    method = 'GET',
    headers: Record<string, string> = {},
  ) =>
    controller.proxyRequest(
      {
        method,
        originalUrl: `/query/victoriametrics${path}`,
        user,
        headers,
      } as unknown as AuthenticatedRequest,
      {} as Response,
    );

  const targetPath = (): string => forward.mock.calls[0][5] as string;
  const baseUrl = (): string => forward.mock.calls[0][0] as string;

  return { call, forward, targetPath, baseUrl };
}

describe('VictoriaMetricsController', () => {
  it('routes a tenant user to its own account', async () => {
    const { call, targetPath } = setup();

    await call(viewer, '/api/v1/query?query=up');

    expect(targetPath()).toBe('/select/2/prometheus/api/v1/query?query=up');
  });

  it('routes platform-admin to the multitenant endpoint', async () => {
    const { call, targetPath } = setup();

    await call(platformAdmin, '/api/v1/query_range?query=up');

    expect(targetPath()).toBe(
      '/select/multitenant/prometheus/api/v1/query_range?query=up',
    );
  });

  describe('tenant scope of a tenant org datasource (TODO-19)', () => {
    const scope = {
      'x-mtco-scope-tenant': 'tenant-b',
      'x-mtco-scope-account': '7',
    };

    it('narrows a platform admin to the scoped account', async () => {
      const { call, targetPath } = setup();

      await call(platformAdmin, '/api/v1/query?query=up', 'GET', scope);

      expect(targetPath()).toBe('/select/7/prometheus/api/v1/query?query=up');
    });

    it('never widens a tenant user: the scope is ignored', async () => {
      const { call, targetPath } = setup();

      await call(viewer, '/api/v1/query?query=up', 'GET', scope);

      expect(targetPath()).toBe('/select/2/prometheus/api/v1/query?query=up');
    });

    it.each([
      [{ 'x-mtco-scope-tenant': 'tenant-b' }],
      [{ 'x-mtco-scope-account': '7' }],
      [{ 'x-mtco-scope-tenant': 'tenant-b', 'x-mtco-scope-account': '7/../1' }],
      [{ 'x-mtco-scope-tenant': 'Tenant B', 'x-mtco-scope-account': '7' }],
    ])('fails closed on a partial or malformed scope: %j', async (headers) => {
      const { call, forward } = setup();

      await expect(
        call(platformAdmin, '/api/v1/query?query=up', 'GET', headers),
      ).rejects.toThrow(BadRequestException);
      expect(forward).not.toHaveBeenCalled();
    });
  });

  describe('data stores (TODO-28)', () => {
    it('a tenant user without a store claim reads the shared store', async () => {
      const { call, baseUrl } = setup();

      await call(viewer, '/api/v1/query?query=up');

      expect(baseUrl()).toBe('http://vmselect:8481');
    });

    it('a tenant user reads the store of its claim; headers cannot move it', async () => {
      const { call, baseUrl, targetPath } = setup();

      await call(
        { ...viewer, metricsStores: ['dedicated-1'] },
        '/api/v1/query?query=up',
        'GET',
        { 'x-mtco-scope-store': 'shared' },
      );

      expect(baseUrl()).toBe('http://vmselect-dedicated-1:8481');
      expect(targetPath()).toBe('/select/2/prometheus/api/v1/query?query=up');
    });

    it('a platform admin follows the scope header of the tenant org datasource', async () => {
      const { call, baseUrl, targetPath } = setup();

      await call(platformAdmin, '/api/v1/query?query=up', 'GET', {
        'x-mtco-scope-tenant': 'tenant-b',
        'x-mtco-scope-account': '7',
        'x-mtco-scope-store': 'dedicated-1',
      });

      expect(baseUrl()).toBe('http://vmselect-dedicated-1:8481');
      expect(targetPath()).toBe('/select/7/prometheus/api/v1/query?query=up');
    });

    it('a platform admin without a store header (org 1) reads the shared store', async () => {
      const { call, baseUrl } = setup();

      await call(platformAdmin, '/api/v1/query?query=up');

      expect(baseUrl()).toBe('http://vmselect:8481');
    });

    it('a store this gateway does not know → 503, nothing forwarded', async () => {
      const { call, forward } = setup();

      await expect(
        call({ ...viewer, metricsStores: ['dedicated-9'] }, '/api/v1/query'),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(forward).not.toHaveBeenCalled();
    });

    it('several or malformed store claims → 403; malformed header → 400', async () => {
      const { call, forward } = setup();

      await expect(
        call(
          { ...viewer, metricsStores: ['shared', 'dedicated-1'] },
          '/api/v1/query',
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        call({ ...viewer, metricsStores: ['../x'] }, '/api/v1/query'),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        call(platformAdmin, '/api/v1/query', 'GET', {
          'x-mtco-scope-store': 'Bad Store',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(forward).not.toHaveBeenCalled();
    });
  });

  it.each([
    '/api/v1/../../../../multitenant/prometheus/api/v1/query?query=up',
    '/api/v1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/multitenant/prometheus/api/v1/query',
    '/api/v1/../../../../1/prometheus/api/v1/query?query=up',
    '/api/v1/..%5c..%5c..%5c..%5cmultitenant/prometheus/api/v1/query',
  ])('blocks traversal to other tenants: %s', async (path) => {
    const { call, forward } = setup();

    await expect(call(viewer, path)).rejects.toThrow(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('blocks admin endpoints', async () => {
    const { call, forward } = setup();

    await expect(
      call(viewer, '/api/v1/admin/tsdb/delete_series?match[]=up'),
    ).rejects.toThrow(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('blocks non-read methods', async () => {
    const { call } = setup();

    await expect(call(viewer, '/api/v1/query', 'DELETE')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('blocks users without an observability role', async () => {
    const { call, forward } = setup();

    await expect(
      call({ ...viewer, roles: ['offline_access'] }, '/api/v1/query?query=up'),
    ).rejects.toThrow(ForbiddenException);
    expect(forward).not.toHaveBeenCalled();
  });

  it('blocks users in zero or several tenant groups', async () => {
    const { call } = setup();

    await expect(
      call({ ...viewer, groups: [] }, '/api/v1/query'),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      call({ ...viewer, groups: ['a', 'b'] }, '/api/v1/query'),
    ).rejects.toThrow(ForbiddenException);
  });
});
