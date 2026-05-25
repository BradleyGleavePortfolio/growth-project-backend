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
--
-- ACL pattern (R/RLS-01 canonical, applied identically to every
-- downstream RLS PR per R42 cross-PR consistency):
--   REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--   REVOKE EXECUTE ON FUNCTION ... FROM anon;
--   GRANT EXECUTE ON FUNCTION ... TO authenticated, service_role;
--
-- Rationale: RBAC helpers must not be callable by the unauthenticated
-- role. The session GUCs current_user_id / current_user_role are only
-- ever set by the NestJS interceptor for authenticated callers; an
-- anon-role caller has no legitimate reason to evaluate them. The
-- explicit REVOKE-from-anon defends against future GRANT regressions
-- and against PostgREST exposing these helpers as RPC endpoints.
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
REVOKE EXECUTE ON FUNCTION app.current_user_id() FROM anon;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO authenticated, service_role;

COMMENT ON FUNCTION app.current_user_id() IS
  'PR-RLS-01: hardened. Returns the NestJS-authenticated user id stored in the app.current_user_id session GUC for RLS policies; NULL when unset/anon. Grants restricted to authenticated, service_role.';

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
REVOKE EXECUTE ON FUNCTION app.current_user_role() FROM anon;
GRANT EXECUTE ON FUNCTION app.current_user_role() TO authenticated, service_role;

COMMENT ON FUNCTION app.current_user_role() IS
  'PR-RLS-01: hardened. Returns the NestJS-authenticated role stored in the app.current_user_role session GUC for RLS policies; NULL when unset/anon. Grants restricted to authenticated, service_role.';

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
REVOKE EXECUTE ON FUNCTION app.is_owner() FROM anon;
GRANT EXECUTE ON FUNCTION app.is_owner() TO authenticated, service_role;

COMMENT ON FUNCTION app.is_owner() IS
  'PR-RLS-01: hardened. True when the RLS session identifies an authenticated owner user. Grants restricted to authenticated, service_role.';

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
REVOKE EXECUTE ON FUNCTION app.is_current_coach_of(text) FROM anon;
GRANT EXECUTE ON FUNCTION app.is_current_coach_of(text) TO authenticated, service_role;

COMMENT ON FUNCTION app.is_current_coach_of(text) IS
  'PR-RLS-01: hardened. True when app.current_user_id() is the current coach of the supplied client User.id. Grants restricted to authenticated, service_role.';

-- ─────────────────────────────────────────────────────────────────
-- 5) public.enforce_subcoach_head_cap() [trigger function]
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
--
-- Explicit VOLATILE marker (P3-001): live pg_proc.provolatile is 'v' and the
-- function mutates nothing but reads NEW + sibling rows on every INVOKE, so
-- VOLATILE is the only correct classification. Stating it explicitly removes
-- the implicit default from the audit surface.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
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
REVOKE EXECUTE ON FUNCTION public.enforce_subcoach_head_cap() FROM anon;
GRANT EXECUTE ON FUNCTION public.enforce_subcoach_head_cap() TO authenticated, service_role;

COMMENT ON FUNCTION public.enforce_subcoach_head_cap() IS
  'PR-RLS-01: hardened. Trigger function on TeamSubCoachAssignment enforcing the cap of 2 head coaches per sub-coach. Grants restricted to authenticated, service_role.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────
-- ROLLBACK (P2-006)
--
-- Not executed by Prisma. Manual operator-run SQL to restore the
-- pre-PR-RLS-01 function bodies and ACL pattern, in case a
-- regression surfaces after deploy. Wrap in BEGIN/COMMIT when
-- applying. The function bodies below are the byte-identical
-- pre-hardening definitions fetched via pg_get_functiondef on
-- 2026-05-25 from the live DB. Restoring them drops SECURITY
-- DEFINER + pinned search_path. ACL is restored to the pre-PR
-- broad-grant state observed via pg_proc.proacl on the same date.
--
-- BEGIN;
--
-- CREATE OR REPLACE FUNCTION app.current_user_id()
--  RETURNS text LANGUAGE sql STABLE
-- AS $function$
--   SELECT NULLIF(current_setting('app.current_user_id', true), '')
-- $function$;
-- REVOKE EXECUTE ON FUNCTION app.current_user_id() FROM authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION app.current_user_id() TO PUBLIC;
--
-- CREATE OR REPLACE FUNCTION app.current_user_role()
--  RETURNS text LANGUAGE sql STABLE
-- AS $function$
--   SELECT NULLIF(current_setting('app.current_user_role', true), '')
-- $function$;
-- REVOKE EXECUTE ON FUNCTION app.current_user_role() FROM authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION app.current_user_role() TO PUBLIC;
--
-- CREATE OR REPLACE FUNCTION app.is_owner()
--  RETURNS boolean LANGUAGE sql STABLE
-- AS $function$
--   SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
-- $function$;
-- REVOKE EXECUTE ON FUNCTION app.is_owner() FROM authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION app.is_owner() TO PUBLIC;
--
-- CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
--  RETURNS boolean LANGUAGE sql STABLE
-- AS $function$
--   SELECT app.current_user_id() IS NOT NULL
--      AND app.is_user_coached_by(client_user_id, app.current_user_id())
-- $function$;
-- REVOKE EXECUTE ON FUNCTION app.is_current_coach_of(text) FROM authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION app.is_current_coach_of(text) TO PUBLIC;
--
-- CREATE OR REPLACE FUNCTION public.enforce_subcoach_head_cap()
--  RETURNS trigger LANGUAGE plpgsql
-- AS $function$
-- DECLARE
--     head_count INTEGER;
-- BEGIN
--     IF NEW.archived_at IS NOT NULL THEN
--         RETURN NEW;
--     END IF;
--     SELECT COUNT(*) INTO head_count
--     FROM "TeamSubCoachAssignment"
--     WHERE "sub_coach_id" = NEW."sub_coach_id"
--       AND "archived_at" IS NULL
--       AND "id" <> NEW."id";
--     IF head_count >= 2 THEN
--         RAISE EXCEPTION 'sub_coach_head_cap_exceeded: sub-coach % already assigned under 2 head coaches', NEW."sub_coach_id"
--             USING ERRCODE = 'check_violation';
--     END IF;
--     RETURN NEW;
-- END;
-- $function$;
-- REVOKE EXECUTE ON FUNCTION public.enforce_subcoach_head_cap() FROM authenticated, service_role;
-- GRANT EXECUTE ON FUNCTION public.enforce_subcoach_head_cap() TO PUBLIC;
--
-- COMMIT;
