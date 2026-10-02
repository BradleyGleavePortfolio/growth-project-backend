-- Community reports for voice notes and member wins (App Review 1.2).
--
-- 1. CommunityModerationTargetType gains 'voice_note' and 'win' so a member can
--    report a voice note or a win into the coach's moderation queue (the queue
--    table community_moderation_actions already has RLS with explicit
--    coach / reporter policies; no policy change is needed because the new
--    values reuse the same rows and workspace_id scoping).
-- 2. "CommunityWin"."hidden_at": a moderation Hide sets it; hidden wins are
--    excluded from every feed. Nullable, no default, no backfill: additive and
--    safe for the running reader/writer (old code never reads the column).
--
-- IRREVERSIBLE for the enum values (PostgreSQL < 17 cannot drop an enum
-- value); down.sql drops only the column. ADD VALUE IF NOT EXISTS keeps the
-- statements idempotent. Prisma runs each migration file outside a
-- transaction (see 20260701235900_add_sub_coach_role_value), and nothing in
-- this file uses the new values, so ADD VALUE is safe here.
-- 3. The durable ban table and 4. the "CommunityWin" RLS rewrite are below
--    (fix round 2: B-610-2, A-610-2).

ALTER TYPE "CommunityModerationTargetType" ADD VALUE IF NOT EXISTS 'voice_note';
ALTER TYPE "CommunityModerationTargetType" ADD VALUE IF NOT EXISTS 'win';

ALTER TABLE "CommunityWin" ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMP(3);

-- ============================================================================
-- 3. B-610-2: durable community ban ("community_workspace_bans").
--    One row per (workspace, member). Written by a moderation-queue Ban; read by
--    every community access path, the default-cohort bootstrap and the member
--    wins feed/post, so a ban survives new, archived or re-ordered cohorts.
--    Lifted only by an explicit reinstatement (lifted_at). Server-only table:
--    ENABLE + FORCE RLS, service_role bypass, RESTRICTIVE deny-all for
--    anon/authenticated and no API-role grants (S1-DB-01 Primitive A).
-- ============================================================================
CREATE TABLE IF NOT EXISTS "community_workspace_bans" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "banned_by_id" TEXT,
    "moderation_action_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ(6),
    "lifted_by_id" TEXT,

    CONSTRAINT "community_workspace_bans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "community_workspace_bans_user_id_idx" ON "community_workspace_bans"("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "community_workspace_bans_workspace_id_user_id_key" ON "community_workspace_bans"("workspace_id", "user_id");

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_workspace_bans_workspace_id_fkey') THEN
    ALTER TABLE "community_workspace_bans" ADD CONSTRAINT "community_workspace_bans_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_workspace_bans_user_id_fkey') THEN
    ALTER TABLE "community_workspace_bans" ADD CONSTRAINT "community_workspace_bans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$fk$;

ALTER TABLE "community_workspace_bans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_workspace_bans" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_community_workspace_bans_service_role_all" ON "community_workspace_bans";
CREATE POLICY "p_community_workspace_bans_service_role_all" ON "community_workspace_bans" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_community_workspace_bans_service_role_all" ON "community_workspace_bans" IS
  'B-610-2: service_role bypass. The ban table is reached only by the backend Prisma client.';

DROP POLICY IF EXISTS "deny_all_anon_community_workspace_bans" ON "community_workspace_bans";
CREATE POLICY "deny_all_anon_community_workspace_bans" ON "community_workspace_bans" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny_all_authenticated_community_workspace_bans" ON "community_workspace_bans";
CREATE POLICY "deny_all_authenticated_community_workspace_bans" ON "community_workspace_bans" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE "community_workspace_bans" FROM anon, authenticated;

-- ============================================================================
-- 4. A-610-2: "CommunityWin" RLS matches the product (circle-only, hidden
--    respected, both-way blocks, bans, no author unhide).
--
--    a) Legacy public wins become circle wins. There is no cross-tenant feed;
--       the REST layer has stored every new win as 'circle' since this PR.
--    b) SELECT for a non-privileged caller: the platform owner; the win's
--       coach or the author's current coach (moderators, who also see hidden
--       wins so reports can be actioned); the author for their own visible
--       win; or a teammate (same coach, coach runs a live community
--       workspace, neither side banned there, no block either way) for a
--       visible win. The visibility='public' arm is gone.
--    c) INSERT/UPDATE WITH CHECK: visibility must be 'circle'.
--    d) A BEFORE INSERT/UPDATE trigger stops a non-moderator from writing
--       hidden_at, or changing coach_id/user_id/visibility on update, so an
--       author can never clear a moderator hide (column-level guard).
--    The backend connects as service_role (BYPASSRLS) and is unaffected.
-- ============================================================================
UPDATE "CommunityWin" SET "visibility" = 'circle' WHERE "visibility" IS DISTINCT FROM 'circle';

CREATE OR REPLACE FUNCTION app.community_win_teammate_visible(p_author_id text, p_coach_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
  SELECT app.current_user_id() IS NOT NULL
     AND p_coach_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" v
       WHERE v."id" = app.current_user_id()
         AND v."coach_id" = p_coach_id
         AND v."deleted_at" IS NULL
     )
     AND EXISTS (
       SELECT 1 FROM public."community_workspaces" w
       WHERE w."coach_id" = p_coach_id
         AND w."archived_at" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM public."community_workspace_bans" b
           WHERE b."workspace_id" = w."id"
             AND b."lifted_at" IS NULL
             AND b."user_id" IN (app.current_user_id(), p_author_id)
         )
     )
     AND NOT EXISTS (
       SELECT 1 FROM public."UserBlock" ub
       WHERE (ub."blocker_id" = app.current_user_id() AND ub."blocked_id" = p_author_id)
          OR (ub."blocker_id" = p_author_id AND ub."blocked_id" = app.current_user_id())
     )
$function$;

COMMENT ON FUNCTION app.community_win_teammate_visible(text, text) IS
  'A-610-2: caller is a teammate of the win author (same coach, the coach runs a live community workspace, neither side banned there, no block either way). SECURITY DEFINER with a pinned search_path and schema-qualified relations.';

REVOKE ALL ON FUNCTION app.community_win_teammate_visible(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.community_win_teammate_visible(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_win_teammate_visible(text, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "p_communitywin_select" ON "CommunityWin";
CREATE POLICY "p_communitywin_select" ON "CommunityWin" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR ("hidden_at" IS NULL AND ("user_id" = app.current_user_id() OR app.community_win_teammate_visible("user_id", "coach_id")))))));
COMMENT ON POLICY "p_communitywin_select" ON "CommunityWin" IS
  'A-610-2: owner; the win coach or the author''s current coach (moderators, hidden included); the author for a visible win; a teammate for a visible win (app.community_win_teammate_visible). No public arm.';

DROP POLICY IF EXISTS "p_communitywin_insert" ON "CommunityWin";
CREATE POLICY "p_communitywin_insert" ON "CommunityWin" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "visibility" = 'circle' AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_communitywin_insert" ON "CommunityWin" IS
  'A-610-2: the author or the author''s current coach may insert a circle win; owner bypass. hidden_at is guarded by trg_community_win_guard_moderation.';

DROP POLICY IF EXISTS "p_communitywin_update" ON "CommunityWin";
CREATE POLICY "p_communitywin_update" ON "CommunityWin" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "visibility" = 'circle' AND ("user_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_communitywin_update" ON "CommunityWin" IS
  'A-610-2: author, assigned coach or current coach may update a circle win; moderation columns (hidden_at, visibility, coach_id, user_id) are guarded by trg_community_win_guard_moderation.';

CREATE OR REPLACE FUNCTION public.community_win_guard_moderation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
DECLARE
  privileged boolean;
BEGIN
  SELECT COALESCE(r.rolbypassrls, false) OR r.rolsuper
    INTO privileged
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user;
  IF COALESCE(privileged, false) OR app.is_owner() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."hidden_at" IS NOT NULL THEN
      RAISE EXCEPTION 'community.win.moderation_column: only a moderator can hide a win'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: moderators (the win coach or the author's current coach) may hide
  -- and unhide; nobody but a privileged role may move a win between
  -- authors or coaches, or change its visibility.
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."coach_id" IS DISTINCT FROM OLD."coach_id"
     OR NEW."visibility" IS DISTINCT FROM OLD."visibility" THEN
    RAISE EXCEPTION 'community.win.moderation_column: author, coach and visibility cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."hidden_at" IS DISTINCT FROM OLD."hidden_at"
     AND NOT (
       app.current_user_id() IS NOT NULL
       AND (OLD."coach_id" = app.current_user_id() OR app.is_current_coach_of(OLD."user_id"))
     ) THEN
    RAISE EXCEPTION 'community.win.moderation_column: only a moderator can hide or unhide a win'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.community_win_guard_moderation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_community_win_guard_moderation ON "CommunityWin";
CREATE TRIGGER trg_community_win_guard_moderation
  BEFORE INSERT OR UPDATE ON "CommunityWin"
  FOR EACH ROW EXECUTE FUNCTION public.community_win_guard_moderation();
