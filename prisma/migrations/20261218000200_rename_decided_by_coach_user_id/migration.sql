-- R81 PR #401 P3-2 (Auditor B) — rename PartialRefundDecision.decided_by_coach_id
-- to decided_by_coach_user_id for naming consistency with the rest of the
-- schema (every other coach FK on this surface is *_coach_user_id; the column
-- stores a User.id, not a Coach.id).
--
-- Safe additive rename. The PartialRefundDecision table was created in
-- 20261214000000_named_regimes_and_partial_refund_decision and the named-regimes
-- feature is gated OFF (FEATURE_NAMED_REGIMES) — no decision rows exist in any
-- environment, so the rename is a pure metadata operation with no data
-- migration. No conflict with 20261218000100_rls_partial_refund_decision, whose
-- policies derive the owning coach through the parent ClientPurchase and never
-- reference this column.
--
-- Rollback: ALTER TABLE "PartialRefundDecision" RENAME COLUMN
-- "decided_by_coach_user_id" TO "decided_by_coach_id";

ALTER TABLE "PartialRefundDecision"
  RENAME COLUMN "decided_by_coach_id" TO "decided_by_coach_user_id";
