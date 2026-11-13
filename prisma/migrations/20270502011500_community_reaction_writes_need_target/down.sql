-- Reverse of 20270502011500_community_reaction_writes_need_target, for a confirmed defect only: at the row layer a
-- reaction row is again let in by community_responses_own_insert and community_responses_coach_all's WITH CHECK
-- alone, which never look at the target (a member outside a DM can file a reaction on it, the coach can file one
-- under another person's name or move one to any target). Drops the two RESTRICTIVE policies, then
-- app.community_response_target_open once no policy uses it. No read, no other policy and no data change.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY "community_responses_target_open_update" ON "community_responses";

DROP POLICY "community_responses_target_open_insert" ON "community_responses";

DROP FUNCTION app.community_response_target_open(uuid, "CommunityResponseTargetType", uuid, text);

COMMIT;
