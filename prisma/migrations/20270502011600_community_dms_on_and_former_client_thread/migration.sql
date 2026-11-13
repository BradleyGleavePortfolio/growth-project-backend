-- COMMUNITY-DM-RULES-BE (owner #203-E49: "DECISIONS #203-D11 – Op 1" and "DECISIONS #203-D12 – allow maya to still
-- message the client and the client to message them"; operator rulings R-a to R-i, banner203.md 23:5x PST 11-12):
-- community direct messages are on by default in every community, and a coach and a former client keep messaging in
-- their existing DM thread while both stay in the community, at the row layer as at the API (one rule: the API asks
-- the same function through $queryRaw, src/community/community-access.service.ts formerClientsIn).
-- 1. D11 (R-d): the column default of community_workspaces.dm_enabled_default becomes true (prisma/schema.prisma
--    @default(true)), and every existing community whose stored default is false becomes true. No src path writes
--    that column (a false is the old column default, not a coach's choice). community_memberships.dm_enabled is not
--    touched: NULL inherits the community's default, an explicit false stays that person's own off. The UPDATE is
--    FORWARD-ONLY: down.sql restores the column default and leaves the rows true.
-- 2. New function app.community_dm_former_client(workspace, coach, client): true only when every input is not NULL,
--    the coach is the workspace's coach, the client is a different person whose role is student and whose coach is no
--    longer that coach (moved to another coach, or to none: the opposite of clientOf), the client is still in the
--    community (R-a: an active community_memberships row in a space of the workspace that is not public, not archived
--    and active, passing every other line of app.community_can_access (20270502010000) with only its roster test
--    lifted, the package line included; no row means no, never the rule's no-row arm), the client is not banned there
--    (no live community_workspace_bans row), and the pair already holds a DM thread there (R-b: a community_messages
--    row of scope dm between the two, either direction, deleted or not, matched on sender_id and recipient_user_id,
--    never by rebuilding dm_key). A block is not in it: the API asks assertDmAllowed and the row layer keeps its block
--    tests where they act today.
-- 3. New function app.community_dm_former_client_target(workspace, target_type, target_id, user) (R-f's second): true
--    only for a reaction on a 'message' target that is a community_messages row of scope dm of that workspace, the
--    user is its sender or its recipient, and the two are the pair of item 2 (either order). The two reaction policies
--    below share it, so each is limited to DM targets of which the user is a party.
-- 4. community_messages_author_stays (RESTRICTIVE FOR SELECT, 20270502006400) also passes a scope dm row whose
--    recipient is the caller and whose sender is the caller's former client by item 2: the coach reads what the former
--    client writes in their thread (R-c: owner rule 137-8 yields for this one thread only, newest wins).
-- 5. Three new PERMISSIVE policies (R-i: new, not ALTERs, so the suites that replay 20270502000200 and 20270502011400
--    still see the chain's state): community_messages_dm_former_client_insert (the pair inserts a scope dm row to each
--    other, sender the caller), community_responses_dm_former_client_select (the former client reads reactions on a DM
--    row of their thread) and community_responses_dm_former_client_insert (the former client inserts their own reaction
--    there). The coach needs no new reaction arm: community_responses_coach_all lets him in. Every RESTRICTIVE policy
--    still ANDs on top (community_messages_unbanned_unblocked, community_messages_space_takes_insert,
--    community_responses_target_open_insert).
-- 6. app.community_response_target_open (20270502011500, b#1248) is replaced: for a DM row its place test and its
--    author test also pass for the pair of item 2; every other line is as 20270502011500 wrote it.
-- Policy texts call only the two new functions and app.current_user_id() (and item 4 the app.community_author_stays it
-- already called), so a suite that replays an older down.sql dropping a helper with no CASCADE still can; the new
-- function bodies call no helper but the first one (a $fn$ body records no dependency). Both functions are SECURITY
-- DEFINER (owner postgres, which bypasses row security) because the caller's own row security would hide the rows they
-- read (a moved client's DM rows, the workspace bans); each answers yes or no and shows no row. Run rights:
-- authenticated and service_role, not PUBLIC or anon. The app connects as a role that bypasses row security, so the
-- policies bind any reader or writer that runs as authenticated with app.current_user_id set. No table, column, index,
-- table grant or other data changes. Reverse: down.sql (the data change of item 1 is forward-only). Live proof:
-- test/community-dm-rules-be-rls.spec.ts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "community_workspaces" ALTER COLUMN "dm_enabled_default" SET DEFAULT true;

UPDATE "community_workspaces" SET "dm_enabled_default" = true WHERE "dm_enabled_default" = false;

CREATE FUNCTION app.community_dm_former_client(p_workspace_id uuid, p_coach_id text, p_client_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT coalesce(p_workspace_id IS NOT NULL AND p_coach_id IS NOT NULL AND p_client_id IS NOT NULL
    AND p_client_id <> p_coach_id
    AND EXISTS (
      SELECT 1
      FROM public."community_workspaces" w
      JOIN public."User" u ON u."id" = p_client_id
      WHERE w."id" = p_workspace_id
        AND w."coach_id" = p_coach_id
        AND u."role" = 'student'
        AND u."coach_id" IS DISTINCT FROM w."coach_id"
        AND NOT EXISTS (SELECT 1 FROM public."community_workspace_bans" b
                        WHERE b."workspace_id" = w."id" AND b."user_id" = p_client_id AND b."lifted_at" IS NULL)
        AND EXISTS (
          SELECT 1
          FROM public."community_memberships" m
          JOIN public."community_cohorts" c ON c."id" = m."cohort_id"
          WHERE m."workspace_id" = w."id"
            AND m."user_id" = p_client_id
            AND m."status" = 'active'
            AND c."workspace_id" = w."id"
            AND c."visibility" <> 'public'
            AND c."archived_at" IS NULL
            AND c."status" = 'active'
            AND (m."role" <> 'student' OR c."visibility" <> 'package' OR EXISTS (
              SELECT 1
              FROM public."community_cohort_packages" l
              JOIN public."ClientPurchase" p ON p."package_id" = l."package_id"
              WHERE l."cohort_id" = c."id"
                AND p."client_user_id" = p_client_id
                AND p."coach_user_id" = w."coach_id"
                AND p."entitlement_active"
                AND NOT EXISTS (SELECT 1 FROM public."DunningState" d
                            WHERE d."purchase_id" = p."id" AND d."status" = 'active' AND d."locked_out_at" IS NOT NULL)
                AND (p."access_expires_at" IS NULL OR p."access_expires_at" > (now() AT TIME ZONE 'UTC')
                     OR (p."status" IN ('past_due', 'unpaid') AND EXISTS (SELECT 1 FROM public."DunningState" g
                            WHERE g."purchase_id" = p."id" AND g."status" = 'active' AND g."locked_out_at" IS NULL)))))
        )
        AND EXISTS (
          SELECT 1 FROM public."community_messages" t
          WHERE t."workspace_id" = w."id"
            AND t."scope" = 'dm'
            AND ((t."sender_id" = p_coach_id AND t."recipient_user_id" = p_client_id)
                 OR (t."sender_id" = p_client_id AND t."recipient_user_id" = p_coach_id))
        )
    ), false)
$fn$;
ALTER FUNCTION app.community_dm_former_client(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_dm_former_client(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_dm_former_client(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_dm_former_client(uuid, text, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_dm_former_client(uuid, text, text) IS
  '20270502011600 (203-D12): true only when the coach is the workspace coach and the client a student who is no longer that coach''s client, still in the community (an active row in a space that is not public, not archived and active, app.community_can_access but its roster test, no live ban), with a DM thread between the two there. DEFINER, so the caller''s row security cannot hide the rows it reads.';

CREATE FUNCTION app.community_dm_former_client_target(p_workspace_id uuid, p_target_type "CommunityResponseTargetType",
  p_target_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT coalesce(p_user_id IS NOT NULL AND p_target_type = 'message' AND EXISTS (
    SELECT 1 FROM public."community_messages" m
    WHERE m."id" = p_target_id
      AND m."workspace_id" = p_workspace_id
      AND m."scope" = 'dm'
      AND p_user_id IN (m."sender_id", m."recipient_user_id")
      AND (app.community_dm_former_client(p_workspace_id, m."sender_id", m."recipient_user_id")
           OR app.community_dm_former_client(p_workspace_id, m."recipient_user_id", m."sender_id"))
  ), false)
$fn$;
ALTER FUNCTION app.community_dm_former_client_target(uuid, "CommunityResponseTargetType", uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_dm_former_client_target(uuid, "CommunityResponseTargetType", uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_dm_former_client_target(uuid, "CommunityResponseTargetType", uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_dm_former_client_target(uuid, "CommunityResponseTargetType", uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_dm_former_client_target(uuid, "CommunityResponseTargetType", uuid, text) IS
  '20270502011600 (203-D12): true only for a message target that is a DM row of that workspace, of which the user is the sender or the recipient, between a coach and a former client app.community_dm_former_client lets keep their thread. DEFINER, so the caller''s row security cannot hide the target.';

ALTER POLICY "community_messages_author_stays" ON "community_messages"
  USING ("sender_id" = app.current_user_id() OR app.community_author_stays("workspace_id", "cohort_id", "sender_id")
         OR ("scope" = 'dm' AND "recipient_user_id" = app.current_user_id()
             AND app.community_dm_former_client("workspace_id", app.current_user_id(), "sender_id")));

CREATE POLICY "community_messages_dm_former_client_insert" ON "community_messages" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("scope" = 'dm' AND "sender_id" = app.current_user_id()
              AND (app.community_dm_former_client("workspace_id", "sender_id", "recipient_user_id")
                   OR app.community_dm_former_client("workspace_id", "recipient_user_id", "sender_id")));
COMMENT ON POLICY "community_messages_dm_former_client_insert" ON "community_messages" IS
  '20270502011600 (203-D12): permissive. A coach and a former client app.community_dm_former_client lets keep their thread insert a DM row to each other under their own name.';

CREATE POLICY "community_responses_dm_former_client_select" ON "community_responses" AS PERMISSIVE FOR SELECT TO public
  USING (app.community_dm_former_client_target("workspace_id", "target_type", "target_id", app.current_user_id()));
COMMENT ON POLICY "community_responses_dm_former_client_select" ON "community_responses" IS
  '20270502011600 (203-D12): permissive. A former client reads the reactions on a DM row of their kept thread with the coach.';

CREATE POLICY "community_responses_dm_former_client_insert" ON "community_responses" AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ("user_id" = app.current_user_id()
              AND app.community_dm_former_client_target("workspace_id", "target_type", "target_id", "user_id"));
COMMENT ON POLICY "community_responses_dm_former_client_insert" ON "community_responses" IS
  '20270502011600 (203-D12): permissive. A former client inserts their own reaction on a DM row of their kept thread with the coach. community_responses_target_open_insert still ANDs on top.';

CREATE OR REPLACE FUNCTION app.community_response_target_open(p_workspace_id uuid, p_target_type "CommunityResponseTargetType",
  p_target_id uuid, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT coalesce(p_user_id IS NOT NULL AND p_workspace_id IS NOT NULL AND (
    (p_target_type IN ('message', 'comment') AND EXISTS (
      SELECT 1 FROM public."community_messages" m
      WHERE m."id" = p_target_id
        AND m."workspace_id" = p_workspace_id
        AND m."deleted_at" IS NULL
        AND coalesce(m."plan_context_type" = 'community_post_comment', false) = (p_target_type = 'comment')
        AND CASE WHEN m."cohort_id" IS NOT NULL THEN app.community_can_access(m."cohort_id", p_user_id)
                 ELSE (app.community_workspace_open(p_workspace_id, p_user_id)
                       OR (p_user_id = app.current_user_id() AND app.is_community_workspace_coach(p_workspace_id))
                       OR (m."scope" = 'dm'
                           AND (app.community_dm_former_client(p_workspace_id, m."sender_id", m."recipient_user_id")
                                OR app.community_dm_former_client(p_workspace_id, m."recipient_user_id", m."sender_id")))) END
        AND (m."sender_id" = p_user_id
             OR (app.community_author_stays(p_workspace_id, m."cohort_id", m."sender_id")
                 AND app.community_author_unbanned(p_workspace_id, m."sender_id")
                 AND NOT app.users_in_block(p_user_id, m."sender_id"))
             OR (m."scope" = 'dm'
                 AND (app.community_dm_former_client(p_workspace_id, m."sender_id", m."recipient_user_id")
                      OR app.community_dm_former_client(p_workspace_id, m."recipient_user_id", m."sender_id"))
                 AND NOT app.users_in_block(p_user_id, m."sender_id")))
        AND (m."scope" <> 'dm'
             OR (p_user_id IN (m."sender_id", m."recipient_user_id")
                 AND NOT app.users_in_block(m."sender_id", m."recipient_user_id")))
    ))
    OR (p_target_type = 'post' AND EXISTS (
      SELECT 1 FROM public."community_posts" p
      WHERE p."id" = p_target_id
        AND p."workspace_id" = p_workspace_id
        AND p."deleted_at" IS NULL
        AND CASE WHEN p."cohort_id" IS NOT NULL THEN app.community_can_access(p."cohort_id", p_user_id)
                 ELSE (app.community_workspace_open(p_workspace_id, p_user_id)
                       OR (p_user_id = app.current_user_id() AND app.is_community_workspace_coach(p_workspace_id))) END
        AND (p."author_id" = p_user_id
             OR (app.community_author_stays(p_workspace_id, p."cohort_id", p."author_id")
                 AND app.community_author_unbanned(p_workspace_id, p."author_id")
                 AND NOT app.users_in_block(p_user_id, p."author_id")))
    ))
  ), false)
$fn$;
ALTER FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text) IS
  '20270502011600: true only when the user may make this reaction as the API would: a live message, comment or post of that workspace, a place the user may open, an author who stays, is not banned and is not in a block with the user, and for a DM one of its two people while they are not in a block. For a DM between a coach and a former client app.community_dm_former_client lets keep their thread (203-D12), that pair also passes the place and author tests. False for event, challenge, a missing row and any NULL. DEFINER, so the caller''s row security cannot hide the target.';

COMMIT;
