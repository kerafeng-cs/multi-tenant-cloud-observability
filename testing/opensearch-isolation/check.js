// TODO-15: storage-level tenant isolation check, run INSIDE a query-gateway
// pod (it has the OpenSearch read account and the CA in its environment):
//
//   kubectl -n observability exec -i deploy/query-gateway -- \
//     node - bench-tenant admin-tenant < testing/opensearch-isolation/check.js
//
// Talks to OpenSearch directly (no gateway, no tenant filter), AS the
// OpenSearch user of tenant A (impersonation), and tries to read tenant B.
// Expected: own stream 200, everything of B 403, the global aggregation
// only sees A. Prints statuses and counts, never credentials.
// `node - A B`: argv = [node, '-', A, B].
const [tenantA, tenantB] = process.argv.slice(2).filter((arg) => arg !== '-');

if (!tenantA || !tenantB) {
  console.error('usage: node - <tenant A> <tenant B>');
  process.exit(2);
}

const base = process.env.OPENSEARCH_URL;
const auth =
  'Basic ' +
  Buffer.from(
    `${process.env.OPENSEARCH_USERNAME}:${process.env.OPENSEARCH_PASSWORD}`,
  ).toString('base64');

async function check(label, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      opendistro_security_impersonate_as: `mtco-tenant-${tenantA}`,
    },
    body: JSON.stringify(body ?? { size: 0, track_total_hits: true }),
  });
  const json = await response.json().catch(() => ({}));
  const tenants = json.aggregations?.all?.tenants?.buckets
    ?.map((bucket) => bucket.key)
    .join(',');

  console.log(
    label.padEnd(36),
    response.status,
    tenants ?? json.hits?.total?.value ?? json.error?.type ?? '',
  );
}

(async () => {
  console.log(`as mtco-tenant-${tenantA}, against ${base}`);
  await check(`own stream otel-logs-${tenantA}`, `/otel-logs-${tenantA}/_search`);
  await check(`other stream otel-logs-${tenantB}`, `/otel-logs-${tenantB}/_search`);
  await check('wildcard otel-logs*', '/otel-logs*/_search');
  await check(
    `other backing index of ${tenantB}`,
    `/.ds-otel-logs-${tenantB}-000001/_search`,
  );
  await check('global aggregation, own stream', `/otel-logs-${tenantA}/_search`, {
    size: 0,
    aggs: {
      all: {
        global: {},
        aggs: { tenants: { terms: { field: 'resource.tenant.id.keyword' } } },
      },
    },
  });
})();
