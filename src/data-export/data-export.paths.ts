import { join } from 'path';

/**
 * Where a data export archive lives. Shared by the export worker and by
 * account deletion, which removes the planned path of every export of the
 * user, finished or not (B-608-3).
 */
export function exportArchiveDir(): string {
  return process.env.DATA_EXPORT_FS_DIR ?? '/tmp/exports';
}

export function exportArchivePath(exportId: string): string {
  return join(exportArchiveDir(), `${exportId}.json`);
}

/** File names the export worker writes: `<request id>.json`. */
export const EXPORT_ARCHIVE_NAME = /^([0-9A-Za-z_-]{1,64})\.json$/;

/**
 * An export id that is safe to turn into an archive path: no separator, no
 * dot, so `exportArchivePath(id)` always names a file directly inside
 * `exportArchiveDir()` (B-608-11 foreign-file isolation).
 */
export function isExportId(id: string): boolean {
  return /^[0-9A-Za-z_-]{1,64}$/.test(id);
}
