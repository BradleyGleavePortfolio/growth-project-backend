import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { DELETION_GRACE_PERIOD_DAYS } from './account.service';

// PII-scrub worker. Runs the second half of the GDPR delete lifecycle:
// any User row with deletion_scheduled_at older than the 30-day grace
// window is marked deleted_at and has its identifying fields zeroed out.
//
// Design notes / why this shape:
//
// - Soft-delete is preserved. We deliberately do NOT issue DELETE on the
//   User row — its FK fan-out is wide (CoachMessage, Invoice, ActivityEvent,
//   AuditLog.actor_id, …) and a hard delete would either cascade history
//   or fail RESTRICT. Instead we set deleted_at and overwrite PII columns
//   with deterministic, non-identifying tombstones. Coach-side billing,
//   audit, and analytics counters remain referentially intact.
//
// - The scrubbed email format (`deleted-{id}@scrub.invalid`) keeps the
//   email column @unique-safe (it embeds the user id) and uses the
//   reserved `.invalid` TLD per RFC 2606 so no real address ever collides.
//
// - We tombstone the Supabase id with the same `deleted-{id}` prefix so
//   the @unique constraint on supabase_id holds even after re-using a
//   freed Supabase user id (operators can also delete the Supabase user
//   row out-of-band — the scrub does not depend on that).
//
// - A separate `archived_at = now()` is set if not already present, so
//   coach-side rosters drop the row even when an operator scrubs early
//   for an out-of-band legal request.
//
// - Each scrubbed user gets exactly one `user.account_deleted` audit row
//   with `metadata.scope = 'gdpr_scrub_worker'`. The audit_email_snapshot
//   column intentionally captures the pre-scrub email so operators can
//   forensically tie a tombstoned user id back to the original account
//   without re-introducing PII into the User row.
//
// - Dry-run mode (input arg or env GDPR_SCRUB_DRY_RUN=true) reports
//   candidate row ids without writing anything. Used by both the admin
//   endpoint (`POST /admin/gdpr/scrub?dry_run=true`) and operators
//   wanting a sanity-check before flipping the cron job on.

export interface ScrubRunOptions {
  // Hard cap on the number of users processed in this run. Defaults to
  // GDPR_SCRUB_BATCH_LIMIT or 100 if unset; clamped to [1, 1000].
  limit?: number;
  // When true, identify candidates and return the report but make no
  // database writes. Useful for staging verification.
  dryRun?: boolean;
  // Override "now" — used by tests so they don't have to manipulate the
  // real wall-clock to push rows past the grace window.
  now?: Date;
  // Optional actor id (an OWNER triggering an ad-hoc scrub via the admin
  // endpoint). Cron-driven runs leave this null and the audit row is
  // attributed to actor=null + actorRole='system'.
  actorUserId?: string | null;
  actorEmail?: string | null;
}

export interface ScrubCandidate {
  user_id: string;
  email_snapshot: string;
  deletion_scheduled_at: Date;
  scheduled_for_purge_at: Date;
}

export interface ScrubReport {
  dry_run: boolean;
  grace_period_days: number;
  cutoff: string;
  considered: number;
  scrubbed: number;
  errors: Array<{ user_id: string; message: string }>;
  candidates: ScrubCandidate[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function resolveLimit(input?: number): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.min(Math.max(Math.trunc(input), 1), MAX_LIMIT);
  }
  const env = process.env.GDPR_SCRUB_BATCH_LIMIT;
  const parsed = env ? parseInt(env, 10) : NaN;
  if (Number.isFinite(parsed)) {
    return Math.min(Math.max(parsed, 1), MAX_LIMIT);
  }
  return DEFAULT_LIMIT;
}

function resolveDryRun(input: boolean | undefined): boolean {
  if (typeof input === 'boolean') return input;
  const env = (process.env.GDPR_SCRUB_DRY_RUN ?? '').toLowerCase();
  return env === 'true' || env === '1';
}

@Injectable()
export class GdprScrubService {
  private readonly logger = new Logger(GdprScrubService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // Pure helper — used by both run() and the dry-run admin endpoint.
  // Exposed for testability so callers can verify candidate selection
  // without writing.
  async findCandidates(now: Date, limit: number): Promise<ScrubCandidate[]> {
    const cutoff = new Date(
      now.getTime() - DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );
    const rows = await this.prisma.user.findMany({
      where: {
        deletion_scheduled_at: { lte: cutoff, not: null },
        deleted_at: null,
      },
      orderBy: { deletion_scheduled_at: 'asc' },
      take: limit,
      select: {
        id: true,
        email: true,
        deletion_scheduled_at: true,
      },
    });
    return rows.map((r) => ({
      user_id: r.id,
      email_snapshot: r.email,
      // Non-null by predicate above.
      deletion_scheduled_at: r.deletion_scheduled_at!,
      scheduled_for_purge_at: new Date(
        r.deletion_scheduled_at!.getTime() +
          DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      ),
    }));
  }

  async run(options: ScrubRunOptions = {}): Promise<ScrubReport> {
    const now = options.now ?? new Date();
    const limit = resolveLimit(options.limit);
    const dryRun = resolveDryRun(options.dryRun);

    const cutoff = new Date(
      now.getTime() - DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.findCandidates(now, limit);

    if (dryRun) {
      this.logger.log(
        `GDPR scrub dry-run: ${candidates.length} candidate(s) past cutoff ${cutoff.toISOString()}`,
      );
      return {
        dry_run: true,
        grace_period_days: DELETION_GRACE_PERIOD_DAYS,
        cutoff: cutoff.toISOString(),
        considered: candidates.length,
        scrubbed: 0,
        errors: [],
        candidates,
      };
    }

    const errors: ScrubReport['errors'] = [];
    let scrubbed = 0;
    for (const c of candidates) {
      try {
        await this.scrubOne(c, now, options);
        scrubbed += 1;
      } catch (err) {
        // A failure on one user (e.g. a UserProfile constraint) must not
        // poison the rest of the batch. Record and move on; the cron job
        // will retry on the next tick.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `GDPR scrub failed for user=${c.user_id}: ${message}`,
        );
        errors.push({ user_id: c.user_id, message });
      }
    }

    this.logger.log(
      `GDPR scrub: scrubbed ${scrubbed} of ${candidates.length} candidate(s); errors=${errors.length}`,
    );

    return {
      dry_run: false,
      grace_period_days: DELETION_GRACE_PERIOD_DAYS,
      cutoff: cutoff.toISOString(),
      considered: candidates.length,
      scrubbed,
      errors,
      candidates,
    };
  }

  // Tombstone a single user. All writes happen inside an interactive
  // Prisma transaction so a partial failure cannot leave the row with
  // (deleted_at set, email still PII) — the User update is the last
  // statement and rolls back the rest if it fails.
  private async scrubOne(
    candidate: ScrubCandidate,
    now: Date,
    options: ScrubRunOptions,
  ): Promise<void> {
    const tombstoneEmail = `deleted-${candidate.user_id}@scrub.invalid`;
    const tombstoneSupabaseId = `deleted-${candidate.user_id}`;

    await this.prisma.$transaction(async (tx) => {
      // 1) Zero out PII on UserProfile (1:1, may not exist).
      await tx.userProfile
        .updateMany({
          where: { user_id: candidate.user_id },
          data: {
            avatar_url: null,
            bio: null,
            date_of_birth: null,
            preferred_snacks: [],
            current_weight_lbs: null,
            target_weight_lbs: null,
            height_cm: null,
          },
        })
        .catch(() => undefined);

      // 2) Zero out NotificationPreferences (free-text fields). Untouched
      // booleans return to their default at re-creation; we don't delete
      // the row so coach-side joins keep their shape.
      await tx.notificationPreferences
        .updateMany({
          where: { user_id: candidate.user_id },
          data: {},
        })
        .catch(() => undefined);

      // 3) Soft-archive the user so coach rosters drop them immediately
      // even if an operator forced an early scrub.
      // 4) Tombstone PII on the User row + flip deleted_at.
      await tx.user.update({
        where: { id: candidate.user_id },
        data: {
          email: tombstoneEmail,
          name: 'Deleted user',
          phone: null,
          supabase_id: tombstoneSupabaseId,
          archived_at: now,
          deleted_at: now,
        },
      });
    });

    // Audit OUTSIDE the transaction. AuditService.write swallows its own
    // errors — a failed audit must not roll back the scrub, but it's
    // also not worth tying the audit insert to the same transaction
    // (the audit row is only meaningful if the scrub succeeded).
    await this.audit.write({
      action: AuditAction.USER_ACCOUNT_DELETED,
      actorId: options.actorUserId ?? null,
      actorRole: options.actorUserId ? 'owner' : 'system',
      actorEmail: options.actorEmail ?? null,
      targetUserId: candidate.user_id,
      targetType: 'user',
      targetId: candidate.user_id,
      metadata: {
        scope: 'gdpr_scrub_worker',
        deletion_scheduled_at: candidate.deletion_scheduled_at.toISOString(),
        grace_period_days: DELETION_GRACE_PERIOD_DAYS,
        original_email_snapshot: candidate.email_snapshot,
      },
    });
  }
}
