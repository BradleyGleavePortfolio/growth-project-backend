// Barrel for the H3 observability surface (prom-client metrics, bearer-token
// gate, pg_stat_statements db-stats, Sentry release tagging). Existing
// observability primitives (MetricsService, AppLoggerService, etc.) are
// imported directly from their modules and are intentionally not re-exported
// here to avoid churn in established import paths.
export * from './prom-metrics';
export * from './metrics-auth.guard';
export * from './prom-metrics.controller';
export * from './db-stats.service';
export * from './db-stats.controller';
export * from './sentry-config';
