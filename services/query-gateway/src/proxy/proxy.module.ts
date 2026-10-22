import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { StoresModule } from '../stores/stores.module';
import { TenantModule } from '../tenant/tenant.module';

import { HttpProxyService } from './http-proxy.service';
import { OpenSearchTenantService } from './opensearch-tenant.service';
import { VictoriaMetricsController } from './victoriametrics.controller';
import { OpenSearchController } from './opensearch.controller';

@Module({
  imports: [HttpModule, TenantModule, StoresModule],

  controllers: [VictoriaMetricsController, OpenSearchController],

  providers: [HttpProxyService, OpenSearchTenantService],
})
export class ProxyModule {}
