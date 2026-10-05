-- Reverse of 20270220000000_data_export_archive_cleanup.
--
-- Drops the cleanup-record table (its policies and index go with it). This
-- forgets every pending archive cleanup: run it only when the table is empty
-- (SELECT count(*) FROM "data_export_archive_cleanup" = 0), or first remove
-- each listed archive by hand on its machine (<DATA_EXPORT_FS_DIR>/<export_id>.json).
-- The nightly orphan sweep still removes archives with no request row that
-- are older than an hour, but it is not a substitute for a pending record.
DROP TABLE IF EXISTS "data_export_archive_cleanup";
