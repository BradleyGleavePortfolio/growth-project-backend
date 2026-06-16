# Migration: `rls_app_user_role`

Wave 1.5 / A1. Creates the least-privilege `app_user` Postgres role that
request-scoped Prisma queries run as (wiring lands in A2; policies in A3).

## Why no password in the SQL

Prisma migrations are applied non-interactively and **cannot read environment
variables at apply time**. Baking a literal password into `migration.sql` would
commit a secret to the repo and pin every environment to the same credential.

So `CREATE ROLE app_user` is run **without** a password (and is guarded by a
`DO` block so it is safe to re-run). The role cannot actually authenticate until
a password is set.

## Required out-of-band step (every environment)

Immediately after this migration is applied — local, CI, staging, production —
set the password from that environment's secret manager:

```sql
ALTER ROLE app_user WITH PASSWORD '<value-from-secret-manager>';
```

Then point the request-scoped connection string (added in A2) at `app_user`
with that password. The admin/migration connection keeps using the existing
privileged role.

### Secret location per environment

| Environment | Where the `app_user` password lives |
| ----------- | ----------------------------------- |
| Supabase (staging/prod) | Project Settings → Database (manage the role + password there); surface the connection string as a project secret |
| Fly.io      | `fly secrets set APP_USER_DATABASE_URL="postgres://app_user:<pw>@<pooler-host>:6543/postgres?pgbouncer=true"` |
| Local       | `.env.local` (gitignored) — never commit the literal password |

## Pooling assumption

The `app_user` request-scoped connection **MUST** go through the Supabase
pgbouncer **transaction-pool** (port `6543`, `?pgbouncer=true`) — the same mode
`DATABASE_URL` already uses (see `prisma/schema.prisma`). The RLS primitive
`withRlsContext` (`src/database/rls-context.ts`) relies on this: it stamps the
tenant GUCs with `set_config(..., is_local := true)` **inside** an interactive
transaction so the setting is scoped to that one transaction and cannot leak
across pooled backends. Session-level `SET` is **forbidden** under transaction
pooling.

Connection-string format:

```
postgres://app_user:<password>@<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
```

The admin/migration role continues to use `DIRECT_URL` (port `5432`, no
pgbouncer param) for DDL.

## Reconciliation with existing RLS

The repo already ships an earlier RLS layer in
`prisma/migrations/rls_fitness_backend.sql` (and the `*_rls_*` tier
migrations). That layer:

- reads the actor via the **`app.current_user_id`** GUC (not `app.user_id` /
  `app.gym_ids`),
- relies on Supabase **`service_role` + `BYPASSRLS`** for Prisma's production
  connection, and
- uses **`FORCE ROW LEVEL SECURITY`** on the protected tables.

This A1 work introduces a *different* contract — a `NOBYPASSRLS` `app_user` role
plus the `app.user_id` / `app.gym_ids` GUC namespace stamped by
`withRlsContext`. **A3 owns the reconciliation** and will choose one of:

1. migrate the existing policies to the new `app.user_id` / `app.gym_ids`
   namespace and run them under `app_user`, **or**
2. re-point `withRlsContext` to emit the existing `app.current_user_id` GUC and
   keep the current policy set.

That decision is deferred to the A3 spec; A1 deliberately changes no existing
policy and enables no RLS.

## Scope of grants

`app_user` is granted `CONNECT`, schema `USAGE`, and `SELECT/INSERT/UPDATE/DELETE`
on all current and future tables (plus sequence usage). The future-table grant
is via `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` — i.e. it covers tables
created by the migration-applying role (`postgres`); any other table-creating
role must add its own default-privileges grant. Prisma's `_prisma_migrations`
bookkeeping table is explicitly **revoked** from `app_user` (it is admin
surface, not tenant data). Because the role is `NOBYPASSRLS`, these grants are
the *ceiling*; the RLS policies added in A3 are what actually constrain row
visibility per tenant.

## Rollback

To fully undo this migration (e.g. to re-baseline), run as the privileged role,
**in this order**:

```sql
-- 1) Drop the privileges this migration granted.
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM app_user;
REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM app_user;
REVOKE USAGE ON SCHEMA public FROM app_user;
REVOKE CONNECT ON DATABASE current_database() FROM app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM app_user;

-- 2) Drop anything still owned by / granted to app_user, including the
--    default-privileges leftovers the REVOKEs above may not catch.
DROP OWNED BY app_user;

-- 3) Finally drop the role. DROP ROLE fails if the role still owns objects or
--    holds grants, so DROP OWNED BY MUST run first.
DROP ROLE app_user;
```

The ordering caveat is load-bearing: `DROP ROLE` will error with
"role cannot be dropped because some objects depend on it" unless
`DROP OWNED BY app_user;` has cleared its ownership and default-privilege
entries first.
