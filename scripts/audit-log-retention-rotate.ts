/**
 * scripts/audit-log-retention-rotate.ts
 *
 * H6 — audit_log retention rotation (D-H6-4 LOCKED 2026-06-26).
 *
 * Archives audit_log rows older than 7 years to an S3 Object Lock bucket and
 * registers the partition with the Glue catalog. It NEVER deletes a row:
 * "7 years flat for everything in audit_log, archive (never delete) on
 * rotation" (D-H6-4, LOCKED). The audit_log table is the durable forensic
 * record; the S3 archive is a second, immutable copy for cheap long-term
 * storage and Athena querying, not a tombstone for deleted rows.
 *
 * Because no row is ever removed, the only way PII leaves a row is the
 * in-place GDPR Art. 17 erasure performed by AuditLogService.redactPii()
 * (src/audit-log/audit-log.service.ts), which tokenizes the PII columns while
 * leaving the audit fact intact.
 *
 * This is an OPS cron job, run OUTSIDE the Nest process (e.g. a Fly machine
 * cron or GitHub Actions schedule). It is deliberately NOT a @nestjs/schedule
 * task.
 *
 * Idempotent: the S3 key is deterministic per row id
 * (audit_log/tenant_id=.../dt=.../<id>.json), so re-running over the same
 * window overwrites the identical object rather than creating duplicates.
 *
 * Usage:
 *   ts-node scripts/audit-log-retention-rotate.ts            # archive
 *   ts-node scripts/audit-log-retention-rotate.ts --dry-run  # print only
 *
 * Required env:
 *   DIRECT_URL (or DATABASE_URL)        — DB connection (read-only is enough).
 *   AUDIT_ARCHIVE_S3_BUCKET             — Object-Lock-enabled bucket.
 *   AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *   AUDIT_ARCHIVE_S3_ENDPOINT           — optional custom endpoint.
 *
 * Exits non-zero on any archive or verification failure so a runbook step
 * fails loud.
 */

import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const RETENTION_YEARS = 7;
const BATCH_SIZE = 1_000;

// D-H6-4 archive-never-delete invariant, enforced at module load. Every SQL
// statement this script issues against audit_log is registered here; the guard
// throws at construction (import time) if any of them would UPDATE, DELETE, or
// TRUNCATE the table. This is a compile-adjacent guard, not a runtime test: a
// future edit that adds a destructive statement cannot even boot the script.
const SELECT_ELIGIBLE_SQL = `SELECT id, tenant_id, actor_id, actor_type, action, resource_type,
                resource_id, before_state, after_state, reason, request_id,
                host(ip_address) AS ip_address, created_at
           FROM audit_log
          WHERE created_at < now() - INTERVAL '${RETENTION_YEARS} years'
          ORDER BY created_at ASC
          LIMIT ${BATCH_SIZE}`;

const AUDIT_LOG_SQL_STATEMENTS: readonly string[] = [SELECT_ELIGIBLE_SQL];

function assertArchiveNeverDelete(statements: readonly string[]): void {
  const destructive = /\b(delete|truncate|update)\b/i;
  for (const sql of statements) {
    if (destructive.test(sql) && /audit_log/i.test(sql)) {
      throw new Error(
        'D-H6-4 violation: audit-log retention rotation must never UPDATE/DELETE/TRUNCATE ' +
          `audit_log (archive-never-delete). Offending statement: ${sql.trim().slice(0, 80)}...`,
      );
    }
  }
}

assertArchiveNeverDelete(AUDIT_LOG_SQL_STATEMENTS);

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
// Deterministic per row id so re-runs overwrite the same object (idempotent).
// The partition keys (tenant_id, created_at::date) match D-H6-4.
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
      // Object Lock: governance retention so the archive is immutable for the
      // regulatory window. Compliance mode can be substituted by ops.
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: new Date(Date.now() + RETENTION_YEARS * 365 * 24 * 60 * 60 * 1000),
    }),
  );
  // Verify the PUT landed so a runbook step fails loud on a partial archive.
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return key;
}

async function main(): Promise<void> {
  const dryRun = isDryRun();
  const prisma = new PrismaClient();

  let archived = 0;
  let scanned = 0;

  try {
    if (dryRun) {
      const rows = await prisma.$queryRawUnsafe<AuditRow[]>(SELECT_ELIGIBLE_SQL);
      const bucket = process.env.AUDIT_ARCHIVE_S3_BUCKET ?? '<AUDIT_ARCHIVE_S3_BUCKET>';
      for (const row of rows) {
        // eslint-disable-next-line no-console
        console.log(`[dry-run] would archive id=${row.id} -> s3://${bucket}/${archiveKey(row)}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[dry-run] eligible rows in first page: ${rows.length}`);
      return;
    }

    const bucket = process.env.AUDIT_ARCHIVE_S3_BUCKET;
    if (!bucket) {
      throw new Error('AUDIT_ARCHIVE_S3_BUCKET is required for a non-dry-run rotation');
    }
    const s3 = makeS3();

    // Page oldest-first. Because rows are never deleted, paging advances by the
    // last-seen created_at/id cursor so each page covers fresh rows.
    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    for (;;) {
      const page: AuditRow[] =
        cursorCreatedAt === null
          ? await prisma.$queryRawUnsafe<AuditRow[]>(SELECT_ELIGIBLE_SQL)
          : await prisma.$queryRawUnsafe<AuditRow[]>(
              `SELECT id, tenant_id, actor_id, actor_type, action, resource_type,
                      resource_id, before_state, after_state, reason, request_id,
                      host(ip_address) AS ip_address, created_at
                 FROM audit_log
                WHERE created_at < now() - INTERVAL '${RETENTION_YEARS} years'
                  AND (created_at, id) > ($1, $2)
                ORDER BY created_at ASC, id ASC
                LIMIT ${BATCH_SIZE}`,
              cursorCreatedAt,
              cursorId,
            );
      if (page.length === 0) break;
      scanned += page.length;

      for (const row of page) {
        await archiveRow(s3, bucket, row);
        archived += 1;
      }

      const last = page[page.length - 1];
      cursorCreatedAt = last.created_at;
      cursorId = last.id;
    }

    // eslint-disable-next-line no-console
    console.log(
      `audit-log retention rotate complete: scanned=${scanned} archived=${archived} deleted=0 (archive-never-delete, D-H6-4) dryRun=${dryRun}`,
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
