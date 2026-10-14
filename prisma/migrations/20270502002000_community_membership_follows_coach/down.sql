-- Down for 20270502002000_community_membership_follows_coach (COMMUNITYMOVE).
-- Drops the trigger and its two functions and restores the coach policy on
-- community_memberships to its 20261212000000 text. This brings back the gap:
-- a coach change no longer ends the client's old memberships, and the former
-- coach reads a moved client's membership rows again. Memberships the
-- migration or the trigger ended stay ended: they cannot be told apart from a
-- coach's Remove, and reopening them would put moved clients back in the old
-- coach's community. Nothing was deleted, so there is nothing to restore.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS "trg_user_coach_change_closes_community" ON public."User";
DROP FUNCTION IF EXISTS app.community_memberships_follow_coach();
DROP FUNCTION IF EXISTS app.close_community_memberships_left_by_move(text);

ALTER POLICY "community_memberships_coach_all" ON public."community_memberships"
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

COMMIT;
