-- Reverse of 20270301000000_community_win_coach_matcher.
--
-- Restores the 20270211000000 state exactly: authenticated may EXECUTE the
-- coach lookup again (re-opening C-610-11), the INSERT policy and the
-- moderation trigger call the lookup directly, and the matcher is dropped.
-- No data is touched.
GRANT EXECUTE ON FUNCTION app.community_win_author_coach(text) TO authenticated;
COMMENT ON FUNCTION app.community_win_author_coach(text) IS
  'A-610-2 round 5: the authoritative coach of a win author (the author for a coach, else User.coach_id; NULL for a deleted or unknown user). The only source of a win''s coach_id for a non-privileged writer.';

DROP POLICY IF EXISTS "p_communitywin_insert" ON "CommunityWin";
CREATE POLICY "p_communitywin_insert" ON "CommunityWin" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "visibility" = 'circle' AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")) AND "coach_id" IS NOT DISTINCT FROM app.community_win_author_coach("user_id"))));
COMMENT ON POLICY "p_communitywin_insert" ON "CommunityWin" IS
  'A-610-2: the author (own path) or the author''s current coach (coach path) may insert a circle win whose coach_id is the author''s authoritative coach (app.community_win_author_coach); owner bypass. hidden_at is guarded by trg_community_win_guard_moderation.';

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
    IF NEW."coach_id" IS DISTINCT FROM app.community_win_author_coach(NEW."user_id") THEN
      RAISE EXCEPTION 'community.win.moderation_column: coach_id must be the author''s coach'
        USING ERRCODE = '42501';
    END IF;
    IF NEW."hidden_at" IS NOT NULL THEN
      RAISE EXCEPTION 'community.win.moderation_column: only a moderator can hide a win'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
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

DROP FUNCTION IF EXISTS app.community_win_coach_matches(text, text);
