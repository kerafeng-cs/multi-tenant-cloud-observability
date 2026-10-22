/**
 * TODO-28: the data-store catalog (ConfigMap `data-stores`, key
 * stores.json, env DATA_STORES_JSON). A store is one VictoriaMetrics
 * cluster (kind `metrics`) or one OpenSearch cluster (kind `logs`).
 *
 * control-plane only needs the names and whether a store is exclusive
 * (1:1: at most one tenant that is not deleted); the URLs and credential
 * names in the same file are for query-gateway. The write path is wired
 * in the otel-gateway config (one exporter per store).
 *
 *   {
 *     "metrics": { "shared": { "queryUrl": "http://vmselect:8481" } },
 *     "logs":    { "shared": { "queryUrl": "https://opensearch:9200",
 *                              "credentials": "OPENSEARCH" } }
 *   }
 */

export const DATA_STORE_KINDS = ['metrics', 'logs'] as const;

export type DataStoreKind = (typeof DATA_STORE_KINDS)[number];

/** Every tenant uses it unless created with another store. */
export const DEFAULT_DATA_STORE = 'shared';

/** Same rule as the DB check (009_data_stores.sql): 1-40 chars. */
export const DATA_STORE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface DataStore {
  name: string;
  kind: DataStoreKind;
  /** 1:1 store: at most one tenant (not deleted) may use it. */
  exclusive: boolean;
}

export type DataStoreCatalog = Record<DataStoreKind, Record<string, DataStore>>;

/** Only the shared stores (no DATA_STORES_JSON). */
export function defaultDataStores(): DataStoreCatalog {
  return {
    metrics: {
      shared: { name: DEFAULT_DATA_STORE, kind: 'metrics', exclusive: false },
    },
    logs: {
      shared: { name: DEFAULT_DATA_STORE, kind: 'logs', exclusive: false },
    },
  };
}

/** Parses stores.json; every problem is reported, none is fatal here. */
export function parseDataStores(
  raw: string | undefined,
  problems: string[],
  key = 'DATA_STORES_JSON',
): DataStoreCatalog {
  if (raw === undefined || raw.trim() === '') {
    return defaultDataStores();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push(`${key} is not valid JSON`);
    return defaultDataStores();
  }

  if (!isObject(parsed)) {
    problems.push(`${key} must be a JSON object with "metrics" and "logs"`);
    return defaultDataStores();
  }

  const catalog: DataStoreCatalog = { metrics: {}, logs: {} };

  for (const kind of DATA_STORE_KINDS) {
    const stores = parsed[kind];

    if (!isObject(stores)) {
      problems.push(`${key}.${kind} must be an object of stores`);
      continue;
    }

    for (const [name, value] of Object.entries(stores)) {
      if (!DATA_STORE_NAME_RE.test(name)) {
        problems.push(
          `${key}.${kind}: invalid store name "${name}" (1-40 lowercase letters, digits or hyphens)`,
        );
        continue;
      }

      if (!isObject(value)) {
        problems.push(`${key}.${kind}.${name} must be an object`);
        continue;
      }

      const exclusive = value.exclusive ?? false;

      if (typeof exclusive !== 'boolean') {
        problems.push(`${key}.${kind}.${name}.exclusive must be true or false`);
        continue;
      }

      catalog[kind][name] = { name, kind, exclusive };
    }

    const shared = catalog[kind][DEFAULT_DATA_STORE];

    if (!shared) {
      problems.push(`${key}.${kind} must contain the "${DEFAULT_DATA_STORE}" store`);
    } else if (shared.exclusive) {
      problems.push(
        `${key}.${kind}.${DEFAULT_DATA_STORE} cannot be exclusive (every tenant may use it)`,
      );
    }
  }

  return catalog;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
