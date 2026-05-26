-- Single-use nonce store for RecentAuthGuard.
-- Closes A1-C5-P1-3 (RecentAuthGuard token reusable within TTL — replay window).
--
-- Each RecentAuthGuard token may be presented exactly once within its TTL.
-- The guard writes a nonce row on first successful verification; a second
-- presentation triggers a P2002 unique-constraint violation which the guard
-- converts to 403 RECENT_AUTH_TOKEN_ALREADY_USED.
CREATE TABLE IF NOT EXISTS "recent_auth_nonce" (
  "id"          TEXT        NOT NULL PRIMARY KEY,
  "hmac_suffix" TEXT        NOT NULL,
  "user_id"     TEXT        NOT NULL,
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "recent_auth_nonce_hmac_suffix_key" UNIQUE ("hmac_suffix")
);

CREATE INDEX IF NOT EXISTS "recent_auth_nonce_expires_at_idx"
  ON "recent_auth_nonce" ("expires_at");
