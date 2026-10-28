import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';

import type { Request, Response } from 'express';

import type { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DataStoreRegistry, resolveStore } from '../stores/data-stores';

import { platformScope, resolveQueryAccess } from './access';
import { HttpProxyService } from './http-proxy.service';
import {
  IMPERSONATE_HEADER,
  OpenSearchTenantService,
  tenantPrincipal,
} from './opensearch-tenant.service';
import { resolveDownstreamPath } from './safe-path';

type AuthenticatedRequest = Request & {
  user: AuthUser;
};

@UseGuards(JwtAuthGuard)
@Controller('query/opensearch')
export class OpenSearchController {
  constructor(
    private readonly proxy: HttpProxyService,
    private readonly stores: DataStoreRegistry,
    private readonly tenant: OpenSearchTenantService,
  ) {}

  @All('*path')
  async proxyRequest(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const access = resolveQueryAccess(req.user);

    // TODO-28: the OpenSearch cluster (and its read account) that holds
    // this tenant's logs.
    const store = this.stores.logs(
      resolveStore(req.user.logsStores, access.platformAdmin, req.headers),
    );

    const baseUrl = store.queryUrl;

    /*
     * Reject "." / ".." segments before any path-based decision is made,
     * so the checks in enforce() see the same path OpenSearch will see.
     */
    const clientPath = req.originalUrl.replace('/query/opensearch', '');

    const targetPath = resolveDownstreamPath(baseUrl, clientPath, '/');

    // Platform admin: every tenant in org 1, narrowed to the tenant of a
    // tenant org's datasource (TODO-19). Tenant users: their token's tenant.
    const tenantId = access.platformAdmin
      ? (platformScope(req.headers)?.tenantKey ?? null)
      : access.tenantId;

    this.tenant.enforce(req, tenantId, access.platformAdmin);

    const authorization = `Basic ${Buffer.from(
      `${store.username}:${store.password}`,
    ).toString('base64')}`;

    // TODO-15: anything scoped to a tenant (tenant user, or platform admin
    // in a tenant org) runs in OpenSearch AS that tenant: only its own
    // data stream, enforced by OpenSearch itself on top of the filter
    // above. Only an unscoped platform admin (org 1) reads as the gateway.
    if (tenantId === null) {
      await this.proxy.forward(
        baseUrl,
        '/query/opensearch',
        req,
        res,
        { authorization },
        targetPath,
      );
      return;
    }

    const scopedPath = resolveDownstreamPath(
      baseUrl,
      this.tenant.tenantPath(clientPath, tenantId),
      '/',
    );

    await this.proxy.forward(
      baseUrl,
      '/query/opensearch',
      req,
      res,
      {
        authorization,
        [IMPERSONATE_HEADER]: tenantPrincipal(tenantId),
      },
      scopedPath,
    );
  }
}
