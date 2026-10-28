import { tenant } from '../../common/testing/fixtures';
import type { OpenSearchSecurityClients } from '../../integrations/opensearch/opensearch-security.client';
import type {
  TenantRecord,
  TenantRepository,
} from '../../modules/tenants/tenant.repository';

import { OpenSearchTenantMirror } from './opensearch-tenant.mirror';

function setup(current: TenantRecord | null) {
  const client = {
    ensureTenantReader: jest.fn().mockResolvedValue(undefined),
    removeTenantReader: jest.fn().mockResolvedValue(undefined),
  };
  const clients = { forStore: jest.fn().mockReturnValue(client) };
  const tenants = { findById: jest.fn().mockResolvedValue(current) };

  const mirror = new OpenSearchTenantMirror(
    clients as unknown as OpenSearchSecurityClients,
    tenants as unknown as TenantRepository,
  );

  return { mirror, client, clients };
}

describe('OpenSearchTenantMirror', () => {
  it('active tenant: read access in its own logs store', async () => {
    const { mirror, client, clients } = setup(
      tenant({ logsStore: 'dedicated-1', tenantKey: 'gamma-tenant' }),
    );

    await mirror.sync('t1');

    expect(clients.forStore).toHaveBeenCalledWith('dedicated-1');
    expect(client.ensureTenantReader).toHaveBeenCalledWith('gamma-tenant');
    expect(client.removeTenantReader).not.toHaveBeenCalled();
  });

  it('deleted tenant: access removed', async () => {
    const { mirror, client } = setup(tenant({ status: 'deleted' }));

    await mirror.sync('t1');

    expect(client.removeTenantReader).toHaveBeenCalledWith('alpha-tenant');
    expect(client.ensureTenantReader).not.toHaveBeenCalled();
  });

  it('unknown tenant: nothing to do', async () => {
    const { mirror, clients } = setup(null);

    await mirror.sync('t1');

    expect(clients.forStore).not.toHaveBeenCalled();
  });
});
