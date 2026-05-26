-- R43 Audit #3 P1-3 — invalidate legacy 10-char share tokens.
--
-- Background: the initial storefront migration shipped with a 10-character
-- share-token alphabet (~58 bits of entropy). Audit #3 found that
-- insufficient for an anonymous public lookup surface — the brief calls
-- out 21 characters from the nanoid alphabet (≈126 bits) as the floor.
--
-- This migration leaves the column shape untouched (`share_token TEXT`,
-- `@unique` filtered index on non-null values) and operates on data only:
--
--   * Any row whose `share_token` does not match the nanoid-shape 21-char
--     regex has its token cleared and `share_link_enabled` set FALSE, so
--     the public lookup will 404. Coaches re-mint a 21-char token the
--     next time they POST /api/v1/coach/packages/:id/share-link.
--
-- We deliberately do NOT auto-mint replacement tokens here because:
--   1. The mint endpoint is the only place we generate tokens in prod and
--      it carries the collision-retry + uniqueness invariants. A SQL
--      mint would have to duplicate that logic.
--   2. Coaches expect a deliberate action when their public link changes.
--      Silently rotating from inside a migration would surprise them.
--
-- Idempotent: re-running this migration on an already-converted database
-- is a no-op (no rows match the legacy shape).

UPDATE "CoachPackage"
SET
    "share_token"            = NULL,
    "share_link_enabled"     = FALSE,
    "share_link_generated_at" = NULL
WHERE
    "share_token" IS NOT NULL
    AND "share_token" !~ '^[A-Za-z0-9_-]{21}$';

-- ─── Reversibility (P3-2) ───────────────────────────────────────────────
-- This migration is data-only; there is no schema delta to reverse. Once
-- legacy tokens are cleared, they cannot be restored from this migration
-- alone — that's intentional. The 10-char tokens are below the security
-- floor for an anonymous public endpoint and must not be re-issued.
--
-- ROLLBACK: no-op (data-only forward migration).
