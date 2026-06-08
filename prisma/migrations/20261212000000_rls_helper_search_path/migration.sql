-- PR-RLS-FN — RLS helper search_path hardening
--
-- Pins `search_path = ''` on the five RLS helper functions so that an attacker
-- who can create objects in a user-writable schema cannot shadow an unqualified
-- table/function reference inside a SECURITY-sensitive helper (CVE-class:
-- search_path injection). With an empty search_path EVERY reference inside the
-- function body must be schema-qualified, so each body below fully qualifies its
-- table references (public."...") and built-in calls (pg_catalog.current_setting)
-- and helper calls (app....).
--
-- Behavior is PRESERVED EXACTLY:
--   * identical signatures, return types, language, volatility, and security mode
--   * identical logic — the only semantic-neutral change is the qualified names
--     and the empty search_path constraint
--
-- Rollback: re-run the prior CREATE OR REPLACE definitions from their original
-- migrations (20260510000000 for the trigger, 20260607000000 / 20260531000000
-- for the app.* helpers). Do NOT roll back table policies.
--
-- Note: app.is_user_coached_by(text, text) is intentionally NOT modified here.
-- It already ships with `SECURITY DEFINER` + `SET search_path = public, pg_temp`
-- and is out of scope for PR-RLS-FN. is_current_coach_of() calls it qualified.

BEGIN;

-- Defensive, idempotent schema guard (matches the convention of every prior
-- helper migration: 20260520, 20260531, 20260607). In the migration chain `app`
-- already exists; this keeps the migration self-sufficient if replayed in
-- isolation and is a no-op otherwise.
CREATE SCHEMA IF NOT EXISTS app;

-- 1) public.enforce_subcoach_head_cap() — BEFORE INSERT/UPDATE trigger on
--    public."TeamSubCoachAssignment". Trigger binding (trg_enforce_subcoach_head_cap)
--    is unaffected by CREATE OR REPLACE and is intentionally left in place.
CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  head_count integer;
BEGIN
  IF NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO head_count
  FROM public."TeamSubCoachAssignment"
  WHERE "sub_coach_id" = NEW."sub_coach_id"
    AND "archived_at" IS NULL
    AND "id" <> NEW."id";
  IF head_count >= 2 THEN
    RAISE EXCEPTION 'sub_coach_head_cap_exceeded: sub-coach % already assigned under 2 head coaches', NEW."sub_coach_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 2) app.current_user_role() — reads the NestJS-set session GUC.
CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$$;

-- 3) app.current_user_id() — reads the NestJS-set session GUC.
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$$;

-- 4) app.is_owner() — true when the RLS context identifies an authenticated owner.
CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$$;

-- 5) app.is_current_coach_of(text) — true when the current user coaches the client.
CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$$;

-- Preserve the original COMMENTs (unchanged text) so descriptions survive the
-- CREATE OR REPLACE (replacing a function body does not drop its comment, but we
-- re-assert them defensively to keep the catalog self-documenting).
COMMENT ON FUNCTION public.enforce_subcoach_head_cap() IS
  'BEFORE INSERT/UPDATE trigger on TeamSubCoachAssignment: caps a sub-coach at 2 non-archived head-coach assignments. search_path pinned to '''' (PR-RLS-FN).';
COMMENT ON FUNCTION app.current_user_role() IS
  'Returns the NestJS-authenticated role stored in app.current_user_role for RLS policies; NULL means unauthenticated/no role context.';
COMMENT ON FUNCTION app.current_user_id() IS
  'Returns the NestJS-authenticated User.id stored in app.current_user_id for RLS policies; NULL means unauthenticated/no id context.';
COMMENT ON FUNCTION app.is_owner() IS
  'True when the RLS context identifies an authenticated owner user.';
COMMENT ON FUNCTION app.is_current_coach_of(text) IS
  'True when app.current_user_id() is the current coach of the supplied client User.id.';

COMMIT;
