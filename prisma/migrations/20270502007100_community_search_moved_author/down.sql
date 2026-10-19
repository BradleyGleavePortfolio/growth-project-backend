-- Reverse of 20270502007100_community_search_moved_author, for a confirmed
-- defect only: the restrictive read policy goes. A moved client's Hall and
-- space search rows then read in the former community again.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY "community_search_entries_author_stays" ON "community_search_entries";

COMMIT;
