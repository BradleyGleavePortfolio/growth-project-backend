-- BLOCK-ALL-BE (#168-4; #170-1 BAN-SCOPE: a ban covers the coach's whole
-- community): what a banned person wrote in a community no longer reads there
-- for anyone, and nobody reads the words of a person they are in a block with,
-- either way. The API (community-space-access.ts, the one shared place) asks
-- these functions, and FX-1141 makes them the database boundary too: RESTRICTIVE
-- SELECT policies on the four community word tables (messages, posts, voice
-- notes, search entries) and on "CoachMessage". Each answers one yes/no;
-- no row of the bans or UserBlock tables is exposed (their private policies
-- stay). No table, column, data or table grant changes. Reverse: down.sql.

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

-- True when the two people are in a block, either way. A signed-in caller may
-- only ask about a pair that includes them (else false), so it reveals no
-- third party's blocks; the person blocked already sees "{N} has blocked you"
-- (#169-5), so the yes/no tells them nothing new.
CREATE FUNCTION app.users_in_block(p_a text, p_b text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b
    AND (app.current_user_id() IS NULL OR app.current_user_id() IN (p_a, p_b))
    AND EXISTS (
      SELECT 1 FROM public."UserBlock" ub
      WHERE (ub."blocker_id" = p_a AND ub."blocked_id" = p_b)
         OR (ub."blocker_id" = p_b AND ub."blocked_id" = p_a)
    )
$fn$;
ALTER FUNCTION app.users_in_block(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.users_in_block(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.users_in_block(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.users_in_block(text, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.users_in_block(text, text) IS
  '20270502008900: true when the two are in a block either way; a signed-in caller gets false for a pair without them.';

-- RESTRICTIVE: ANDs with every permissive SELECT policy. The author always
-- reads their own row; nobody else reads a banned author's words in that
-- community, or the words of someone they are in a block with.
DROP POLICY IF EXISTS "community_messages_unbanned_unblocked" ON "community_messages";
CREATE POLICY "community_messages_unbanned_unblocked" ON "community_messages" AS RESTRICTIVE FOR SELECT TO public
  USING ("sender_id" = app.current_user_id() OR (app.community_author_unbanned("workspace_id", "sender_id")
         AND NOT app.users_in_block(app.current_user_id(), "sender_id")));

DROP POLICY IF EXISTS "community_posts_unbanned_unblocked" ON "community_posts";
CREATE POLICY "community_posts_unbanned_unblocked" ON "community_posts" AS RESTRICTIVE FOR SELECT TO public
  USING ("author_id" = app.current_user_id() OR (app.community_author_unbanned("workspace_id", "author_id")
         AND NOT app.users_in_block(app.current_user_id(), "author_id")));

DROP POLICY IF EXISTS "community_voice_notes_unbanned_unblocked" ON "community_voice_notes";
CREATE POLICY "community_voice_notes_unbanned_unblocked" ON "community_voice_notes" AS RESTRICTIVE FOR SELECT TO public
  USING ("author_id" = app.current_user_id() OR (app.community_author_unbanned("workspace_id", "author_id")
         AND NOT app.users_in_block(app.current_user_id(), "author_id")));

DROP POLICY IF EXISTS "community_search_entries_unbanned_unblocked" ON "community_search_entries";
CREATE POLICY "community_search_entries_unbanned_unblocked" ON "community_search_entries" AS RESTRICTIVE FOR SELECT TO public
  USING ("authorId" IS NULL OR "authorId"::text = app.current_user_id()
         OR (app.community_author_unbanned("workspaceId", "authorId"::text)
             AND NOT app.users_in_block(app.current_user_id(), "authorId"::text)));

-- A coaching chat in a block either way reads for neither person (owner rule
-- 10-22: hide all messaging). A party's own id never counts (p_a <> p_b).
DROP POLICY IF EXISTS "coach_message_no_block" ON "CoachMessage";
CREATE POLICY "coach_message_no_block" ON "CoachMessage" AS RESTRICTIVE FOR SELECT TO public
  USING (NOT app.users_in_block(app.current_user_id(), "client_id")
         AND NOT app.users_in_block(app.current_user_id(), "coach_id")
         AND NOT app.users_in_block(app.current_user_id(), "sender_id"));

COMMIT;
