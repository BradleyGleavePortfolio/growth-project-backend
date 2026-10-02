-- B-608-11 — durable cleanup records for data-export archives.
--
-- Additive only: one new table, one index, RLS. No shipped migration is
-- altered. Reverse: down.sql (drops only what this file creates).
--
-- A data-export archive lives on the local disk of the machine that built it
-- (DATA_EXPORT_FS_DIR, default /tmp/exports). When the export worker must
-- remove an archive that no request row owns any more (the account was erased
-- while the archive was being built, or the export run failed) and the unlink
-- fails with anything other than ENOENT (EACCES, EIO, ...), it writes one row
-- here. The nightly data-export cleanup on that machine retries the unlink
-- and deletes the row only once the archive is confirmed gone (unlink
-- succeeded, or ENOENT on the machine that wrote it). Nothing is announced as
-- deleted while a row exists.
--
-- Privacy: the table holds no user id, email or other personal data. The
-- export id is a random UUID whose request row is already gone; the archive
-- path is derived from it by the server (exportArchivePath), never stored, so
-- a row cannot point the cleanup at a file outside the export directory.
--
-- RLS: service_role only (Primitive A). anon and authenticated get
-- RESTRICTIVE deny-all policies plus REVOKE of table privileges.

SET lock_timeout = '5s';

CREATE TABLE "data_export_archive_cleanup" (
    "export_id"       TEXT NOT NULL,
    "machine"         TEXT NOT NULL,
    "reason"          TEXT NOT NULL,
    "attempts"        INTEGER NOT NULL DEFAULT 1,
    "last_error_code" TEXT NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "data_export_archive_cleanup_pkey" PRIMARY KEY ("export_id"),
    CONSTRAINT "data_export_archive_cleanup_export_id_check" CHECK ("export_id" ~ '^[0-9A-Za-z_-]{1,64}$'),
    CONSTRAINT "data_export_archive_cleanup_reason_check" CHECK ("reason" IN ('request_removed', 'failed_run')),
    CONSTRAINT "data_export_archive_cleanup_attempts_check" CHECK ("attempts" >= 1),
    CONSTRAINT "data_export_archive_cleanup_text_check" CHECK (
        length("machine") BETWEEN 1 AND 255
        AND length("last_error_code") BETWEEN 1 AND 64
    )
);

CREATE INDEX "data_export_archive_cleanup_machine_created_at_idx"
    ON "data_export_archive_cleanup"("machine", "created_at");

ALTER TABLE "data_export_archive_cleanup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_export_archive_cleanup" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "data_export_archive_cleanup" FROM anon;
REVOKE ALL ON TABLE "data_export_archive_cleanup" FROM authenticated;

CREATE POLICY "p_data_export_archive_cleanup_service_role_all" ON "data_export_archive_cleanup"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_data_export_archive_cleanup_service_role_all" ON "data_export_archive_cleanup" IS
  'Primitive A: service_role access for the data-export worker and its nightly cleanup, the only readers and writers.';

CREATE POLICY "deny_all_anon_data_export_archive_cleanup" ON "data_export_archive_cleanup"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_data_export_archive_cleanup" ON "data_export_archive_cleanup" IS
  'RESTRICTIVE deny-all: anon can never read or write archive cleanup records.';

CREATE POLICY "deny_all_authenticated_data_export_archive_cleanup" ON "data_export_archive_cleanup"
    AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_data_export_archive_cleanup" ON "data_export_archive_cleanup" IS
  'RESTRICTIVE deny-all: authenticated principals can never read or write archive cleanup records; only service_role (Primitive A) may.';

RESET lock_timeout;
