import { Injectable } from '@nestjs/common';

import { OpenSearchSecurityClients } from '../../integrations/opensearch/opensearch-security.client';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import type { MirrorHandler } from '../../sync/mirror';

/**
 * Tenant → OpenSearch read access (TODO-15), in the tenant's logs store:
 * active  → role mtco-tenant-<key> (read otel-logs-<key> and its backing
 *           indices only), an internal user of the same name and the
 *           mapping between them;
 * deleted → the three are removed. The logs themselves stay (retention is
 *           the ISM policy's job).
 * query-gateway impersonates mtco-tenant-<key> for every request scoped to
 * the tenant, so OpenSearch itself refuses any other tenant's data even if
 * a gateway check were wrong. A tenant's logs store never changes (DB
 * trigger), so there is never an old store to clean up.
 */
@Injectable()
export class OpenSearchTenantMirror implements MirrorHandler {
  readonly target = 'opensearch' as const;
  readonly aggregate = 'tenant' as const;

  constructor(
    private readonly clients: OpenSearchSecurityClients,
    private readonly tenants: TenantRepository,
  ) {}

  async sync(tenantId: string): Promise<void> {
    const tenant = await this.tenants.findById(tenantId);

    if (!tenant) {
      return;
    }

    const client = this.clients.forStore(tenant.logsStore);

    if (tenant.status === 'active') {
      await client.ensureTenantReader(tenant.tenantKey);
    } else {
      await client.removeTenantReader(tenant.tenantKey);
    }
  }
}
