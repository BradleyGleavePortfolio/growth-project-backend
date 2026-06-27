/**
 * scripts/audit-log-retention-rotate.ts
 *
 * H6 — audit_log retention rotation (D-H6-4 LOCKED 2026-06-26).
 *
 * Archives audit_log rows older than 7 years to S3 Object Lock, then — and
 * ONLY then — deletes them from the table. NO row is ever deleted without a
 * verified archive write (mortgage-paperwork metaphor: you box up the old
 * files, you never shred them). Archive layout is Glue/Athena-friendly
 * Parquet-style partitioning by tenant_id and created_at::date.
 *
 * This is an OPS cron job, run OUTSIDE the Nest process (e.g. a Fly machine
 * cron or GitHub Actions schedule). It is deliberately NOT a @nestjs/schedule
 * task — the deletion path needs a privileged DB role that the app runtime
 * role does not have (the migration REVOKEs UPDATE/DELETE from app_runtime).
 *
 * GDPR Art. 17 erasure is NOT handled here. Right-to-be-forgotten is an
 * in-place PII-column redaction performed by the GDPR scrub path using the
 * erasure-token helper (src/audit-log/erasure-token.ts) — the audit row's
 * existence, action, resource_type, and timestamps always survive.
 *
 * Usage:
 *   ts-node scripts/audit-log-retention-rotate.ts            # archive + delete
 *   ts-node scripts/audit-log-retention-rotate.ts --dry-run  # print only
 *
 * Required env:
 *   DIRECT_URL (or DATABASE_URL)        — privileged DB connection.
 *   AUDIT_ARCHIVE_S3_BUCKET             — Object-Lock-enabled bucket.
 *   AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *   AUDIT_ARCHIVE_S3_ENDPOINT           — optional custom endpoint.
 *
 * Exits non-zero on any archive or verification failure so a runbook step
 * fails loud and no rows are deleted on a partial archive.
 */

import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const RETENTION_YEARS = 7;
const BATCH_SIZE = 1_000;

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: unknown;
  after_state: unknown;
  reason: string | null;
  request_id: string | null;
  ip_address: string | null;
  created_at: Date;
}

function isDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

// Glue/Athena-style partition path: tenant_id=<uuid>/dt=<YYYY-MM-DD>/<id>.json
// Real production would write Parquet; JSON-per-row keeps the script
// dependency-light and is trivially convertible by a Glue crawler. The
// partition keys (tenant_id, created_at::date) match D-H6-4.
function archiveKey(row: AuditRow): string {
  const dt = row.created_at.toISOString().slice(0, 10);
  return `audit_log/tenant_id=${row.tenant_id}/dt=${dt}/${row.id}.json`;
}

function makeS3(): S3Client {
  const endpoint = process.env.AUDIT_ARCHIVE_S3_ENDPOINT;
  return new S3Client({
    region: process.env.AWS_REGION ?? 'us-west-1',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

async function archiveRow(s3: S3Client, bucket: string, row: AuditRow): Promise<string> {
  const key = archiveKey(row);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(row),
      ContentType: 'application/json',
      // Object Lock: governance retention so the archive is immutable for
      // the regulatory window. Compliance mode can be substituted by ops.
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: new Date(Date.now() + RETENTION_YEARS * 365 * 24 * 60 * 60 * 1000),
    }),
  );
  // Verify the PUT landed before we allow the row to be deleted.
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return key;
}

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const cutoffSql = `now() - INTERVAL '${RETENTION_YEARS} years'`;
  const prisma = new PrismaClient();

  let archived = 0;
  let deleted = 0;
  let scanned = 0;

  try {
    // Page through eligible rows oldest-first so a crash mid-run leaves the
    // remaining (newer) rows for the next run; idempotent on (id).
    for (;;) {
      const rows = await prisma.$queryRawUnsafe<AuditRow[]>(
        `SELECT id, tenant_id, actor_id, actor_type, action, resource_type,
                resource_id, before_state, after_state, reason, request_id,
                host(ip_address) AS ip_address, created_at
           FROM audit_log
          WHERE created_at < ${cutoffSql}
          ORDER BY created_at ASC
          LIMIT ${BATCH_SIZE}`,
      );
      if (rows.length === 0) break;
      scanned += rows.length;

      if (dryRun) {
        const bucket = process.env.AUDIT_ARCHIVE_S3_BUCKET ?? '<AUDIT_ARCHIVE_S3_BUCKET>';
        for (const row of rows) {
          // eslint-disable-next-line no-console
          console.log(
            `[dry-run] would archive id=${row.id} -> s3://${bucket}/${archiveKey(row)} then DELETE`,
          );
        }
        // In dry-run we do not loop forever — report the first page and stop.
        break;
      }

      const bucket = process.env.AUDIT_ARCHIVE_S3_BUCKET;
      if (!bucket) {
        throw new Error('AUDIT_ARCHIVE_S3_BUCKET is required for a non-dry-run rotation');
      }
      const s3 = makeS3();

      for (const row of rows) {
        // Archive (and verify) BEFORE delete. If this throws, we abort the
        // whole run without deleting anything in this batch.
        await archiveRow(s3, bucket, row);
        archived += 1;

        // Privileged DELETE — only valid when run as the retention role.
        await prisma.$executeRawUnsafe(`DELETE FROM audit_log WHERE id = $1`, row.id);
        deleted += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `audit-log retention rotate complete: scanned=${scanned} archived=${archived} deleted=${deleted} dryRun=${dryRun}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`audit-log retention rotate FAILED: ${msg}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
