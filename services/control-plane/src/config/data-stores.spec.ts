import { defaultDataStores, parseDataStores } from './data-stores';

describe('parseDataStores (TODO-28 catalog)', () => {
  it('no DATA_STORES_JSON → only the shared stores', () => {
    const problems: string[] = [];

    expect(parseDataStores(undefined, problems)).toEqual(defaultDataStores());
    expect(parseDataStores('  ', problems)).toEqual(defaultDataStores());
    expect(problems).toEqual([]);
  });

  it('reads names and exclusive; ignores the query-gateway fields', () => {
    const problems: string[] = [];

    const catalog = parseDataStores(
      JSON.stringify({
        metrics: {
          shared: { queryUrl: 'http://vmselect:8481' },
          'dedicated-1': { queryUrl: 'http://x:8481', exclusive: true },
        },
        logs: {
          shared: { queryUrl: 'https://opensearch:9200', credentials: 'OPENSEARCH' },
        },
      }),
      problems,
    );

    expect(problems).toEqual([]);
    expect(catalog).toEqual({
      metrics: {
        shared: { name: 'shared', kind: 'metrics', exclusive: false },
        'dedicated-1': { name: 'dedicated-1', kind: 'metrics', exclusive: true },
      },
      logs: { shared: { name: 'shared', kind: 'logs', exclusive: false } },
    });
  });

  it('lists every problem: bad JSON, missing kind, bad name, no shared, exclusive shared', () => {
    const bad: string[] = [];
    parseDataStores('{', bad);
    expect(bad).toEqual(['DATA_STORES_JSON is not valid JSON']);

    const problems: string[] = [];
    parseDataStores(
      JSON.stringify({
        metrics: {
          shared: { exclusive: true },
          Bad_Name: {},
          x: { exclusive: 'yes' },
        },
      }),
      problems,
    );

    expect(problems).toEqual([
      'DATA_STORES_JSON.metrics: invalid store name "Bad_Name" (1-40 lowercase letters, digits or hyphens)',
      'DATA_STORES_JSON.metrics.x.exclusive must be true or false',
      'DATA_STORES_JSON.metrics.shared cannot be exclusive (every tenant may use it)',
      'DATA_STORES_JSON.logs must be an object of stores',
    ]);
  });
});
