-- BLOCK-ALL-BE (#168-4, OD 6353564193 on b#1135: "a ban from a space covers
-- that space only. The banned person sees no messages in that space and cannot
-- type there."): what a banned person wrote in a community no longer reads
-- there for anyone. The API (community-space-access.ts rowsByAuthorsWhoStay and
-- authorsWhoLeft, the one shared place) asks this function, so the same query
-- also runs under row security, where community_workspace_bans is closed to
-- authenticated (20270211000000). It answers one yes/no for a (community,
-- person) pair; no row of the bans table is exposed. No table, column, policy,
-- data or grant on a table changes. Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.community_author_unbanned(p_workspace_id uuid, p_author_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public."community_workspace_bans" b
    WHERE b."workspace_id" = p_workspace_id
      AND b."user_id" = p_author_id
      AND b."lifted_at" IS NULL
  )
$fn$;
ALTER FUNCTION app.community_author_unbanned(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_author_unbanned(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_author_unbanned(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_author_unbanned(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_author_unbanned(uuid, text) IS
  '20270502008900: false while the person holds an active (not lifted) ban in that community; their words there then read for no one.';

COMMIT;
