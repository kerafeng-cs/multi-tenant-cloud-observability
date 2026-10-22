import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * TODO-28: where each tenant's data lives.
 *
 * The catalog is the ConfigMap `data-stores` (key stores.json, env
 * DATA_STORES_JSON), shared with control-plane:
 *
 *   {
 *     "metrics": { "shared": { "queryUrl": "http://vmselect:8481" } },
 *     "logs":    { "shared": { "queryUrl": "https://opensearch:9200",
 *                              "credentials": "OPENSEARCH" } }
 *   }
 *
 * `credentials: "X"` = the read account in env X_USERNAME / X_PASSWORD
 * (each OpenSearch store has its own). Without DATA_STORES_JSON the
 * gateway behaves as before TODO-28: one shared store from
 * VICTORIAMETRICS_URL and OPENSEARCH_URL / _USERNAME / _PASSWORD.
 */

export type DataStoreKind = 'metrics' | 'logs';

export const DEFAULT_DATA_STORE = 'shared';

/** Same rule as control-plane and the DB check. */
export const DATA_STORE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Set by control-plane on each tenant org datasource (platform admins). */
export const SCOPE_STORE_HEADER = 'x-mtco-scope-store';

export interface MetricsStore {
  name: string;
  queryUrl: string;
}

export interface LogsStore {
  name: string;
  queryUrl: string;
  username: string;
  password: string;
}

export interface DataStoreCatalog {
  metrics: Record<string, MetricsStore>;
  logs: Record<string, LogsStore>;
}

type Env = (key: string) => string | undefined;

/** Fails fast (at startup) on any problem, listing all of them. */
export function parseDataStores(env: Env): DataStoreCatalog {
  const raw = env('DATA_STORES_JSON')?.trim();

  if (!raw) {
    return {
      metrics: {
        shared: {
          name: DEFAULT_DATA_STORE,
          queryUrl: required(env, 'VICTORIAMETRICS_URL'),
        },
      },
      logs: {
        shared: {
          name: DEFAULT_DATA_STORE,
          queryUrl: required(env, 'OPENSEARCH_URL'),
          username: required(env, 'OPENSEARCH_USERNAME'),
          password: required(env, 'OPENSEARCH_PASSWORD'),
        },
      },
    };
  }

  const problems: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DATA_STORES_JSON is not valid JSON');
  }

  const catalog: DataStoreCatalog = { metrics: {}, logs: {} };
  const root = isObject(parsed) ? parsed : {};

  for (const kind of ['metrics', 'logs'] as const) {
    const stores = root[kind];

    if (!isObject(stores)) {
      problems.push(`DATA_STORES_JSON.${kind} must be an object of stores`);
      continue;
    }

    for (const [name, value] of Object.entries(stores)) {
      const where = `DATA_STORES_JSON.${kind}.${name}`;

      if (!DATA_STORE_NAME_RE.test(name)) {
        problems.push(`${where}: invalid store name`);
        continue;
      }

      const queryUrl = isObject(value) ? value.queryUrl : undefined;

      if (typeof queryUrl !== 'string' || !/^https?:\/\/[^/]/.test(queryUrl)) {
        problems.push(`${where}.queryUrl must be an http(s) URL`);
        continue;
      }

      const url = queryUrl.replace(/\/+$/, '');

      if (kind === 'metrics') {
        catalog.metrics[name] = { name, queryUrl: url };
        continue;
      }

      const prefix = isObject(value) ? value.credentials : undefined;

      if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(prefix)) {
        problems.push(
          `${where}.credentials must name an env prefix (e.g. OPENSEARCH)`,
        );
        continue;
      }

      const username = env(`${prefix}_USERNAME`);
      const password = env(`${prefix}_PASSWORD`);

      if (!username || !password) {
        problems.push(
          `${where}: env ${prefix}_USERNAME and ${prefix}_PASSWORD are required`,
        );
        continue;
      }

      catalog.logs[name] = { name, queryUrl: url, username, password };
    }

    if (!(DEFAULT_DATA_STORE in stores)) {
      problems.push(
        `DATA_STORES_JSON.${kind} must contain the "${DEFAULT_DATA_STORE}" store`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid data stores:\n  - ${problems.join('\n  - ')}`);
  }

  return catalog;
}

export class DataStoreRegistry {
  constructor(private readonly catalog: DataStoreCatalog) {}

  /** 503: the store is not configured here (catalog out of sync). */
  metrics(name: string): MetricsStore {
    return this.find('metrics', name);
  }

  logs(name: string): LogsStore {
    return this.find('logs', name);
  }

  private find<K extends DataStoreKind>(
    kind: K,
    name: string,
  ): DataStoreCatalog[K][string] {
    const store = this.catalog[kind][name] as
      DataStoreCatalog[K][string] | undefined;

    if (!store) {
      throw new ServiceUnavailableException(
        `The ${kind} store "${name}" is not configured on this gateway`,
      );
    }

    return store;
  }
}

/**
 * The store a request reads from.
 * - Tenant users: the store claim of their token (metrics_store /
 *   logs_store, from their tenant group). No claim = a token minted before
 *   TODO-28 = the shared store (every tenant was in it). Headers are
 *   ignored: they can never move a tenant user to another store.
 * - Platform admins: the scope header of the tenant org datasource, else
 *   the shared store (org 1).
 */
export function resolveStore(
  claimed: string[],
  platformAdmin: boolean,
  headers: Request['headers'] | undefined,
): string {
  if (platformAdmin) {
    const raw = headers?.[SCOPE_STORE_HEADER];

    if (raw === undefined) {
      return DEFAULT_DATA_STORE;
    }

    const value = Array.isArray(raw)
      ? raw.length === 1
        ? raw[0].trim()
        : ''
      : raw.trim();

    if (!DATA_STORE_NAME_RE.test(value)) {
      throw new BadRequestException(
        `Invalid data store scope header (${SCOPE_STORE_HEADER})`,
      );
    }

    return value;
  }

  const stores = [...new Set(claimed.map((s) => s.trim()).filter(Boolean))];

  if (stores.length === 0) {
    return DEFAULT_DATA_STORE;
  }

  if (stores.length !== 1 || !DATA_STORE_NAME_RE.test(stores[0])) {
    throw new ForbiddenException(
      'Tenant must have exactly one valid data store per kind',
    );
  }

  return stores[0];
}

function required(env: Env, key: string): string {
  const value = env(key)?.trim();

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
