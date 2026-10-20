-- FIX-1118-R1 (ROMAN-EXTRAS-BE, b#1118 fix round 1): one stored time for when
-- a client joined their current coach, so the coach brief's "Joined today"
-- row sees every way in: a free or QR code join, a paid invite (purchase
-- fan-out), a guest checkout (new account or an existing coachless one).
--
-- The time is written by a trigger, not by each caller, so every path that
-- attaches a client to a coach sets it, today's and any added later:
--   * coach_id goes from null to a coach (INSERT or UPDATE): now, in UTC.
--   * coach_id moves from one coach to another (a team-internal move): kept.
--     That is not a new client joining the business.
--   * coach_id goes to null (account deletion): cleared.
-- A renewal of an existing client does not touch coach_id, so it is not a join.
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
  ELSIF TG_OP = 'INSERT' OR OLD."coach_id" IS NULL THEN
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
