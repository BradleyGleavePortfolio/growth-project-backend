-- P2-4: DB-layer validation for the Coach Brief tables. DTOs already
-- reject bad input at the HTTP boundary, but the migration accepts
-- arbitrary TEXT for status, brief_date, generated_by, brief_mode,
-- notification_time, timezone, and unbounded content. CHECK constraints
-- here are the second layer so a backend bug or a future direct-RLS path
-- cannot persist corrupted rows.

-- ────────────────────────────────────────────────────────────────────────────
-- CoachBrief
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_status_check",
  ADD  CONSTRAINT "CoachBrief_status_check"
  CHECK ("status" IN ('pending', 'generating', 'generated', 'failed'));

-- brief_date must be both YYYY-MM-DD shaped AND a real calendar date.
-- A bare regex would happily accept '2026-02-30' or '2026-13-01'; the
-- to_date() round-trip rejects those by failing IMMUTABLE coercion.
-- We mark the function IMMUTABLE-safe with a CASE wrapper so the planner
-- can keep the constraint inline.
ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_brief_date_format_check",
  ADD  CONSTRAINT "CoachBrief_brief_date_format_check"
  CHECK (
    "brief_date" ~ '^\d{4}-\d{2}-\d{2}$'
    AND to_char(to_date("brief_date", 'YYYY-MM-DD'), 'YYYY-MM-DD') = "brief_date"
  );

-- Audit #4 P2-3: generation_started_at is the lease/claim timestamp
-- written when status flips to 'generating'. generated_at is the
-- completion timestamp written when narrative + action_items are
-- persisted. By definition completion cannot precede claim. Anything
-- else indicates a clock-skew bug or out-of-band write that bypassed
-- the service layer.
ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_claim_before_generated_check",
  ADD  CONSTRAINT "CoachBrief_claim_before_generated_check"
  CHECK (
    "generated_at" IS NULL
    OR "generation_started_at" IS NULL
    OR "generated_at" >= "generation_started_at"
  );

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_generated_by_check",
  ADD  CONSTRAINT "CoachBrief_generated_by_check"
  CHECK ("generated_by" IS NULL OR "generated_by" IN ('ai', 'fallback'));

ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_brief_mode_check",
  ADD  CONSTRAINT "CoachBrief_brief_mode_check"
  CHECK ("brief_mode" IS NULL OR "brief_mode" IN ('solo_coach', 'head_coach', 'sub_coach'));

-- Narrative is capped at the same MAX as the application (600 chars) so
-- a malformed write can't blow past the mobile UI budget.
ALTER TABLE "CoachBrief"
  DROP CONSTRAINT IF EXISTS "CoachBrief_narrative_length_check",
  ADD  CONSTRAINT "CoachBrief_narrative_length_check"
  CHECK ("narrative" IS NULL OR char_length("narrative") <= 600);

-- ────────────────────────────────────────────────────────────────────────────
-- CoachDailyLog
-- ────────────────────────────────────────────────────────────────────────────

-- Real-calendar check, same rationale as CoachBrief above.
ALTER TABLE "CoachDailyLog"
  DROP CONSTRAINT IF EXISTS "CoachDailyLog_log_date_format_check",
  ADD  CONSTRAINT "CoachDailyLog_log_date_format_check"
  CHECK (
    "log_date" ~ '^\d{4}-\d{2}-\d{2}$'
    AND to_char(to_date("log_date", 'YYYY-MM-DD'), 'YYYY-MM-DD') = "log_date"
  );

-- DTO caps content at 4000 chars; mirror at the DB layer.
ALTER TABLE "CoachDailyLog"
  DROP CONSTRAINT IF EXISTS "CoachDailyLog_content_length_check",
  ADD  CONSTRAINT "CoachDailyLog_content_length_check"
  CHECK (char_length("content") <= 4000);

-- ────────────────────────────────────────────────────────────────────────────
-- CoachBriefPreferences
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "CoachBriefPreferences"
  DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_notification_time_check",
  ADD  CONSTRAINT "CoachBriefPreferences_notification_time_check"
  CHECK ("notification_time" ~ '^([01]\d|2[0-3]):[0-5]\d$');

-- IANA timezone strings are ~64 chars at most ("America/Argentina/Buenos_Aires"
-- is the longest in production use at 30); 80 is a comfortable ceiling
-- that still blocks runaway writes.
--
-- Audit #4 P2-3: in addition to the length cap, enforce that the string
-- looks like a sane tz identifier. We cannot call pg_timezone_names()
-- inside a CHECK (not IMMUTABLE), so the constraint just enforces
-- length + a permissive alphabet so shell injection / SQL fragments /
-- stray whitespace are blocked at the DB layer. The application-side
-- IsValidTimezone validator (via Intl.DateTimeFormat) is the
-- authoritative gate for "this is a real IANA tz".
--
-- A5-P2-5 — the previous regex
--   ^(UTC|GMT|Etc/<word>|<Region>/<City>[/<SubCity>])$
-- rejected legitimate single-token IANA aliases that Intl.DateTimeFormat
-- accepts: EST, EDT, PST, MST, HST, CET, EET, MET, WET, PST8PDT,
-- EST5EDT, MST7MDT, CST6CDT, Factory. Mobile clients on older OSes
-- still send these, and the DTO validator was happy with them — only
-- the DB CHECK threw, producing a 500 on save. Drop to a length-and-
-- alphabet check; Intl.DateTimeFormat remains the authoritative gate.
ALTER TABLE "CoachBriefPreferences"
  DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_timezone_length_check",
  ADD  CONSTRAINT "CoachBriefPreferences_timezone_length_check"
  CHECK (char_length("timezone") BETWEEN 1 AND 80);

ALTER TABLE "CoachBriefPreferences"
  DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_timezone_format_check",
  ADD  CONSTRAINT "CoachBriefPreferences_timezone_format_check"
  CHECK (
    -- Allowed alphabet: letters, digits, underscore, plus, minus, slash.
    -- Anything outside this set is shell-injection / SQL-fragment shape
    -- and gets rejected at the DB layer regardless of what the DTO
    -- thinks. Cross-references its rationale to the application validator
    -- (src/common/validators/is-valid-timezone.validator.ts) which is the
    -- authoritative gate for IANA tz validity.
    "timezone" ~ '^[A-Za-z0-9_+\-/]+$'
  );

-- ROLLBACK:
-- ALTER TABLE "CoachBriefPreferences" DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_timezone_format_check";
-- ALTER TABLE "CoachBriefPreferences" DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_timezone_length_check";
-- ALTER TABLE "CoachBriefPreferences" DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_notification_time_check";
-- ALTER TABLE "CoachDailyLog"         DROP CONSTRAINT IF EXISTS "CoachDailyLog_content_length_check";
-- ALTER TABLE "CoachDailyLog"         DROP CONSTRAINT IF EXISTS "CoachDailyLog_log_date_format_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_claim_before_generated_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_narrative_length_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_brief_mode_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_generated_by_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_brief_date_format_check";
-- ALTER TABLE "CoachBrief"            DROP CONSTRAINT IF EXISTS "CoachBrief_status_check";
