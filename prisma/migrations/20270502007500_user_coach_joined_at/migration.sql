-- FIX-1118-R1 (ROMAN-EXTRAS-BE, b#1118 fix round 1): one stored time for when
-- a client joined their current coach, so the coach brief's "Joined today"
-- row sees every way in: a free or QR code join, a paid invite (purchase
-- fan-out), a guest checkout (new account or an existing coachless one).
--
-- The time is written by a trigger, not by each caller, so every path that
-- attaches a client to a coach sets it, today's and any added later:
--   * coach_id goes to null (account deletion): cleared.
--   * INSERT with a coach, or coach_id changes (null to a coach, or one coach
--     to another, e.g. a sub-coach's clients moved to the head coach): now,
--     in UTC. The time is when the client joined their CURRENT coach.
--   * coach_id unchanged (a renewal, a same-coach write, or a direct write of
--     coach_joined_at): kept.
-- FIX-1118-R2 (Sol B2): a move from coach A to coach B used to keep A's time.
--
-- Additive and nullable: existing clients keep null (joined before this
-- column; the brief also counts a consultation finished in the last 24 h).
-- Row security on "User" is unchanged (already enabled and forced); no grant
-- changes, so app roles still cannot write this column.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" ADD COLUMN "coach_joined_at" TIMESTAMP(3);

CREATE FUNCTION app.user_coach_joined_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW."coach_id" IS NULL THEN
    NEW."coach_joined_at" := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD."coach_id" IS DISTINCT FROM NEW."coach_id" THEN
    NEW."coach_joined_at" := now() AT TIME ZONE 'UTC';
  ELSE
    NEW."coach_joined_at" := OLD."coach_joined_at";
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.user_coach_joined_at() FROM PUBLIC;

CREATE TRIGGER "User_coach_joined_at"
  BEFORE INSERT OR UPDATE OF "coach_id", "coach_joined_at" ON "User"
  FOR EACH ROW
  EXECUTE FUNCTION app.user_coach_joined_at();

COMMIT;
