-- Build Week Day 1 copy: point to the consultation, not the diagnostic quiz.
--
-- The 40-point diagnostic quiz belongs to TGP Finance and is switched off in
-- this backend (B-QUIZ-OFF, owner 2026-10-01 15:25). Day 1 of the Build Week
-- catalog (loaded by 20260506020000_add_build_week from
-- prisma/seed-build-week.json) still told people to complete it. This data
-- migration rewrites the four Day 1 fields that name it so they point to the
-- consultation (C05/C07 intake) instead. prisma/seed-build-week.json carries
-- the same copy (test/build-week-day1-consultation-copy.spec.ts keeps the two
-- in lockstep).
--
-- Scope: only the row with the stable key day_number = 1 (BuildWeekDay
-- @unique). No other row, column, table or schema object is touched; no DDL.
-- Inside Day 1 only the "Complete the 40-point diagnostic" action item is
-- replaced, matched by its title; the other action items, their order and
-- their time estimates are kept. Every UPDATE is guarded by the old value, so
-- a second run (or a run on a database that already has the new copy) changes
-- nothing: idempotent.
--
-- Rollback: down.sql restores the original Day 1 copy, guarded by the new
-- values. Schema is unchanged in both directions.

-- 1. The action item, matched by its old title; position and time kept.
UPDATE "BuildWeekDay" AS d
SET "action_items" = (
  SELECT jsonb_agg(
    CASE
      WHEN t.elem ->> 'title' = 'Complete the 40-point diagnostic' THEN
        jsonb_build_object(
          'title', 'Complete your consultation',
          'description', 'Work through your consultation in the app from start to finish so your coach can tailor your plan. Honest answers only. This becomes the baseline every later week is measured against.',
          'time_estimate_min', t.elem -> 'time_estimate_min'
        )
      ELSE t.elem
    END
    ORDER BY t.ord
  )
  FROM jsonb_array_elements(d."action_items") WITH ORDINALITY AS t(elem, ord)
)
WHERE d."day_number" = 1
  AND jsonb_typeof(d."action_items") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(d."action_items") AS e(elem)
    WHERE e.elem ->> 'title' = 'Complete the 40-point diagnostic'
  );

-- 2. Focus area.
UPDATE "BuildWeekDay"
SET "focus_area" = 'Consultation + Baseline'
WHERE "day_number" = 1 AND "focus_area" = 'Diagnostic + Baseline';

-- 3. Narrative: only the sentence that names the diagnostic.
UPDATE "BuildWeekDay"
SET "narrative" = replace(
  "narrative",
  'The 40-point diagnostic, the starting body weight, and the income baseline together form the snapshot',
  'Your consultation, the starting body weight, and the income baseline together form the snapshot'
)
WHERE "day_number" = 1
  AND strpos("narrative", 'The 40-point diagnostic, the starting body weight, and the income baseline together form the snapshot') > 0;

-- 4. Expected artifact.
UPDATE "BuildWeekDay"
SET "expected_artifact" = 'Consultation + baseline snapshot: weight, income, hours, and a 100-word success statement.'
WHERE "day_number" = 1
  AND "expected_artifact" = 'Diagnostic + baseline snapshot: weight, income, hours, and a 100-word success statement.';

-- 5. Post-condition (fail closed): if Day 1 exists, none of its fields may
-- still name the diagnostic. Every database built by this migration chain has
-- the seeded Day 1 row, so CI's real Postgres runs (Schema parity, migration
-- dry run) prove the four updates above took effect.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BuildWeekDay"
    WHERE "day_number" = 1
      AND (
        "action_items"::text ILIKE '%40-point diagnostic%'
        OR "focus_area" ILIKE '%diagnostic%'
        OR "narrative" ILIKE '%40-point diagnostic%'
        OR "expected_artifact" ILIKE '%diagnostic%'
      )
  ) THEN
    RAISE EXCEPTION 'build_week_day1_consultation_copy: Day 1 still names the diagnostic after the update';
  END IF;
END
$$;
