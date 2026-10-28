import { Module } from '@nestjs/common';

import { OpenSearchSecurityClients } from './opensearch-security.client';

@Module({
  providers: [OpenSearchSecurityClients],
  exports: [OpenSearchSecurityClients],
})
export class OpenSearchModule {}
