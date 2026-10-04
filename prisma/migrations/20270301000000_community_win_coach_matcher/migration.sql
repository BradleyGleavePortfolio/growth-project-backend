-- C-610-11 (Opus + Sol, #610 audit carry; B-UGC-5, ruling OR-112-6):
-- the coach lookup app.community_win_author_coach(text) is SECURITY DEFINER
-- and was EXECUTE-granted to "authenticated", so any signed-in database role
-- could resolve ANY user id to that user's coach (a cross-tenant lookup) if
-- the "app" schema were ever exposed over the Data API. The backend connects
-- as service_role (BYPASSRLS) and is unaffected.
--
-- Fix, same behaviour for every legitimate writer:
--   1. A boolean matcher app.community_win_coach_matches(author, coach)
--      answers only "is this the author's authoritative coach?" and only for
--      a caller who is the author or the author's current coach (the same two
--      principals the INSERT policy admits). For anyone else it is FALSE, so
--      it can never be used to look up, or confirm, a stranger's coach.
--   2. The INSERT policy on "CommunityWin" and the moderation trigger use the
--      matcher instead of the lookup. Policy text is otherwise unchanged.
--   3. EXECUTE on the lookup is revoked from "authenticated"; it stays for
--      service_role and for the SECURITY DEFINER helpers that call it
--      (app.community_win_teammate_visible, the matcher), which run as the
--      function owner.
-- No table, column or data change. Additive and safe for the running code.

CREATE OR REPLACE FUNCTION app.community_win_coach_matches(p_author_id text, p_coach_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $function$
  SELECT COALESCE(
    app.current_user_id() IS NOT NULL
    AND p_author_id IS NOT NULL
    AND (p_author_id = app.current_user_id() OR app.is_current_coach_of(p_author_id))
    AND p_coach_id IS NOT DISTINCT FROM app.community_win_author_coach(p_author_id),
    false
  )
$function$;

COMMENT ON FUNCTION app.community_win_coach_matches(text, text) IS
  'C-610-11: TRUE when p_coach_id is the authoritative coach of p_author_id (app.community_win_author_coach) AND the caller is that author or the author''s current coach; FALSE otherwise. Never returns the coach id, so it cannot be used to look up a stranger''s coach.';

REVOKE ALL ON FUNCTION app.community_win_coach_matches(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.community_win_coach_matches(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_win_coach_matches(text, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "p_communitywin_insert" ON "CommunityWin";
CREATE POLICY "p_communitywin_insert" ON "CommunityWin" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "visibility" = 'circle' AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")) AND app.community_win_coach_matches("user_id", "coach_id"))));
COMMENT ON POLICY "p_communitywin_insert" ON "CommunityWin" IS
  'A-610-2 / C-610-11: the author (own path) or the author''s current coach (coach path) may insert a circle win whose coach_id is the author''s authoritative coach (app.community_win_coach_matches); owner bypass. hidden_at is guarded by trg_community_win_guard_moderation.';

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
    -- C-610-11: the boolean matcher, not the coach lookup (which the
    -- authenticated role can no longer execute).
    IF NOT app.community_win_coach_matches(NEW."user_id", NEW."coach_id") THEN
      RAISE EXCEPTION 'community.win.moderation_column: coach_id must be the author''s coach'
        USING ERRCODE = '42501';
    END IF;
    IF NEW."hidden_at" IS NOT NULL THEN
      RAISE EXCEPTION 'community.win.moderation_column: only a moderator can hide a win'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the moderator (the author's current coach, from the live
  -- relationship, never from the writable coach_id) may hide and unhide;
  -- nobody but a privileged role may move a win between authors or coaches,
  -- or change its visibility.
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."coach_id" IS DISTINCT FROM OLD."coach_id"
     OR NEW."visibility" IS DISTINCT FROM OLD."visibility" THEN
    RAISE EXCEPTION 'community.win.moderation_column: author, coach and visibility cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."hidden_at" IS DISTINCT FROM OLD."hidden_at"
     AND NOT (
       app.current_user_id() IS NOT NULL
       AND app.is_current_coach_of(OLD."user_id")
     ) THEN
    RAISE EXCEPTION 'community.win.moderation_column: only a moderator can hide or unhide a win'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.community_win_guard_moderation() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION app.community_win_author_coach(text) FROM authenticated;
COMMENT ON FUNCTION app.community_win_author_coach(text) IS
  'A-610-2 round 5: the authoritative coach of a win author (the author for a coach, else User.coach_id; NULL for a deleted or unknown user). C-610-11: not executable by anon or authenticated; API-role SQL uses app.community_win_coach_matches.';
