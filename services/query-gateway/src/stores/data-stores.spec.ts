import { DataStoreRegistry, parseDataStores } from './data-stores';

const env =
  (values: Record<string, string>) =>
  (key: string): string | undefined =>
    values[key];

describe('parseDataStores (TODO-28)', () => {
  it('no DATA_STORES_JSON: one shared store from the pre-TODO-28 variables', () => {
    expect(
      parseDataStores(
        env({
          VICTORIAMETRICS_URL: 'http://vmselect:8481',
          OPENSEARCH_URL: 'https://opensearch:9200',
          OPENSEARCH_USERNAME: 'reader',
          OPENSEARCH_PASSWORD: 'pw',
        }),
      ),
    ).toEqual({
      metrics: { shared: { name: 'shared', queryUrl: 'http://vmselect:8481' } },
      logs: {
        shared: {
          name: 'shared',
          queryUrl: 'https://opensearch:9200',
          username: 'reader',
          password: 'pw',
        },
      },
    });
  });

  it('reads the catalog; each OpenSearch store has its own read account', () => {
    const catalog = parseDataStores(
      env({
        DATA_STORES_JSON: JSON.stringify({
          metrics: {
            shared: { queryUrl: 'http://vmselect:8481/', exclusive: false },
            'dedicated-1': { queryUrl: 'http://vmselect-dedicated-1:8481' },
          },
          logs: {
            shared: {
              queryUrl: 'https://opensearch:9200',
              credentials: 'OPENSEARCH',
            },
            'dedicated-1': {
              queryUrl: 'https://opensearch-dedicated-1:9200',
              credentials: 'OPENSEARCH_DEDICATED_1',
              exclusive: true,
            },
          },
        }),
        OPENSEARCH_USERNAME: 'reader',
        OPENSEARCH_PASSWORD: 'pw',
        OPENSEARCH_DEDICATED_1_USERNAME: 'reader-d1',
        OPENSEARCH_DEDICATED_1_PASSWORD: 'pw-d1',
      }),
    );

    expect(catalog.metrics.shared.queryUrl).toBe('http://vmselect:8481');
    expect(catalog.logs['dedicated-1']).toEqual({
      name: 'dedicated-1',
      queryUrl: 'https://opensearch-dedicated-1:9200',
      username: 'reader-d1',
      password: 'pw-d1',
    });
  });

  it('fails fast and lists every problem', () => {
    expect(() =>
      parseDataStores(
        env({
          DATA_STORES_JSON: JSON.stringify({
            metrics: { other: { queryUrl: 'vmselect:8481' } },
            logs: {
              shared: { queryUrl: 'https://os:9200', credentials: 'NOPE' },
            },
          }),
        }),
      ),
    ).toThrow(
      [
        'Invalid data stores:',
        '  - DATA_STORES_JSON.metrics.other.queryUrl must be an http(s) URL',
        '  - DATA_STORES_JSON.metrics must contain the "shared" store',
        '  - DATA_STORES_JSON.logs.shared: env NOPE_USERNAME and NOPE_PASSWORD are required',
      ].join('\n'),
    );

    expect(() => parseDataStores(env({ DATA_STORES_JSON: '{' }))).toThrow(
      'DATA_STORES_JSON is not valid JSON',
    );
  });

  it('the registry answers 503 for a store it does not have', () => {
    const registry = new DataStoreRegistry({ metrics: {}, logs: {} });

    expect(() => registry.metrics('shared')).toThrow(
      'The metrics store "shared" is not configured on this gateway',
    );
  });
});
