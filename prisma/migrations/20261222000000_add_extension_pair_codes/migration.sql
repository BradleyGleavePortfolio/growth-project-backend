-- v0.3 importer pairing (operator ruling 2026-07-06).
--
-- ExtensionPairCode — short-lived, single-use codes that bridge the TGP
-- mobile app and the desktop Chrome importer extension. The mobile app mints a
-- 6-digit code bound to the coach + chosen source platform; the extension
-- redeems it exactly once for a token bound to that coach. See docs/DESIGN.md
-- v0.3 §2/§4.
--
-- REVERSIBLE (R82/R106): purely additive (new table only). The reverse step
-- lives in the companion down.sql (DROP TABLE IF EXISTS "ExtensionPairCode").
--
-- RLS: the table holds a live credential-minting secret, so it follows the
-- SubCoachMutationIdempotency precedent — RESTRICTIVE deny-all for the `anon`
-- and `authenticated` Supabase roles. All access is through the NestJS service
-- role (which bypasses RLS), so direct PostgREST clients see nothing.

CREATE TABLE "ExtensionPairCode" (
    "id"              TEXT NOT NULL,
    "code"            TEXT NOT NULL,
    "coach_id"        TEXT NOT NULL,
    "chosen_platform" TEXT NOT NULL,
    "expires_at"      TIMESTAMP(3) NOT NULL,
    "used_at"         TIMESTAMP(3),
    -- Per-code brute-force lockout: charged once per redeem that finds the row
    -- but cannot claim it; at the service ceiling the code is hard-invalidated
    -- (410 locked). DB-backed so the lockout survives across requests and IPs.
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtensionPairCode_pkey" PRIMARY KEY ("id")
);

-- Unique on the code itself: redemption is an equality lookup and a code can
-- never be minted twice.
CREATE UNIQUE INDEX "ExtensionPairCode_code_key"
    ON "ExtensionPairCode"("code");
-- Coach can only poll their own codes (status endpoint scopes by coach_id).
CREATE INDEX "ExtensionPairCode_coach_id_idx"
    ON "ExtensionPairCode"("coach_id");
-- Expiry sweep / reaper support.
CREATE INDEX "ExtensionPairCode_expires_at_idx"
    ON "ExtensionPairCode"("expires_at");
-- Single-use enforcement + "already redeemed" checks read used_at.
CREATE INDEX "ExtensionPairCode_used_at_idx"
    ON "ExtensionPairCode"("used_at");

-- Foreign key to the coach. ON DELETE CASCADE: a code is worthless once its
-- coach is gone, and there is nothing auditable to retain (the audit trail of
-- a successful pair lives in the auth/session log, not here).
ALTER TABLE "ExtensionPairCode"
    ADD CONSTRAINT "ExtensionPairCode_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Row Level Security ───────────────────────────────────────────────────
ALTER TABLE "ExtensionPairCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExtensionPairCode" FORCE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_anon_extension_pair_code"
    ON "ExtensionPairCode"
    AS RESTRICTIVE
    FOR ALL
    TO anon
    USING (false);

CREATE POLICY "deny_all_authenticated_extension_pair_code"
    ON "ExtensionPairCode"
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING (false);
