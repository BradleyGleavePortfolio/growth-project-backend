-- Reverse of 20270502008900_community_ban_hides_words, for a confirmed defect
-- only. Deploy the API that no longer calls app.community_author_unbanned or
-- app.users_in_block first; then the policies go, then the functions.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "coach_message_no_block" ON "CoachMessage";
DROP POLICY IF EXISTS "community_search_entries_unbanned_unblocked" ON "community_search_entries";
DROP POLICY IF EXISTS "community_voice_notes_unbanned_unblocked" ON "community_voice_notes";
DROP POLICY IF EXISTS "community_posts_unbanned_unblocked" ON "community_posts";
DROP POLICY IF EXISTS "community_messages_unbanned_unblocked" ON "community_messages";
DROP FUNCTION app.users_in_block(text, text);
DROP FUNCTION app.community_author_unbanned(uuid, text);

COMMIT;
