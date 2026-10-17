import type { NextFunction, Request, Response } from 'express';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { Counter, Gauge, Histogram, Registry } from './registry';

/*
 * TODO-25 part B: request/response flow of the read path, for the
 * Platform health and Benchmark dashboards (scraped by vmagent at
 * GET /metrics). Same request histogram name and labels as control-plane
 * (http_server_request_duration_seconds{method,route,status_code}).
 */

const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

export type Backend = 'victoriametrics' | 'opensearch';

/** Low-cardinality route of a request ("<backend>:<endpoint>"). */
export function routeOf(originalUrl: string): string {
  const path = originalUrl.split('?', 1)[0];

  if (path.startsWith('/query/victoriametrics/')) {
    const rest = path.slice('/query/victoriametrics'.length);
    const match =
      /^\/api\/v1\/(query_range|query_exemplars|query|series|labels|metadata)$/.exec(
        rest,
      );

    if (match) {
      return `victoriametrics:${match[1]}`;
    }

    if (/^\/api\/v1\/label\/[^/]+\/values$/.test(rest)) {
      return 'victoriametrics:label_values';
    }

    return 'victoriametrics:other';
  }

  if (path.startsWith('/query/opensearch/')) {
    const rest = path.slice('/query/opensearch'.length);

    for (const endpoint of ['_msearch', '_search', '_mapping', '_field_caps']) {
      if (rest.endsWith(`/${endpoint}`) || rest.includes(`/${endpoint}/`)) {
        return `opensearch:${endpoint.slice(1)}`;
      }
    }

    return 'opensearch:other';
  }

  return 'other';
}

function backendOfRoute(route: string): string {
  const separator = route.indexOf(':');

  return separator > 0 ? route.slice(0, separator) : 'none';
}

export class GatewayMetrics {
  readonly registry = new Registry();

  readonly requestDuration = this.registry.register(
    new Histogram(
      'http_server_request_duration_seconds',
      'Requests handled by query-gateway, from arrival to the last byte sent.',
      ['method', 'route', 'status_code'] as const,
      LATENCY_BUCKETS,
    ),
  );

  readonly inFlight = this.registry.register(
    new Gauge(
      'query_gateway_requests_in_flight',
      'Requests being handled right now.',
      ['backend'] as const,
    ),
  );

  readonly requestBytes = this.registry.register(
    new Counter(
      'query_gateway_request_bytes_total',
      'Request body bytes received from clients (Content-Length).',
      ['backend'] as const,
    ),
  );

  readonly responseBytes = this.registry.register(
    new Counter(
      'query_gateway_response_bytes_total',
      'Response body bytes streamed from the backend to the client.',
      ['backend'] as const,
    ),
  );

  readonly upstreamDuration = this.registry.register(
    new Histogram(
      'query_gateway_upstream_duration_seconds',
      'Time until the storage backend answered (response headers).',
      ['backend', 'outcome'] as const,
      LATENCY_BUCKETS,
    ),
  );

  readonly upstreamErrors = this.registry.register(
    new Counter(
      'query_gateway_upstream_errors_total',
      'Backend requests that failed without an HTTP answer.',
      ['backend', 'reason'] as const,
    ),
  );

  /*
   * The histogram records how late each sampling timer fired, INCLUDING
   * the sampling interval itself, so an idle process reports ~20 ms.
   * The resolution is subtracted to expose the real extra delay.
   */
  private static readonly LOOP_RESOLUTION_MS = 20;

  private readonly loopDelay = monitorEventLoopDelay({
    resolution: GatewayMetrics.LOOP_RESOLUTION_MS,
  });

  private readonly startTime = Date.now() / 1000;

  constructor() {
    this.loopDelay.enable();

    this.registry.register(
      new Gauge(
        'nodejs_eventloop_lag_seconds',
        'Event loop delay since the previous scrape.',
        ['quantile'] as const,
        (gauge) => {
          for (const [quantile, percentile] of [
            ['0.5', 50],
            ['0.99', 99],
            ['1', 100],
          ] as const) {
            gauge.set(
              { quantile },
              this.loopDelay.count > 0
                ? Math.max(
                    0,
                    this.loopDelay.percentile(percentile) / 1e9 -
                      GatewayMetrics.LOOP_RESOLUTION_MS / 1000,
                  )
                : 0,
            );
          }

          this.loopDelay.reset();
        },
      ),
    );

    this.registry.register(
      new Gauge(
        'process_cpu_seconds_total',
        'User + system CPU time of the process.',
        [] as const,
        (gauge) => {
          const usage = process.cpuUsage();

          gauge.set({}, (usage.user + usage.system) / 1e6);
        },
      ),
    );

    this.registry.register(
      new Gauge(
        'process_resident_memory_bytes',
        'Resident memory of the process.',
        [] as const,
        (gauge) => gauge.set({}, process.memoryUsage().rss),
      ),
    );

    this.registry.register(
      new Gauge(
        'nodejs_heap_used_bytes',
        'V8 heap in use.',
        [] as const,
        (gauge) => gauge.set({}, process.memoryUsage().heapUsed),
      ),
    );

    this.registry.register(
      new Gauge(
        'process_start_time_seconds',
        'Start time of the process (Unix seconds).',
        [] as const,
        (gauge) => gauge.set({}, this.startTime),
      ),
    );
  }

  /**
   * Express middleware: records every request except /metrics and
   * /health, including the ones rejected by authentication (401/403).
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const path = req.originalUrl.split('?', 1)[0];

      if (path === '/metrics' || path === '/health') {
        next();
        return;
      }

      const route = routeOf(req.originalUrl);
      const backend = backendOfRoute(route);
      const started = process.hrtime.bigint();
      let done = false;

      this.inFlight.inc({ backend });
      this.requestBytes.inc(
        { backend },
        Number(req.headers['content-length']) || 0,
      );

      const finish = (): void => {
        if (done) {
          return;
        }

        done = true;
        this.inFlight.dec({ backend });
        this.requestDuration.observe(
          {
            method: req.method,
            route,
            // Client went away before the response was complete.
            status_code: res.writableFinished ? String(res.statusCode) : '499',
          },
          Number(process.hrtime.bigint() - started) / 1e9,
        );
      };

      res.on('finish', finish);
      res.on('close', finish);
      next();
    };
  }
}

/** One registry per process. */
export const gatewayMetrics = new GatewayMetrics();
