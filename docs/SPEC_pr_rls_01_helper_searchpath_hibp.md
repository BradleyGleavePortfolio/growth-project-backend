# SPEC PR-RLS-01 — Helper Function search_path Lockdown + HIBP Enable

**Owner:** Dynasia G (founder)
**Cycle:** B — Supabase RLS Crisis
**Status:** Draft (pre-build, per R43)
**Base:** `origin/main` (`d6a127d9`)
**Branch:** `feat/rls-01-helper-searchpath-hibp`
**Supabase project:** `rpyfdsgxxltzutgqeouk`

---

## 1. Problem statement

The Supabase security advisor (pulled 2026-05-25) reports five `function_search_path_mutable` WARN-level findings and one `auth_leaked_password_protection` WARN-level finding:

| # | Function | Schema | Current security flags |
|---|---|---|---|
| 1 | `current_user_id()`            | `app`    | `STABLE`, no `SECURITY DEFINER`, no pinned `search_path` |
| 2 | `current_user_role()`          | `app`    | `STABLE`, no `SECURITY DEFINER`, no pinned `search_path` |
| 3 | `is_owner()`                   | `app`    | `STABLE`, no `SECURITY DEFINER`, no pinned `search_path` |
| 4 | `is_current_coach_of(text)`    | `app`    | `STABLE`, no `SECURITY DEFINER`, no pinned `search_path` |
| 5 | `enforce_subcoach_head_cap()`  | `public` | trigger function, no `SECURITY DEFINER`, no pinned `search_path` |

Item 5 lives in `public`, not `app`, because the trigger was attached to a `public` table and Postgres co-located it. The Cycle B brief listed it under `app.*`; the actual schema is `public.*`. This spec corrects that detail and the migration targets the real object.

A sixth helper, `app.is_user_coached_by(text, text)`, already has `SECURITY DEFINER` and `SET search_path = public, pg_temp` pinned (verified via `pg_get_functiondef`). It is not flagged by the advisor and is out of scope for this PR. Per Fix Round 1 (audit P2-008), the migration no longer touches its ACLs — leaving them under whatever the prior migration set so the change set for PR-RLS-01 stays within the five-helper target.

Separately, the Supabase Auth `auth_leaked_password_protection` setting is OFF. This means a user can register or rotate to a password that is known to be in a public breach corpus (HaveIBeenPwned). The fix is a single dashboard toggle, not SQL.

---

## 2. Threat model

### 2.1 search_path shadowing attack

Postgres resolves unqualified function and table names at execution time against the session `search_path`. If a helper like `app.current_user_id()` contains an unqualified reference (e.g. `current_setting(...)` resolves to `pg_catalog.current_setting`, which is fine, but other helpers chain into `app.is_user_coached_by` and reference `public."User"`), then a malicious role with `CREATE` on a schema earlier in `search_path` than `public`/`app` — or a session that issues `SET search_path = 'attacker_schema, public, app'` before invoking a helper used in an RLS policy — can substitute a same-named function or table and trick the helper into returning `true` or returning an attacker-controlled user id. RLS policies that gate access via `app.is_owner()` or `client_id = app.current_user_id()` would then admit the attacker.

The canonical mitigation is to pin `search_path` at function-create time so the resolution context is fixed regardless of caller state. Combined with `SECURITY DEFINER`, the helper executes with the definer's privileges and a definer-controlled search path, eliminating the shadowing vector. (Reference: Supabase docs `0011_function_search_path_mutable`, Postgres docs `CREATE FUNCTION`.)

### 2.2 Password reuse pivot

Without HIBP enforcement, a user can register with a password that has appeared in a public breach corpus. An attacker who already holds the breach pair (email, password) can then take over the account on first sign-in. This is not theoretical: credential stuffing accounts for a majority of account-takeover incidents on consumer SaaS. Supabase Auth integrates with the HaveIBeenPwned k-anonymity API; enabling the toggle rejects breached passwords at sign-up and password-change with no client change required.

---

## 3. Solution

### 3.1 Function hardening pattern

For each of the four `app.*` helpers and the one `public.*` trigger function, apply the canonical Postgres lockdown:

```sql
CREATE OR REPLACE FUNCTION <schema>.<name>(<args>)
RETURNS <type>
LANGUAGE <plpgsql|sql>
<volatility>
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  <body unchanged, verified byte-identical against pg_get_functiondef from live DB>
$function$;

REVOKE ALL ON FUNCTION <schema>.<name>(<args>) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION <schema>.<name>(<args>) FROM anon;
GRANT EXECUTE ON FUNCTION <schema>.<name>(<args>) TO authenticated, service_role;

COMMENT ON FUNCTION <schema>.<name>(<args>) IS '<existing comment + PR-RLS-01 note>';
```

### 3.1.1 Role grant pattern (canonical for RLS-01..08)

The ACL block above is the **canonical pattern for every hardened RBAC helper** introduced in Cycle B. Downstream PRs (RLS-02..08) MUST match it exactly:

| Role | EXECUTE | Rationale |
|---|:-:|---|
| `PUBLIC` | revoked | strip implicit broad grant |
| `anon` | **revoked** | RBAC helpers must not be callable by the unauthenticated role; the session GUCs they read are only set by the NestJS interceptor for authenticated requests |
| `authenticated` | granted | RLS policies on user-facing tables evaluate helpers under this role |
| `service_role` | granted | server-side workflows and Supabase admin tooling bypass RLS but still call helpers for parity |

PostgREST policies that previously listed `TO public` still admit `authenticated` and `service_role`; they no longer admit `anon` to these helpers, by design.

Idempotency: `REVOKE EXECUTE ... FROM anon` is safe to re-run even if no prior grant existed.

Notes:

- `search_path = pg_catalog, public, app` is the minimum sufficient set:
  - `pg_catalog` first so built-ins like `current_setting`, `EXISTS`, `NULLIF`, etc. always resolve to canonical Postgres.
  - `public` is needed because `is_user_coached_by` and the trigger function reference `public."User"` and `public."TeamSubCoachAssignment"` (the trigger function references its own table via unqualified identifier).
  - `app` is needed because `is_owner` and `is_current_coach_of` chain into other `app.*` helpers.
- `REVOKE ... FROM PUBLIC` clears the implicit broad grant; `REVOKE EXECUTE ... FROM anon` removes the unauthenticated-role access surface; `GRANT EXECUTE` re-grants to the two roles that actually need to evaluate helpers (`authenticated`, `service_role`). RLS policies that previously read like `TO public` still admit authenticated callers because PostgREST routes authenticated requests under role `authenticated`, which holds the explicit grant.
- Function bodies are preserved byte-identical relative to the live database, fetched via `pg_get_functiondef`. The fetched bodies are documented in a SQL comment block above each `CREATE OR REPLACE` so a future reader can verify the round-trip.
- `is_user_coached_by(text, text)` is intentionally untouched in this migration (audit P2-008): its body and flags are already correct and re-asserting its grants would expand the audit surface beyond the five-helper target.

### 3.2 HIBP enable

Dashboard step (operator action — not automated by this PR):

1. Supabase Dashboard → project `rpyfdsgxxltzutgqeouk` → Authentication → Settings (Auth providers tab).
2. Toggle "Leaked password protection" / "HaveIBeenPwned password check" → ON.
3. Save.

Record date, operator, and project in `agent-context/SUPABASE_CONFIG.md`. The Supabase advisor's `auth_leaked_password_protection` warn should clear within ~5 minutes.

---

## 4. Migration plan

Forward-only, idempotent. One file:

`prisma/migrations/20260704000000_rls01_helper_searchpath_hibp/migration.sql`

The timestamp prefix `20260704000000` lands after PR #266 (which adds Coach Brief migrations through `20260703000002`) and before subsequent RLS migrations (RLS-02..08, which will use later timestamps). This avoids the prefix collision with the existing `20260525000000_sub_coach_rls_and_fks` migration (audit P2-005).

Migration structure:

1. `BEGIN;`
2. `CREATE SCHEMA IF NOT EXISTS app;` (safety; already exists)
3. Five `CREATE OR REPLACE FUNCTION ...` statements with the hardened signature.
4. Five `REVOKE / GRANT` pairs.
5. Five `COMMENT ON FUNCTION ...` statements.
6. `COMMIT;`

No `DROP FUNCTION` is used. This preserves dependent RLS policies and trigger bindings (`CREATE OR REPLACE` updates the function in place; dependents are untouched).

Trigger note: `trg_enforce_subcoach_head_cap` on `public."TeamSubCoachAssignment"` survives a `CREATE OR REPLACE FUNCTION` of the underlying function, because the trigger references the function by oid resolved at trigger-create time. Verified: `pg_trigger.tgfoid` is stored as oid, not name.

---

## 5. Test plan

`test/rls/helper-functions.spec.ts` — new Jest suite covering each helper.

Strategy: tests run against a Prisma client that allows `SET LOCAL` on session GUCs. For each helper, three assertions:

1. **Valid authenticated context.** Set `app.current_user_id` and `app.current_user_role` via `SET LOCAL`, invoke the helper through `prisma.$queryRaw`, assert the expected return.
2. **Anonymous context.** Clear the GUCs (`RESET app.current_user_id`), invoke the helper, assert `NULL` / `false`.
3. **Cross-role.** Set a non-owner role, invoke `is_owner()`, assert `false`. Set a role string that is not "owner", confirm `is_owner()` is `false`.

For `enforce_subcoach_head_cap` (trigger function):
- Insert two `TeamSubCoachAssignment` rows pointing at the same `sub_coach_id` with different `head_coach_id`s — succeeds (under the cap of 2).
- Insert a third — trigger raises `check_violation` with message `sub_coach_head_cap_exceeded`. Test asserts the Prisma client throws.
- Insert with `archived_at` set — succeeds even past cap (per the function's early-return branch).

Test infra: use the existing `test/fixtures/` patterns if a PG container is available. If the suite runs against a mock, use `prisma.$queryRawUnsafe` and `pg-mem` is not appropriate (it lacks PostgREST role machinery); instead, the suite is structured so that on CI without a live DB, the tests are skipped via `describe.skip` with a documented reason and the migration's SQL itself is asserted to compile by the prisma diff gate. This matches the existing pattern in `test/cross-tenant-isolation.spec.ts` and `test/auth-guard-deletion-lockout.spec.ts`.

Acceptance: when a live DB is available (`DATABASE_URL` set and reachable), all assertions execute; when not, the suite emits a clear skip reason and the migration gate (`prisma migrate diff`) still guards the SQL.

---

## 6. CI guard

`scripts/ci/check-relrowsecurity.sh`

Runs against the `DATABASE_URL` of the environment:

```sql
SELECT n.nspname || '.' || c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND NOT c.relrowsecurity;
```

Exits non-zero if any row is returned. Gated by `RLS_ENFORCEMENT_FULL` env var:

- `RLS_ENFORCEMENT_FULL` unset or not `on` → script exits 0 with a soft report. PR-RLS-01 ships in this state because RLS-02..08 have not enabled RLS on the remaining ~50 tables yet; failing CI now would block every Cycle B PR.
- `RLS_ENFORCEMENT_FULL=on` → script exits non-zero if any public table lacks RLS. Flipped after PR-RLS-08 merges.

The soft-report mode still surfaces the table count and list so reviewers can watch the number trend down through Cycle B.

---

## 7. Rollback plan

If the migration is applied and a regression appears:

1. Revert by re-issuing `CREATE OR REPLACE FUNCTION ...` with the original (pre-PR-RLS-01) body, dropping `SECURITY DEFINER` and the `SET search_path` clause. The original bodies are committed in this spec section 8 and as an executable rollback block at the bottom of the migration file itself (audit P2-006).
2. `REVOKE EXECUTE ... FROM authenticated, service_role; GRANT EXECUTE ... TO PUBLIC;` to restore the prior ACL.
3. HIBP rollback: toggle off in the dashboard. No data effect.

No table-level rollback is required because this PR does not enable RLS on any new table.

---

## 8. Documented original bodies (fetched 2026-05-25 via `pg_get_functiondef`)

```sql
-- app.current_user_id (BEFORE)
CREATE OR REPLACE FUNCTION app.current_user_id()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$function$;

-- app.current_user_role (BEFORE)
CREATE OR REPLACE FUNCTION app.current_user_role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$function$;

-- app.is_owner (BEFORE)
CREATE OR REPLACE FUNCTION app.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$function$;

-- app.is_current_coach_of (BEFORE)
CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$function$;

-- public.enforce_subcoach_head_cap (BEFORE)
CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    head_count INTEGER;
BEGIN
    IF NEW.archived_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT COUNT(*) INTO head_count
    FROM "TeamSubCoachAssignment"
    WHERE "sub_coach_id" = NEW."sub_coach_id"
      AND "archived_at" IS NULL
      AND "id" <> NEW."id";
    IF head_count >= 2 THEN
        RAISE EXCEPTION 'sub_coach_head_cap_exceeded: sub-coach % already assigned under 2 head coaches', NEW."sub_coach_id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$function$;
```

Function return types differ from the Cycle B execution-plan summary (the plan listed `uuid`; the live DB uses `text`). The migration preserves the `text` return type to keep call sites and policies byte-identical.

---

## 9. Acceptance criteria

- Supabase advisor: `function_search_path_mutable` count drops from 5 to 0 for the listed helpers (verified post-deploy via `mcp:supabase:get_advisors type=security`).
- Supabase advisor: `auth_leaked_password_protection` count drops from 1 to 0 once the operator flips the toggle.
- `prisma migrate diff --from-empty --to-schema-datamodel` parses and applies cleanly.
- `prisma generate` green.
- `tsc --noEmit` green.
- `jest test/rls/` green (or cleanly skipped without DB).
- Branch grep clean for the banned hostname (t-g-p dot a-p-p, R45), forbidden lexicon, and AI co-author trailers.

---

## 10. Out of scope

- Enabling RLS on any new table — that belongs to PR-RLS-02 through PR-RLS-08.
- Refactoring `is_user_coached_by` — already hardened.
- Flipping the live HIBP toggle — operator action; PR documents the requirement.
- Performance index work — Cycle E.
