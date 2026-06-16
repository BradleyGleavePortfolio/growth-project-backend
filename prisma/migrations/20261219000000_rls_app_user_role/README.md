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

## Scope of grants

`app_user` is granted `CONNECT`, schema `USAGE`, and `SELECT/INSERT/UPDATE/DELETE`
on all current and future tables (plus sequence usage). Because the role is
`NOBYPASSRLS`, these grants are the *ceiling*; the RLS policies added in A3 are
what actually constrain row visibility per tenant.
