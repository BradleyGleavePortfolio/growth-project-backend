-- PR-RLS-01: Helper function search_path lockdown
--
-- Source spec: docs/SPEC_pr_rls_01_helper_searchpath_hibp.md
-- Supabase project: rpyfdsgxxltzutgqeouk
-- Advisor lints addressed (function_search_path_mutable, WARN):
--   1. app.current_user_id
--   2. app.current_user_role
--   3. app.is_owner
--   4. app.is_current_coach_of
--   5. public.enforce_subcoach_head_cap
--
-- Each function below was fetched verbatim via pg_get_functiondef
-- against the live database on 2026-05-25. The original body is
-- pasted in a comment block above each CREATE OR REPLACE so the
-- preservation of behaviour is auditable. The new definition adds:
--   * SECURITY DEFINER (function executes with the definer role,
--     not the caller, eliminating session-driven shadowing)
--   * SET search_path = pg_catalog, public, app (pins resolution
--     order regardless of caller GUCs)
-- and re-asserts a minimum-privilege grant: REVOKE ALL FROM PUBLIC,
-- then GRANT EXECUTE to anon, authenticated, service_role.
--
-- app.is_user_coached_by(text, text) already has SECURITY DEFINER
-- and SET search_path = public, pg_temp. It is re-stated here for
-- grant idempotency only — body and flags are unchanged.
--
-- Forward-only. Re-runnable: CREATE OR REPLACE FUNCTION updates in
-- place, REVOKE/GRANT are idempotent, COMMENT ON is idempotent.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- ─────────────────────────────────────────────────────────────────
-- 1) app.current_user_id()
--
-- BEFORE (live DB, pg_get_functiondef):
--   CREATE OR REPLACE FUNCTION app.current_user_id()
--    RETURNS text
--    LANGUAGE sql
--    STABLE
--   AS $function$
--     SELECT NULLIF(current_setting('app.current_user_id', true), '')
--   $function$;
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$function$;

REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO anon, authenticated, service_role;

COMMENT ON FUNCTION app.current_user_id() IS
  'PR-RLS-01: SECURITY DEFINER with pinned search_path. Returns the NestJS-authenticated user id stored in the app.current_user_id session GUC for RLS policies; NULL when unset/anon.';

-- ─────────────────────────────────────────────────────────────────
-- 2) app.current_user_role()
--
-- BEFORE (live DB, pg_get_functiondef):
--   CREATE OR REPLACE FUNCTION app.current_user_role()
--    RETURNS text
--    LANGUAGE sql
--    STABLE
--   AS $function$
--     SELECT NULLIF(current_setting('app.current_user_role', true), '')
--   $function$;
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$function$;

REVOKE ALL ON FUNCTION app.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_role() TO anon, authenticated, service_role;

COMMENT ON FUNCTION app.current_user_role() IS
  'PR-RLS-01: SECURITY DEFINER with pinned search_path. Returns the NestJS-authenticated role stored in the app.current_user_role session GUC for RLS policies; NULL when unset/anon.';

-- ─────────────────────────────────────────────────────────────────
-- 3) app.is_owner()
--
-- BEFORE (live DB, pg_get_functiondef):
--   CREATE OR REPLACE FUNCTION app.is_owner()
--    RETURNS boolean
--    LANGUAGE sql
--    STABLE
--   AS $function$
--     SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
--   $function$;
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$function$;

REVOKE ALL ON FUNCTION app.is_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_owner() TO anon, authenticated, service_role;

COMMENT ON FUNCTION app.is_owner() IS
  'PR-RLS-01: SECURITY DEFINER with pinned search_path. True when the RLS session identifies an authenticated owner user.';

-- ─────────────────────────────────────────────────────────────────
-- 4) app.is_current_coach_of(client_user_id text)
--
-- BEFORE (live DB, pg_get_functiondef):
--   CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
--    RETURNS boolean
--    LANGUAGE sql
--    STABLE
--   AS $function$
--     SELECT app.current_user_id() IS NOT NULL
--        AND app.is_user_coached_by(client_user_id, app.current_user_id())
--   $function$;
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$function$;

REVOKE ALL ON FUNCTION app.is_current_coach_of(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_current_coach_of(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION app.is_current_coach_of(text) IS
  'PR-RLS-01: SECURITY DEFINER with pinned search_path. True when app.current_user_id() is the current coach of the supplied client User.id.';

-- ─────────────────────────────────────────────────────────────────
-- 5) app.is_user_coached_by(text, text)
--
-- Already SECURITY DEFINER + pinned search_path = public, pg_temp.
-- Body unchanged. Re-asserting grants only for idempotent ACL parity
-- with the rest of the helper family.
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION app.is_user_coached_by(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_user_coached_by(text, text) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- 6) public.enforce_subcoach_head_cap() [trigger function]
--
-- BEFORE (live DB, pg_get_functiondef):
--   CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
--    RETURNS trigger
--    LANGUAGE plpgsql
--   AS $function$
--   DECLARE
--       head_count INTEGER;
--   BEGIN
--       IF NEW.archived_at IS NOT NULL THEN
--           RETURN NEW;
--       END IF;
--       SELECT COUNT(*) INTO head_count
--       FROM "TeamSubCoachAssignment"
--       WHERE "sub_coach_id" = NEW."sub_coach_id"
--         AND "archived_at" IS NULL
--         AND "id" <> NEW."id";
--       IF head_count >= 2 THEN
--           RAISE EXCEPTION 'sub_coach_head_cap_exceeded: sub-coach % already assigned under 2 head coaches', NEW."sub_coach_id"
--               USING ERRCODE = 'check_violation';
--       END IF;
--       RETURN NEW;
--   END;
--   $function$;
--
-- The trigger trg_enforce_subcoach_head_cap on public."TeamSubCoachAssignment"
-- references this function by oid; CREATE OR REPLACE preserves the oid and the
-- trigger continues to fire without re-creation.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
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

REVOKE ALL ON FUNCTION public.enforce_subcoach_head_cap() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_subcoach_head_cap() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_subcoach_head_cap() IS
  'PR-RLS-01: SECURITY DEFINER with pinned search_path. Trigger function on TeamSubCoachAssignment enforcing the cap of 2 head coaches per sub-coach.';

COMMIT;
