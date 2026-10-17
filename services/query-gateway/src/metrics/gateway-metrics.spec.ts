import express from 'express';
import request from 'supertest';

import { GatewayMetrics, routeOf } from './gateway-metrics';
import { Counter, Gauge, Histogram, Registry } from './registry';

describe('registry (Prometheus text format)', () => {
  it('renders counters, gauges and cumulative histogram buckets', () => {
    const registry = new Registry();
    const counter = registry.register(
      new Counter('c_total', 'a counter', ['backend'] as const),
    );
    const gauge = registry.register(new Gauge('g', 'a gauge', [] as const));
    const histogram = registry.register(
      new Histogram('h_seconds', 'a histogram', ['route'] as const, [0.1, 1]),
    );

    counter.inc({ backend: 'vm' }, 2);
    counter.inc({ backend: 'vm' });
    gauge.set({}, 7);
    histogram.observe({ route: 'q' }, 0.05);
    histogram.observe({ route: 'q' }, 0.5);
    histogram.observe({ route: 'q' }, 3);

    const text = registry.render();

    expect(text).toContain('# TYPE c_total counter');
    expect(text).toContain('c_total{backend="vm"} 3');
    expect(text).toContain('g 7');
    expect(text).toContain('h_seconds_bucket{route="q",le="0.1"} 1');
    expect(text).toContain('h_seconds_bucket{route="q",le="1"} 2');
    expect(text).toContain('h_seconds_bucket{route="q",le="+Inf"} 3');
    expect(text).toContain('h_seconds_sum{route="q"} 3.55');
    expect(text).toContain('h_seconds_count{route="q"} 3');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values', () => {
    const registry = new Registry();
    const counter = registry.register(
      new Counter('x_total', 'x', ['v'] as const),
    );

    counter.inc({ v: 'a"b\\c\nd' });

    expect(registry.render()).toContain('x_total{v="a\\"b\\\\c\\nd"} 1');
  });
});

describe('routeOf (low-cardinality route labels)', () => {
  it.each([
    ['/query/victoriametrics/api/v1/query?query=up', 'victoriametrics:query'],
    [
      '/query/victoriametrics/api/v1/query_range',
      'victoriametrics:query_range',
    ],
    ['/query/victoriametrics/api/v1/series', 'victoriametrics:series'],
    ['/query/victoriametrics/api/v1/labels', 'victoriametrics:labels'],
    [
      '/query/victoriametrics/api/v1/label/host_name/values',
      'victoriametrics:label_values',
    ],
    ['/query/victoriametrics/api/v1/status/buildinfo', 'victoriametrics:other'],
    ['/query/opensearch/_msearch?max_concurrent=5', 'opensearch:msearch'],
    ['/query/opensearch/otel-logs*/_search', 'opensearch:search'],
    ['/query/opensearch/otel-logs*/_mapping', 'opensearch:mapping'],
    ['/query/opensearch/', 'opensearch:other'],
    ['/whatever/alpha-tenant', 'other'],
  ])('%s -> %s', (url, route) => {
    expect(routeOf(url)).toBe(route);
  });
});

describe('request middleware', () => {
  function app(metrics: GatewayMetrics) {
    const server = express();

    server.use(metrics.middleware());
    server.get('/query/victoriametrics/api/v1/query', (_req, res) => {
      res.json({ status: 'success' });
    });
    server.get('/query/opensearch/_msearch', (_req, res) => {
      res.status(401).end();
    });
    server.get('/metrics', (_req, res) => {
      res.type('text/plain').send(metrics.registry.render());
    });

    return server;
  }

  it('records method, route and status, and skips /metrics', async () => {
    const metrics = new GatewayMetrics();
    const server = app(metrics);

    await request(server).get('/query/victoriametrics/api/v1/query?query=up');
    await request(server).get('/query/opensearch/_msearch');

    const res = await request(server).get('/metrics').expect(200);

    expect(res.text).toMatch(
      /http_server_request_duration_seconds_count\{method="GET",route="victoriametrics:query",status_code="200"\} 1/,
    );
    expect(res.text).toMatch(
      /http_server_request_duration_seconds_count\{method="GET",route="opensearch:msearch",status_code="401"\} 1/,
    );
    expect(res.text).toContain(
      'query_gateway_requests_in_flight{backend="victoriametrics"} 0',
    );
    expect(res.text).not.toMatch(/route="other"/);
    expect(res.text).toMatch(/nodejs_eventloop_lag_seconds\{quantile="0.99"\}/);
    expect(res.text).toMatch(/process_resident_memory_bytes \d+/);
  });
});
