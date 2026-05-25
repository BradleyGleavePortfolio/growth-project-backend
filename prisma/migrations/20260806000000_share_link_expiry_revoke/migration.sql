-- R43 Audit #4 P2-4 — share-link expiry + revocation columns.
--
-- A coach who pastes a share-link into a campaign that wraps up,
-- terminates an engagement, or discovers the link is leaking, needs a
-- way to kill the link without archiving the underlying package (which
-- would also hide it from billing / dashboards). Two new columns back
-- the new POST /packages/:id/share-link/revoke route and the existing
-- expiry path:
--
--   share_link_expires_at   — optional wall-clock cutoff the coach sets
--                             at mint time or by PATCH. Storefront 404s
--                             once now() > expires_at.
--   share_link_revoked_at   — one-way kill switch. Set by revoke; a
--                             subsequent mint produces a NEW token
--                             rather than reviving the old one (the old
--                             URL stays dead forever, which is the
--                             whole point of revoke).
--
-- Both columns are nullable; existing rows default to NULL (no expiry,
-- not revoked) so the migration is backwards-compatible.
ALTER TABLE "CoachPackage"
    ADD COLUMN IF NOT EXISTS "share_link_expires_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "share_link_revoked_at" TIMESTAMP(3);
