-- C6-MOVED-SEARCH (agent 160; owner: history always follows the client, a
-- former coach loses every read of a moved client): the search index follows
-- the same rule as the rows it points at (20270502006400). A client who moved
-- to another coach, or to none, is not found in the former coach's Hall or in
-- its spaces that are not public, by anyone but themselves. Public spaces stay
-- public. The API search query asks the same function. No column, data or
-- grant changes. Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- RESTRICTIVE: ANDs with the coach's FOR ALL policy and the member read policy.
DROP POLICY IF EXISTS "community_search_entries_author_stays" ON "community_search_entries";
CREATE POLICY "community_search_entries_author_stays" ON "community_search_entries" AS RESTRICTIVE FOR SELECT TO public
  USING ("authorId"::text = app.current_user_id() OR app.community_author_stays("workspaceId", "cohortId", "authorId"::text));

COMMIT;
