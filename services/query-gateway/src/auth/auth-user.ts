export interface AuthUser {
  sub: string;
  username: string;
  roles: string[];
  groups: string[];
  vmAccountIds: string[];
  /** TODO-28: metrics_store / logs_store claims (empty = shared). */
  metricsStores: string[];
  logsStores: string[];
}
