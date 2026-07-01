# Runbook: Roll back the `pg_stat_statements` extension

**Who this is for:** Bradley (and any operator managing The Growth Project backend).

**Plain-English summary:** This document tells you how to reverse the
`enable_pg_stat_statements` migration (`prisma/migrations/20261221000000_enable_pg_stat_statements/`).
That migration loads a read-only diagnostic Postgres extension used by the
bearer-gated `GET /admin/db-stats` endpoint. It has a real down path — this
runbook plus the companion `down.sql` — so it is **not** irreversible.

---

## When you would roll this back

- The extension is causing measurable overhead and you want it gone.
- You are decommissioning the `/admin/db-stats` endpoint.
- A managed-Postgres migration or provider change requires removing it from
  `shared_preload_libraries`.

The `/admin/db-stats` helper degrades gracefully (`available: false`) when the
extension is absent, so removing it does not break the API surface.

---

## Rollback has two parts

Loading the extension is a two-part operation (a SQL `CREATE EXTENSION` plus an
operator-attach step in `shared_preload_libraries`). Rolling it back mirrors
that.

### Part 1 — Drop the extension object (SQL, reversible from a migration)

Run the companion down step:

```sql
-- prisma/migrations/20261221000000_enable_pg_stat_statements/down.sql
DROP EXTENSION IF EXISTS pg_stat_statements;
```

This removes the `pg_stat_statements` view and its functions. It is idempotent
(`IF EXISTS`), so it is safe to run even if the extension was never attached on
this environment. Apply it the same way you apply any manual down step for this
project (e.g. `psql "$DATABASE_URL" -f down.sql`).

### Part 2 — Remove from `shared_preload_libraries` (operator, optional)

Dropping the extension does **not** remove `pg_stat_statements` from
`shared_preload_libraries`. Leaving it there is harmless (it just preloads a
library that nothing queries). If you want it fully backed out on managed
Postgres:

1. `ALTER SYSTEM SET shared_preload_libraries = '';` (or the provider's
   parameter-group equivalent on Fly / RDS, removing only this entry).
2. **Restart Postgres** for the change to take effect.

Neither Part 2 step can be performed from inside a Prisma migration (no
superuser, no restart), which is why they live here in the operator runbook.

---

## Verify the rollback

```sql
SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';
-- expect: 0 rows after Part 1
```

Then hit `GET /admin/db-stats` (bearer-gated) and confirm it returns
`available: false` with the operator-attach reason instead of a 500.
