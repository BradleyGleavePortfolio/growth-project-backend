-- W1.5-A3.1 — RLS spine convergence: new-namespace helper functions (EXPAND step).
--
-- Adds two SQL helpers that read the A2 GUC namespace (app.user_id / app.gym_ids):
--   * app.current_user_id_v2() — the new-namespace twin of app.current_user_id().
--   * app.current_gym_ids()    — the authorized-gym list as a text[] (deny on empty).
--
-- ZERO live RLS policy is re-pointed in this migration. No table RLS is enabled
-- or altered. These helpers exist ONLY so the deferred A3.2 contract step can
-- switch User/gym-scoped policies from app.current_user_id() onto the new
-- namespace after the parity shadow-check (see withRlsContext) proves 100%
-- agreement during the staging soak. Until then the legacy namespace stays
-- authoritative and these functions are unreferenced by any policy.
--
-- search_path is pinned to '' to match the hardened helper convention
-- (PR-RLS-FN, migration 20261212000000): every reference inside the body is
-- fully schema-qualified so an attacker who can create objects in a
-- user-writable schema cannot shadow an unqualified reference.
--
-- Empty-gyms DENY contract: app.gym_ids serializes an empty authorization to the
-- empty string ''. app.current_gym_ids() returns NULL (not {''}) for the empty
-- case, so policies guarding `gym_id = ANY(app.current_gym_ids())` deny-all
-- rather than matching the string_to_array('', ',') = {''} footgun.
--
-- Rollback: DROP FUNCTION IF EXISTS app.current_user_id_v2();
--           DROP FUNCTION IF EXISTS app.current_gym_ids();
--   No policy references them, so dropping is a clean no-op for live RLS.

BEGIN;

-- Defensive, idempotent schema guard — matches every prior app.* helper
-- migration (20260520, 20260531, 20260607, 20261212). No-op in the live chain.
CREATE SCHEMA IF NOT EXISTS app;

-- app.current_user_id_v2() — reads the A2 NestJS-set session GUC `app.user_id`.
-- New-namespace twin of app.current_user_id(); NULL means no id context.
CREATE OR REPLACE FUNCTION app.current_user_id_v2()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.user_id', true), '')
$$;

-- app.current_gym_ids() — the authorized gym ids from the A2 GUC `app.gym_ids`
-- as a text[]. Returns NULL when the GUC is unset or the empty string ('') so
-- the empty-authorization case denies all gym-scoped rows (per the
-- RLS_GYM_IDS_KEY empty-array DENY contract) instead of producing {''}.
CREATE OR REPLACE FUNCTION app.current_gym_ids()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN NULLIF(pg_catalog.current_setting('app.gym_ids', true), '') IS NULL
      THEN NULL
    ELSE pg_catalog.string_to_array(
           pg_catalog.current_setting('app.gym_ids', true), ',')
  END
$$;

COMMENT ON FUNCTION app.current_user_id_v2() IS
  'W1.5-A3.1: returns the acting User.id from the new app.user_id GUC; NULL means no id context. Twin of app.current_user_id(); NO live policy references it until A3.2.';
COMMENT ON FUNCTION app.current_gym_ids() IS
  'W1.5-A3.1: returns the authorized gym ids from the app.gym_ids GUC as text[], or NULL when empty (deny-all). NO live policy references it until A3.2.';

COMMIT;
