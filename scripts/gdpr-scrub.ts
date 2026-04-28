/**
 * scripts/gdpr-scrub.ts
 *
 * Run the GDPR PII-scrub worker against the live database.
 *
 * Behavior is the same as POST /api/admin/gdpr/scrub but invoked
 * out-of-band so it can be wired to a Fly cron job or Kubernetes
 * CronJob. The worker:
 *
 *   1. Selects up to GDPR_SCRUB_BATCH_LIMIT users whose
 *      `deletion_scheduled_at` is older than 30 days and whose
 *      `deleted_at` is still null.
 *   2. For each candidate, inside an interactive transaction:
 *        - tombstones email/name/phone/supabase_id on the User row;
 *        - zeroes out PII columns on UserProfile (avatar, bio, DOB,
 *          weights, snacks);
 *        - sets `deleted_at = now()` and `archived_at = now()`.
 *   3. Writes one `user.account_deleted` audit row per scrubbed user
 *      with `metadata.scope = 'gdpr_scrub_worker'` and the original
 *      email captured as `actor_email_snapshot` for forensic traceability.
 *
 * Failure of one user does not poison the rest of the batch — the
 * affected user id and error are returned in the report and the cron
 * tick will retry on the next run.
 *
 * Usage:
 *   # Real run, default cap (100):
 *   npx ts-node scripts/gdpr-scrub.ts
 *
 *   # Dry-run (no writes):
 *   GDPR_SCRUB_DRY_RUN=true npx ts-node scripts/gdpr-scrub.ts
 *
 *   # Tighter batch:
 *   GDPR_SCRUB_BATCH_LIMIT=25 npx ts-node scripts/gdpr-scrub.ts
 *
 * Exit codes:
 *   0 — completed (even if some individual users errored; per-user
 *       errors are in the report). Suitable for cron schedulers.
 *   1 — fatal: could not connect to the database, or the worker threw
 *       before any candidates were considered. Cron should retry.
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { GdprScrubService } from '../src/users/gdpr-scrub.service';

async function main() {
  const logger = new Logger('gdpr-scrub');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const svc = app.get(GdprScrubService);
    const report = await svc.run({});
    logger.log(`scrub-report ${JSON.stringify(report)}`);
    if (report.errors.length) {
      logger.warn(
        `gdpr-scrub: ${report.errors.length} per-user error(s); see report above`,
      );
    }
  } catch (err) {
    logger.error(`gdpr-scrub fatal: ${(err as Error)?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main();
