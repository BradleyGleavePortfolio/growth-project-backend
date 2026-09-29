-- S12-B4 read-only observation pack — 00_find_coach.sql
-- Purpose: resolve a coach's User.id (the UUID FEATURE_SCOUT_PILOT_COACH_IDS needs) from an
-- email, WITHOUT ever printing another coach's data. SELECT only. Never run against production
-- by a builder; the operator who runs this against a real database owns that action.
--
-- Params: :email  -- the pilot coach's login email, exact match, case-sensitive (User.email is
--                     a plain unique column here, not case-folded at the database level).

SELECT
  id            AS coach_id,
  role,
  coach_id      AS reports_to_coach_id,  -- must be NULL for a coach/owner; non-NULL is a student
  created_at
FROM "User"
WHERE email = :'email';
