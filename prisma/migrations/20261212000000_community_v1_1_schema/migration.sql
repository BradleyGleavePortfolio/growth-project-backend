-- Community Expansion v1-1 — workspace + cohorts + messages + posts +
-- responses + events + challenges + moderation foundation.
--
-- Ships SCHEMA ONLY behind FEATURE_COMMUNITY_SCHEMA (default true after this
-- migration deploys to staging). No controllers / services land until v1-2's
-- FEATURE_COMMUNITY_API. See _community_execution_plan.md PR v1-1 (lines
-- 216-226) and the model spec (lines 492-779).
--
-- This migration is HAND-AUTHORED rather than fully `prisma migrate dev`
-- generated because `community_messages` uses Postgres native RANGE
-- partitioning (monthly partitions by created_at) which Prisma's schema
-- language cannot express. Every non-partitioned table's DDL matches what
-- `prisma migrate diff` produces from prisma/schema.prisma; the partitioned
-- table is created explicitly here with the same columns + composite PK
-- (id, created_at) that the Prisma model declares via @@id([id, created_at]).
--
-- RLS convention: this repo authenticates RLS via app.current_user_id()
-- (TEXT session GUC set by the NestJS layer) — NOT Supabase auth.uid(). See
-- prisma/migrations/rls_fitness_backend.sql. The planner spec mentioned
-- auth.uid(); we deliberately follow the in-repo helper so these policies are
-- testable with the same SET LOCAL harness used by the existing fitness RLS.
-- Flagged for the auditor: app.current_user_id() is the canonical helper.

-- CreateEnum
CREATE TYPE "CommunityCohortStatus" AS ENUM ('draft', 'active', 'archived');
-- CreateEnum
CREATE TYPE "CommunityMembershipRole" AS ENUM ('coach', 'assistant', 'student');
-- CreateEnum
CREATE TYPE "CommunityMembershipStatus" AS ENUM ('invited', 'active', 'muted', 'removed');
-- CreateEnum
CREATE TYPE "CommunityMessageScope" AS ENUM ('cohort', 'dm');
-- CreateEnum
CREATE TYPE "CommunityMessageKind" AS ENUM ('text', 'voice', 'system');
-- CreateEnum
CREATE TYPE "CommunityPostScope" AS ENUM ('hall', 'cohort');
-- CreateEnum
CREATE TYPE "CommunityPostType" AS ENUM ('text', 'lesson', 'replay', 'poll', 'win');
-- CreateEnum
CREATE TYPE "CommunityResponseTargetType" AS ENUM ('message', 'post', 'comment', 'event', 'challenge');
-- CreateEnum
CREATE TYPE "CommunityEventState" AS ENUM ('scheduled', 'tomorrow', 'live', 'replay', 'reflected');
-- CreateEnum
CREATE TYPE "CommunityEventRsvpStatus" AS ENUM ('going', 'maybe', 'declined', 'attended', 'missed');
-- CreateEnum
CREATE TYPE "CommunityChallengeStatus" AS ENUM ('draft', 'active', 'completed', 'archived');
-- CreateEnum
CREATE TYPE "CommunityModerationTargetType" AS ENUM ('message', 'post', 'reaction', 'event', 'challenge', 'member');
-- CreateEnum
CREATE TYPE "CommunityModerationStatus" AS ENUM ('open', 'reviewed', 'actioned', 'dismissed');

-- CreateTable
CREATE TABLE "community_workspaces" (
    "id" UUID NOT NULL,
    "coach_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "dm_enabled_default" BOOLEAN NOT NULL DEFAULT false,
    "hall_enabled" BOOLEAN NOT NULL DEFAULT true,
    "events_enabled" BOOLEAN NOT NULL DEFAULT false,
    "challenges_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_cohort_members" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_cohorts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "status" "CommunityCohortStatus" NOT NULL DEFAULT 'active',
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "capacity" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_memberships" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "CommunityMembershipRole" NOT NULL DEFAULT 'student',
    "status" "CommunityMembershipStatus" NOT NULL DEFAULT 'active',
    "dm_enabled" BOOLEAN,
    "notify_level" VARCHAR(32) NOT NULL DEFAULT 'digest',
    "joined_at" TIMESTAMPTZ(6),
    "last_read_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable — community_messages is RANGE-partitioned by created_at.
-- The composite primary key (id, created_at) is required: Postgres demands
-- the partition key be part of every unique constraint on a partitioned
-- table. The CHECK enforces the scope invariant from the spec — a cohort
-- message carries a cohort_id and no dm_key; a DM carries a dm_key and no
-- cohort_id.
CREATE TABLE "community_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID,
    "scope" "CommunityMessageScope" NOT NULL,
    "dm_key" VARCHAR(160),
    "recipient_user_id" TEXT,
    "sender_id" TEXT NOT NULL,
    "kind" "CommunityMessageKind" NOT NULL DEFAULT 'text',
    "body" VARCHAR(4000),
    "voice_url" TEXT,
    "voice_duration_ms" INTEGER,
    "voice_mime_type" VARCHAR(80),
    "voice_size_bytes" INTEGER,
    "plan_context_type" VARCHAR(40),
    "plan_context_id" UUID,
    "plan_week_start" DATE,
    "parent_message_id" UUID,
    "parent_message_at" TIMESTAMPTZ(6),
    "coach_seen_at" TIMESTAMPTZ(6),
    "coach_acked_at" TIMESTAMPTZ(6),
    "coach_replied_at" TIMESTAMPTZ(6),
    "visibility" VARCHAR(24) NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "community_messages_pkey" PRIMARY KEY ("id", "created_at"),
    CONSTRAINT "community_messages_scope_shape_check" CHECK (
        ("scope" = 'cohort' AND "cohort_id" IS NOT NULL AND "dm_key" IS NULL)
        OR ("scope" = 'dm' AND "cohort_id" IS NULL AND "dm_key" IS NOT NULL)
    )
) PARTITION BY RANGE ("created_at");

-- Initial monthly partitions: current month (2026-12) + next two months
-- (2027-01, 2027-02). The DEFAULT partition catches any row outside the
-- explicit ranges so inserts never fail before the ops job provisions the
-- next month. See community_messages_create_month_partition() below + the
-- monthly partition job tracked for the ops PR.
CREATE TABLE "community_messages_2026_12" PARTITION OF "community_messages"
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "community_messages_2027_01" PARTITION OF "community_messages"
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "community_messages_2027_02" PARTITION OF "community_messages"
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "community_messages_default" PARTITION OF "community_messages" DEFAULT;

-- Helper to provision a future monthly partition idempotently. The monthly
-- ops job (tracked for the ops PR; see partition note in the RLS plan) calls
-- this with the first day of the target month. Indexes declared on the parent
-- propagate to partitions automatically (Postgres 11+), so the new partition
-- inherits every community_messages_* index and the parent RLS policies.
CREATE OR REPLACE FUNCTION community_messages_create_month_partition(p_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month)::date;
  v_end   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
  v_name  TEXT := 'community_messages_' || to_char(v_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "community_messages" FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );
  RETURN v_name;
END;
$$;

COMMENT ON FUNCTION community_messages_create_month_partition(DATE) IS
  'Idempotently provisions the monthly community_messages partition covering p_month; called by the monthly partition ops job. Inherited indexes + parent RLS apply automatically.';

-- CreateTable
CREATE TABLE "community_posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID,
    "author_id" TEXT NOT NULL,
    "scope" "CommunityPostScope" NOT NULL,
    "type" "CommunityPostType" NOT NULL DEFAULT 'text',
    "title" VARCHAR(160),
    "body" TEXT,
    "media_asset_id" UUID,
    "event_id" UUID,
    "pinned_at" TIMESTAMPTZ(6),
    "release_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "visibility" VARCHAR(24) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_responses" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "target_type" "CommunityResponseTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "target_created_at" TIMESTAMPTZ(6),
    "user_id" TEXT NOT NULL,
    "response_kind" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID,
    "created_by_id" TEXT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "state" "CommunityEventState" NOT NULL DEFAULT 'scheduled',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "live_url" TEXT,
    "replay_media_asset_id" UUID,
    "reflected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "canceled_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_event_rsvps" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "CommunityEventRsvpStatus" NOT NULL,
    "reminded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "community_event_rsvps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_challenges" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID,
    "created_by_id" TEXT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "CommunityChallengeStatus" NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "metric_key" VARCHAR(80),
    "target_value" DECIMAL(12,2),
    "unit" VARCHAR(40),
    "leaderboard_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_challenge_participations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "progress_value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "last_logged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "community_challenge_participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_moderation_actions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "target_type" "CommunityModerationTargetType" NOT NULL,
    "target_id" UUID NOT NULL,
    "reported_by_id" TEXT,
    "actor_id" TEXT,
    "status" "CommunityModerationStatus" NOT NULL DEFAULT 'open',
    "reason" VARCHAR(80) NOT NULL,
    "notes" TEXT,
    "action" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "community_workspaces_slug_key" ON "community_workspaces"("slug");
CREATE INDEX "community_workspaces_coach_id_archived_at_idx" ON "community_workspaces"("coach_id", "archived_at");
CREATE INDEX "community_workspaces_created_at_idx" ON "community_workspaces"("created_at");
CREATE INDEX "community_cohorts_workspace_id_status_sort_order_idx" ON "community_cohorts"("workspace_id", "status", "sort_order");
CREATE INDEX "community_cohorts_workspace_id_archived_at_idx" ON "community_cohorts"("workspace_id", "archived_at");
CREATE UNIQUE INDEX "community_cohorts_workspace_id_name_key" ON "community_cohorts"("workspace_id", "name");
CREATE INDEX "community_memberships_workspace_id_user_id_status_idx" ON "community_memberships"("workspace_id", "user_id", "status");
CREATE INDEX "community_memberships_user_id_status_idx" ON "community_memberships"("user_id", "status");
CREATE INDEX "community_memberships_cohort_id_status_role_idx" ON "community_memberships"("cohort_id", "status", "role");
CREATE UNIQUE INDEX "community_memberships_cohort_id_user_id_key" ON "community_memberships"("cohort_id", "user_id");

-- CreateIndex — declared on the partitioned parent so they propagate to every
-- current and future community_messages_* partition.
CREATE INDEX "community_messages_workspace_id_created_at_idx" ON "community_messages"("workspace_id", "created_at");
CREATE INDEX "community_messages_cohort_id_created_at_idx" ON "community_messages"("cohort_id", "created_at");
CREATE INDEX "community_messages_dm_key_created_at_idx" ON "community_messages"("dm_key", "created_at");
CREATE INDEX "community_messages_recipient_user_id_created_at_idx" ON "community_messages"("recipient_user_id", "created_at");
CREATE INDEX "community_messages_sender_id_created_at_idx" ON "community_messages"("sender_id", "created_at");
CREATE INDEX "community_messages_workspace_id_plan_context_type_plan_cont_idx" ON "community_messages"("workspace_id", "plan_context_type", "plan_context_id");
CREATE INDEX "community_messages_workspace_id_visibility_created_at_idx" ON "community_messages"("workspace_id", "visibility", "created_at");

-- CreateIndex
CREATE INDEX "community_posts_workspace_id_scope_pinned_at_created_at_idx" ON "community_posts"("workspace_id", "scope", "pinned_at", "created_at");
CREATE INDEX "community_posts_cohort_id_created_at_idx" ON "community_posts"("cohort_id", "created_at");
CREATE INDEX "community_posts_workspace_id_release_at_idx" ON "community_posts"("workspace_id", "release_at");
CREATE INDEX "community_posts_workspace_id_visibility_created_at_idx" ON "community_posts"("workspace_id", "visibility", "created_at");
CREATE INDEX "community_responses_workspace_id_target_type_target_id_idx" ON "community_responses"("workspace_id", "target_type", "target_id");
CREATE INDEX "community_responses_user_id_created_at_idx" ON "community_responses"("user_id", "created_at");
CREATE UNIQUE INDEX "community_responses_target_type_target_id_user_id_response_kind_key" ON "community_responses"("target_type", "target_id", "user_id", "response_kind");
CREATE INDEX "community_events_workspace_id_state_starts_at_idx" ON "community_events"("workspace_id", "state", "starts_at");
CREATE INDEX "community_events_cohort_id_starts_at_idx" ON "community_events"("cohort_id", "starts_at");
CREATE INDEX "community_events_starts_at_idx" ON "community_events"("starts_at");
CREATE INDEX "community_event_rsvps_workspace_id_user_id_status_idx" ON "community_event_rsvps"("workspace_id", "user_id", "status");
CREATE INDEX "community_event_rsvps_workspace_id_status_reminded_at_idx" ON "community_event_rsvps"("workspace_id", "status", "reminded_at");
CREATE UNIQUE INDEX "community_event_rsvps_event_id_user_id_key" ON "community_event_rsvps"("event_id", "user_id");
CREATE INDEX "community_challenges_workspace_id_status_starts_at_idx" ON "community_challenges"("workspace_id", "status", "starts_at");
CREATE INDEX "community_challenges_cohort_id_status_idx" ON "community_challenges"("cohort_id", "status");
CREATE INDEX "community_challenge_participations_workspace_id_user_id_idx" ON "community_challenge_participations"("workspace_id", "user_id");
CREATE INDEX "community_challenge_participations_challenge_id_progress_va_idx" ON "community_challenge_participations"("challenge_id", "progress_value");
CREATE UNIQUE INDEX "community_challenge_participations_challenge_id_user_id_key" ON "community_challenge_participations"("challenge_id", "user_id");
CREATE INDEX "community_moderation_actions_workspace_id_status_created_at_idx" ON "community_moderation_actions"("workspace_id", "status", "created_at");
CREATE INDEX "community_moderation_actions_target_type_target_id_idx" ON "community_moderation_actions"("target_type", "target_id");
CREATE INDEX "community_moderation_actions_reported_by_id_created_at_idx" ON "community_moderation_actions"("reported_by_id", "created_at");

-- AddForeignKey
ALTER TABLE "community_workspaces" ADD CONSTRAINT "community_workspaces_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_cohorts" ADD CONSTRAINT "community_cohorts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_responses" ADD CONSTRAINT "community_responses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_responses" ADD CONSTRAINT "community_responses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_events" ADD CONSTRAINT "community_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_event_rsvps" ADD CONSTRAINT "community_event_rsvps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_event_rsvps" ADD CONSTRAINT "community_event_rsvps_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "community_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_event_rsvps" ADD CONSTRAINT "community_event_rsvps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_challenge_participations" ADD CONSTRAINT "community_challenge_participations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_challenge_participations" ADD CONSTRAINT "community_challenge_participations_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "community_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_challenge_participations" ADD CONSTRAINT "community_challenge_participations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ------------------------------------------------------------
-- Every community table enables + forces RLS. Production runtime uses the
-- Supabase service_role (BYPASSRLS) so the NestJS service layer remains the
-- primary tenant guard; these policies are defense-in-depth for direct
-- dashboard / anon / authenticated key access and are exercised by
-- test/community/rls/community-rls.spec.ts via SET LOCAL app.current_user_id.
--
-- Helper functions live in the `app` schema (created by
-- rls_fitness_backend.sql; re-created here idempotently so this migration is
-- self-contained on a fresh disposable test DB):
--   app.current_user_id()                       -> the authenticated User.id
--   app.is_community_workspace_coach(workspace)  -> caller owns the workspace
--   app.is_community_workspace_member(workspace) -> caller has an active membership
--   app.shares_community_cohort(cohort)          -> caller has an active membership in that cohort
-- All compare User.id as TEXT (Prisma stores UUIDs as text on User.id);
-- community.*_id columns are uuid, so we cast uuid::text for comparison.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'Returns the NestJS-authenticated User.id stored in app.current_user_id for RLS policies; NULL means unauthenticated/no tenant context.';

-- Caller is the owning coach of the workspace.
CREATE OR REPLACE FUNCTION app.is_community_workspace_coach(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "community_workspaces" w
    WHERE w."id" = p_workspace_id
      AND w."coach_id"::text = app.current_user_id()
  )
$$;

-- Caller holds a non-removed membership in the workspace.
CREATE OR REPLACE FUNCTION app.is_community_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "community_memberships" m
    WHERE m."workspace_id" = p_workspace_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$$;

-- Caller shares the given cohort via a non-removed membership.
CREATE OR REPLACE FUNCTION app.shares_community_cohort(p_cohort_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "community_memberships" m
    WHERE m."cohort_id" = p_cohort_id
      AND m."user_id"::text = app.current_user_id()
      AND m."status" <> 'removed'
  )
$$;

GRANT USAGE ON SCHEMA app TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_community_workspace_coach(uuid) TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.is_community_workspace_member(uuid) TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.shares_community_cohort(uuid) TO service_role, anon, authenticated;

-- Enable + force RLS on all 11 logical tables.
ALTER TABLE "community_workspaces"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_workspaces"                FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_cohorts"                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_cohorts"                   FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_memberships"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_memberships"               FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_messages"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_messages"                  FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_posts"                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_posts"                     FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_responses"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_responses"                 FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_events"                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_events"                    FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_event_rsvps"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_event_rsvps"               FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_challenges"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_challenges"                FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_challenge_participations"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_challenge_participations"  FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_moderation_actions"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_moderation_actions"        FORCE ROW LEVEL SECURITY;

-- community_workspaces: coach (owner) can do everything on their workspace;
-- active members can SELECT it. Split into a coach ALL policy and a member
-- SELECT policy (PERMISSIVE — Postgres ORs them).
DROP POLICY IF EXISTS "community_workspaces_coach_all" ON "community_workspaces";
CREATE POLICY "community_workspaces_coach_all" ON "community_workspaces"
  FOR ALL TO public
  USING ("coach_id"::text = app.current_user_id())
  WITH CHECK ("coach_id"::text = app.current_user_id());

DROP POLICY IF EXISTS "community_workspaces_member_select" ON "community_workspaces";
CREATE POLICY "community_workspaces_member_select" ON "community_workspaces"
  FOR SELECT TO public
  USING (app.is_community_workspace_member("id"));

-- community_cohorts: workspace owner ALL; active members SELECT cohorts they
-- belong to (the membership FK is the source of truth, not workspace-wide).
DROP POLICY IF EXISTS "community_cohorts_coach_all" ON "community_cohorts";
CREATE POLICY "community_cohorts_coach_all" ON "community_cohorts"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_cohorts_member_select" ON "community_cohorts";
CREATE POLICY "community_cohorts_member_select" ON "community_cohorts"
  FOR SELECT TO public
  USING (app.shares_community_cohort("id"));

-- community_memberships: workspace owner ALL; members SELECT their own row and
-- rows of peers in a cohort they share. Members cannot mutate their own role
-- or status — only the coach ALL policy permits writes.
DROP POLICY IF EXISTS "community_memberships_coach_all" ON "community_memberships";
CREATE POLICY "community_memberships_coach_all" ON "community_memberships"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_memberships_self_or_shared_cohort_select" ON "community_memberships";
CREATE POLICY "community_memberships_self_or_shared_cohort_select" ON "community_memberships"
  FOR SELECT TO public
  USING (
    "user_id"::text = app.current_user_id()
    OR app.shares_community_cohort("cohort_id")
  );

-- community_messages: workspace owner SELECTs all workspace messages; cohort
-- members SELECT cohort messages for cohorts they share; DM parties SELECT
-- their own DMs. Author can UPDATE/DELETE own. Inserts require the caller be
-- the sender AND (coach, shared-cohort member for cohort scope, or a DM party
-- for dm scope).
DROP POLICY IF EXISTS "community_messages_select" ON "community_messages";
CREATE POLICY "community_messages_select" ON "community_messages"
  FOR SELECT TO public
  USING (
    app.is_community_workspace_coach("workspace_id")
    OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
    OR ("scope" = 'dm' AND (
          "sender_id"::text = app.current_user_id()
          OR "recipient_user_id"::text = app.current_user_id()
       ))
  );

DROP POLICY IF EXISTS "community_messages_author_insert" ON "community_messages";
CREATE POLICY "community_messages_author_insert" ON "community_messages"
  FOR INSERT TO public
  WITH CHECK (
    "sender_id"::text = app.current_user_id()
    AND (
      app.is_community_workspace_coach("workspace_id")
      OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
      OR ("scope" = 'dm' AND "recipient_user_id" IS NOT NULL)
    )
  );

DROP POLICY IF EXISTS "community_messages_author_update" ON "community_messages";
CREATE POLICY "community_messages_author_update" ON "community_messages"
  FOR UPDATE TO public
  USING (
    "sender_id"::text = app.current_user_id()
    OR app.is_community_workspace_coach("workspace_id")
  )
  WITH CHECK (
    "sender_id"::text = app.current_user_id()
    OR app.is_community_workspace_coach("workspace_id")
  );

DROP POLICY IF EXISTS "community_messages_author_delete" ON "community_messages";
CREATE POLICY "community_messages_author_delete" ON "community_messages"
  FOR DELETE TO public
  USING (
    "sender_id"::text = app.current_user_id()
    OR app.is_community_workspace_coach("workspace_id")
  );

-- community_posts: workspace owner ALL; members SELECT released hall posts and
-- released cohort posts for cohorts they share. release_at NULL means publish
-- immediately; a future release_at hides the post from members until then.
DROP POLICY IF EXISTS "community_posts_coach_all" ON "community_posts";
CREATE POLICY "community_posts_coach_all" ON "community_posts"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_posts_member_select" ON "community_posts";
CREATE POLICY "community_posts_member_select" ON "community_posts"
  FOR SELECT TO public
  USING (
    ("release_at" IS NULL OR "release_at" <= now())
    AND "visibility" = 'active'
    AND (
      ("scope" = 'hall' AND app.is_community_workspace_member("workspace_id"))
      OR ("scope" = 'cohort' AND app.shares_community_cohort("cohort_id"))
    )
  );

-- community_responses: workspace owner ALL; users SELECT responses in a
-- workspace they belong to; users INSERT/DELETE only their own response.
DROP POLICY IF EXISTS "community_responses_coach_all" ON "community_responses";
CREATE POLICY "community_responses_coach_all" ON "community_responses"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_responses_member_select" ON "community_responses";
CREATE POLICY "community_responses_member_select" ON "community_responses"
  FOR SELECT TO public
  USING (app.is_community_workspace_member("workspace_id"));

DROP POLICY IF EXISTS "community_responses_own_insert" ON "community_responses";
CREATE POLICY "community_responses_own_insert" ON "community_responses"
  FOR INSERT TO public
  WITH CHECK (
    "user_id"::text = app.current_user_id()
    AND app.is_community_workspace_member("workspace_id")
  );

DROP POLICY IF EXISTS "community_responses_own_delete" ON "community_responses";
CREATE POLICY "community_responses_own_delete" ON "community_responses"
  FOR DELETE TO public
  USING ("user_id"::text = app.current_user_id());

-- community_events: workspace owner ALL; members SELECT events for cohorts
-- they share or workspace-wide (hall / Lab) events (cohort_id NULL).
DROP POLICY IF EXISTS "community_events_coach_all" ON "community_events";
CREATE POLICY "community_events_coach_all" ON "community_events"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_events_member_select" ON "community_events";
CREATE POLICY "community_events_member_select" ON "community_events"
  FOR SELECT TO public
  USING (
    ("cohort_id" IS NULL AND app.is_community_workspace_member("workspace_id"))
    OR ("cohort_id" IS NOT NULL AND app.shares_community_cohort("cohort_id"))
  );

-- community_event_rsvps: workspace owner SELECTs all; users manage their own
-- RSVP row only.
DROP POLICY IF EXISTS "community_event_rsvps_coach_select" ON "community_event_rsvps";
CREATE POLICY "community_event_rsvps_coach_select" ON "community_event_rsvps"
  FOR SELECT TO public
  USING (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_event_rsvps_own_all" ON "community_event_rsvps";
CREATE POLICY "community_event_rsvps_own_all" ON "community_event_rsvps"
  FOR ALL TO public
  USING ("user_id"::text = app.current_user_id())
  WITH CHECK (
    "user_id"::text = app.current_user_id()
    AND app.is_community_workspace_member("workspace_id")
  );

-- community_challenges: workspace owner ALL; members SELECT challenges for
-- cohorts they share or workspace-wide challenges (cohort_id NULL).
DROP POLICY IF EXISTS "community_challenges_coach_all" ON "community_challenges";
CREATE POLICY "community_challenges_coach_all" ON "community_challenges"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_challenges_member_select" ON "community_challenges";
CREATE POLICY "community_challenges_member_select" ON "community_challenges"
  FOR SELECT TO public
  USING (
    ("cohort_id" IS NULL AND app.is_community_workspace_member("workspace_id"))
    OR ("cohort_id" IS NOT NULL AND app.shares_community_cohort("cohort_id"))
  );

-- community_challenge_participations: workspace owner SELECTs all workspace
-- progress; users manage their own participation row only.
DROP POLICY IF EXISTS "community_challenge_participations_coach_select" ON "community_challenge_participations";
CREATE POLICY "community_challenge_participations_coach_select" ON "community_challenge_participations"
  FOR SELECT TO public
  USING (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_challenge_participations_own_all" ON "community_challenge_participations";
CREATE POLICY "community_challenge_participations_own_all" ON "community_challenge_participations"
  FOR ALL TO public
  USING ("user_id"::text = app.current_user_id())
  WITH CHECK (
    "user_id"::text = app.current_user_id()
    AND app.is_community_workspace_member("workspace_id")
  );

-- community_moderation_actions: workspace owner / coach manages everything
-- (including resolving + reading moderator notes). Reporters may create a
-- report for their workspace and SELECT only their own filed reports — they
-- never see moderator notes of others' reports.
DROP POLICY IF EXISTS "community_moderation_actions_coach_all" ON "community_moderation_actions";
CREATE POLICY "community_moderation_actions_coach_all" ON "community_moderation_actions"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_moderation_actions_reporter_insert" ON "community_moderation_actions";
CREATE POLICY "community_moderation_actions_reporter_insert" ON "community_moderation_actions"
  FOR INSERT TO public
  WITH CHECK (
    "reported_by_id"::text = app.current_user_id()
    AND app.is_community_workspace_member("workspace_id")
  );

DROP POLICY IF EXISTS "community_moderation_actions_reporter_select" ON "community_moderation_actions";
CREATE POLICY "community_moderation_actions_reporter_select" ON "community_moderation_actions"
  FOR SELECT TO public
  USING ("reported_by_id"::text = app.current_user_id());
