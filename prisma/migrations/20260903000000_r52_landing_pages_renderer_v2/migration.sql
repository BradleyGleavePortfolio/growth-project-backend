-- R52 Landing Page Renderer v2 — adds three persuasion-arc section kinds.
--
-- The renderer rewrite (PR-LP-RENDERER-V2) introduces a structured 7-section
-- arc that the existing 8 kinds did not fully cover. Three new enum values
-- are appended so a coach can place "problem_solution", "mechanism", and
-- "trust" sections on their page. Pre-existing kinds (before_after, pricing,
-- offer_stack, guarantee) remain valid and the v2 renderer still draws them
-- under the new SaaS-brand token system — pages from Phase 1/2 continue to
-- render without any data migration.
--
-- Postgres ENUMs are open to forward extension via ALTER TYPE ... ADD VALUE,
-- but those statements cannot run inside a transaction. Each ADD VALUE is
-- emitted standalone; Prisma's migration runner handles the splitting.
--
-- accent_color reuse: the v2 renderer accepts the existing TEXT column on
-- CoachLandingPage and maps it to one of four preset accents (gold default,
-- sage #5d7d65, terracotta #c87a5d, slate #4a5870). No schema change is
-- needed for the accent picker; legacy hex values fall through to the gold
-- default automatically.

-- Three new section kinds (idempotent — IF NOT EXISTS supported since pg 9.6).
ALTER TYPE "LandingSectionKind" ADD VALUE IF NOT EXISTS 'problem_solution';
ALTER TYPE "LandingSectionKind" ADD VALUE IF NOT EXISTS 'mechanism';
ALTER TYPE "LandingSectionKind" ADD VALUE IF NOT EXISTS 'trust';

-- ─── Reversibility ───────────────────────────────────────────────────────────
-- Postgres does NOT support removing enum values. A proper rollback would
-- require:
--   1. Convert any landing-page sections using the new kinds back to a
--      legacy kind (e.g. offer_stack) via a data migration.
--   2. Create a new enum without the three values, swap the column type to
--      it, drop the old enum.
-- This is destructive and complex, so we document the steps here but do
-- not script them. In dev/staging an operator drops the database and
-- re-runs from a baseline if a rollback is required.
