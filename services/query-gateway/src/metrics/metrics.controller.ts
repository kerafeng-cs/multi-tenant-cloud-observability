import { Controller, Get, Header } from '@nestjs/common';

import { gatewayMetrics } from './gateway-metrics';

/**
 * Prometheus scrape endpoint (TODO-25). No authentication: the Service is
 * reachable only from the observability namespace (NetworkPolicy
 * internal-only) and nothing tenant-specific is exposed.
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return gatewayMetrics.registry.render();
  }
}
