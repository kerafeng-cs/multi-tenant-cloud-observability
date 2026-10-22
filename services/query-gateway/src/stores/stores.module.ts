import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DataStoreRegistry, parseDataStores } from './data-stores';

@Module({
  providers: [
    {
      provide: DataStoreRegistry,
      useFactory: (config: ConfigService) =>
        new DataStoreRegistry(
          parseDataStores((key) => config.get<string>(key)),
        ),
      inject: [ConfigService],
    },
  ],

  exports: [DataStoreRegistry],
})
export class StoresModule {}
