-- Rollback of 20270224000000_build_week_day1_consultation_copy.
--
-- Restores the original Day 1 copy from 20260506020000_add_build_week, guarded
-- by the new values, scoped to day_number = 1 only. Data only: the schema is
-- identical before and after, so the migration dry run's schema snapshot
-- comparison is unaffected. Restoring this copy re-advertises the switched-off
-- diagnostic quiz, so only roll back together with the quiz itself.

UPDATE "BuildWeekDay" AS d
SET "action_items" = (
  SELECT jsonb_agg(
    CASE
      WHEN t.elem ->> 'title' = 'Complete your consultation' THEN
        jsonb_build_object(
          'title', 'Complete the 40-point diagnostic',
          'description', 'Work through the diagnostic form end-to-end. Honest answers only — this becomes the baseline every later week is measured against.',
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
    WHERE e.elem ->> 'title' = 'Complete your consultation'
  );

UPDATE "BuildWeekDay"
SET "focus_area" = 'Diagnostic + Baseline'
WHERE "day_number" = 1 AND "focus_area" = 'Consultation + Baseline';

UPDATE "BuildWeekDay"
SET "narrative" = replace(
  "narrative",
  'Your consultation, the starting body weight, and the income baseline together form the snapshot',
  'The 40-point diagnostic, the starting body weight, and the income baseline together form the snapshot'
)
WHERE "day_number" = 1
  AND strpos("narrative", 'Your consultation, the starting body weight, and the income baseline together form the snapshot') > 0;

UPDATE "BuildWeekDay"
SET "expected_artifact" = 'Diagnostic + baseline snapshot: weight, income, hours, and a 100-word success statement.'
WHERE "day_number" = 1
  AND "expected_artifact" = 'Consultation + baseline snapshot: weight, income, hours, and a 100-word success statement.';
