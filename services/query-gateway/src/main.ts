import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';

import { AppModule } from './app.module';
import { gatewayMetrics } from './metrics/gateway-metrics';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });

  // First: times every request, including those rejected by auth.
  app.use(gatewayMetrics.middleware());

  app.use(
    raw({
      type: ['application/x-ndjson', 'application/ndjson'],
      limit: '5mb',
    }),
  );

  app.use(
    json({
      limit: '2mb',
    }),
  );

  app.use(
    urlencoded({
      extended: true,
      limit: '2mb',
    }),
  );

  await app.listen(process.env.PORT ?? 8080, '0.0.0.0');
}

bootstrap();
