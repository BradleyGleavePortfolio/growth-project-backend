# Migration: enable_pg_stat_statements

**Classification: IRREVERSIBLE / OPERATOR-ATTACH**

Loads the `pg_stat_statements` Postgres extension that powers the bearer-gated
`GET /admin/db-stats` endpoint (top-N slowest statements by `total_exec_time`).

## Why operator-attach

`pg_stat_statements` must be listed in `shared_preload_libraries`, which on
managed Postgres requires:

1. A superuser `ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';`
   (or the provider's parameter-group equivalent on Fly / RDS).
2. A **Postgres restart** for the change to take effect.

Neither can be done from a Prisma migration. The `CREATE EXTENSION IF NOT
EXISTS` statement here is idempotent and is a no-op until those prerequisites
are satisfied by an operator. The `/admin/db-stats` helper degrades gracefully
(returns `available: false`) when the extension is absent.

## Why IRREVERSIBLE

The migration loads a read-only diagnostic extension and makes no schema change
(no tables, no columns), so there is nothing to roll back. Dropping the
extension is an operator decision, not a migration-down step.
