# Migration: enable_pg_stat_statements

**Classification: REVERSIBLE (documented down path) / OPERATOR-ATTACH**

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

## How to roll back (down path)

This migration is reversible. The reverse step is the companion
[`down.sql`](./down.sql):

```sql
DROP EXTENSION IF EXISTS pg_stat_statements;
```

That drops the extension object (idempotent via `IF EXISTS`). Fully backing the
extension out on managed Postgres additionally requires an operator to remove it
from `shared_preload_libraries` and restart Postgres — that operator step, plus
verification, is documented in
[`docs/runbooks/pg-stat-statements-rollback.md`](../../../docs/runbooks/pg-stat-statements-rollback.md).

The migration adds no tables and no columns; the down step only unloads the
read-only diagnostic extension.
