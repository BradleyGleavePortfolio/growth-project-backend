-- Reverse of 20270502004600_community_space_kind, for a confirmed defect only:
-- the restrictive insert policy, the function, the two columns and their types
-- go. Every space is then an open chat again. No other rows change.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY "community_messages_space_takes_insert" ON "community_messages";

DROP FUNCTION app.community_can_post(uuid, text, boolean);

ALTER TABLE "community_cohorts" DROP COLUMN "posting_policy", DROP COLUMN "kind";

DROP TYPE "CommunityPostingPolicy";
DROP TYPE "CommunitySpaceKind";

COMMIT;
