-- Reverse of 20270502008900_community_ban_hides_words, for a confirmed defect
-- only. Deploy the API that no longer calls app.community_author_unbanned
-- first; then the function goes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION app.community_author_unbanned(uuid, text);

COMMIT;
