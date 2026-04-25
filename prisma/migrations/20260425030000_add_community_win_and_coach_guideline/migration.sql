-- Tier-2 (Fix #9): Promote two previously-faked features to real models.
--
--   1. CommunityWin — `community.postWin` was a no-op stub returning a
--      hard-coded message; `community.getFeed` returned recent Lessons (which
--      also surfaced the per-client Lesson hack used for guidelines). This
--      table backs both POST /community/wins and GET /community/feed with
--      real, coach-scoped rows.
--
--   2. CoachGuideline — `coach.postGuidelines` was inserting a Lesson row
--      tagged `client:<id>` and `coach.getGuidelines` was filtering Lessons
--      by that tag. That conflated per-client guidelines with the public
--      Lesson library and leaked private guidelines into the community feed.
--      Replaced with a dedicated table; one guidelines doc per (coach,client)
--      enforced by a unique index → POST becomes an idempotent upsert.
--
-- All changes are additive: no existing tables modified, no data migrated,
-- no destructive rewrites. Pre-existing Lesson rows tagged `client:*` are
-- LEFT IN PLACE (harmless data) but are no longer read or written by the
-- app — community.getFeed now reads CommunityWin, coach.getGuidelines now
-- reads CoachGuideline. A follow-up cleanup migration can DELETE FROM
-- "Lesson" WHERE 'client:%' = ANY(tags) once we are sure no consumer depends
-- on those rows; deferred for safety.

-- -----------------------------------------------------------------
-- 1. CommunityWin table
-- -----------------------------------------------------------------

CREATE TABLE "CommunityWin" (
    "id"          TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "coach_id"    TEXT,
    "title"       TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityWin_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommunityWin_user_id_idx" ON "CommunityWin"("user_id");
CREATE INDEX "CommunityWin_coach_id_created_at_idx"
    ON "CommunityWin"("coach_id", "created_at");

ALTER TABLE "CommunityWin"
    ADD CONSTRAINT "CommunityWin_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunityWin"
    ADD CONSTRAINT "CommunityWin_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------
-- 2. CoachGuideline table
-- -----------------------------------------------------------------

CREATE TABLE "CoachGuideline" (
    "id"         TEXT NOT NULL,
    "coach_id"   TEXT NOT NULL,
    "client_id"  TEXT NOT NULL,
    "content"    TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachGuideline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachGuideline_coach_id_client_id_key"
    ON "CoachGuideline"("coach_id", "client_id");
CREATE INDEX "CoachGuideline_client_id_idx" ON "CoachGuideline"("client_id");

ALTER TABLE "CoachGuideline"
    ADD CONSTRAINT "CoachGuideline_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoachGuideline"
    ADD CONSTRAINT "CoachGuideline_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
