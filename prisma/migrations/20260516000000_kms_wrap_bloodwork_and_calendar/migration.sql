-- KMS-wrap retrofit. Adds encrypted-content columns alongside the
-- existing plaintext columns; the application dual-writes and
-- prefers the encrypted column on read with a plaintext fallback.
-- A separate, deliberate cutover migration will drop the plaintext
-- columns once the encrypted columns are fully populated.

-- BloodworkPanel: encrypt the two free-text PII-bearing fields
-- ("notes" from the client, "review_note" from the coach). The
-- existing encryption_key_ref + kms_key_version columns shipped by
-- PR #141 are populated by the application starting with this PR.
ALTER TABLE "BloodworkPanel"
  ADD COLUMN "encrypted_notes" TEXT,
  ADD COLUMN "encrypted_review_note" TEXT;

-- CalendarConnection: encrypt the Google OAuth refresh token. Prior
-- to this PR the token lived only in process memory (see
-- _devTokenStash in google-oauth.service.ts) — the column is
-- nullable so existing stub rows continue to validate.
ALTER TABLE "CalendarConnection"
  ADD COLUMN "encrypted_refresh_token" TEXT;
