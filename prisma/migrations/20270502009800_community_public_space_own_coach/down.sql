-- Reverse of 20270502009800_community_public_space_own_coach, for a confirmed defect only. Deploy the API
-- that no longer hands the poster's own coach their client's public-space rows first (rule D's second arm in
-- src/community/inbox/community-coach-inbox.repository.ts); then the policies go, then the function.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "community_voice_notes_public_own_coach" ON "community_voice_notes";
DROP POLICY IF EXISTS "community_posts_public_own_coach" ON "community_posts";
DROP POLICY IF EXISTS "community_messages_public_own_coach" ON "community_messages";
DROP FUNCTION app.community_public_row_of_my_client(uuid, text);

COMMIT;
