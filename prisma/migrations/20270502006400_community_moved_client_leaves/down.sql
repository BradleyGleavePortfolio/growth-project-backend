-- Reverse of 20270502006400_community_moved_client_leaves, for a confirmed
-- defect only: the three restrictive read policies and the function go. A
-- moved client's Hall and space rows then read in the former community again.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY "community_voice_notes_author_stays" ON "community_voice_notes";
DROP POLICY "community_messages_author_stays" ON "community_messages";
DROP POLICY "community_posts_author_stays" ON "community_posts";

DROP FUNCTION app.community_author_stays(uuid, uuid, text);

COMMIT;
