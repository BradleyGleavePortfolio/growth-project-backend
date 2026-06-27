import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SupabaseService } from '../supabase/supabase.service';

// ─── State machine ────────────────────────────────────────────────────────────
// User-initiated two-phase deletion:
//
//   NONE       → REQUESTED   POST /me/delete-account
//                             token emailed; deletion_requested_at + token_hash set
//
//   REQUESTED  → CONFIRMED   GET  /me/delete-account/confirm?token=...
//                             deletion_confirmed_at set; grace period starts
//
//   CONFIRMED  → DELETED     nightly cron (DELETION_FINALIZE_CRON)
//                             PII scrubbed after DELETION_GRACE_DAYS
//
// Cancel endpoint resets REQUESTED or CONFIRMED → NONE (available during grace).
//
// Admin-initiated:
//   ANY → DELETED             POST /admin/users/:id/delete
//                             hard-delete bypasses confirmation and grace period;
//                             always writes a deletion_audit row
// ─────────────────────────────────────────────────────────────────────────────

// Sentinel user ID used in place of the real user_id when anonymizing
// CoachMessage and AuditLog rows. A real User row with this exact ID must
// exist in the database (bootstrapped by the GDPR migration's seed step or
// created by your bootstrap script). The sentinel row has role='student',
// email='__deleted_user__@tombstone.invalid', and is never accessible through
// the API.
export const DELETED_USER_SENTINEL_ID = '__deleted_user_sentinel__';

export const DeletionAuditEvent = {
  DELETION_REQUESTED: 'deletion_requested',
  DELETION_CONFIRMED: 'deletion_confirmed',
  DELETION_CANCELLED: 'deletion_cancelled',
  DELETION_FINALIZED: 'deletion_finalized',
  ADMIN_FORCE_DELETE: 'admin_force_delete',
} as const;

export type DeletionAuditEventValue = (typeof DeletionAuditEvent)[keyof typeof DeletionAuditEvent];

export interface DeletionStatus {
  state: 'none' | 'requested' | 'confirmed' | 'deleted';
  requested_at?: string;
  confirmed_at?: string;
  grace_days?: number;
  purge_after?: string;
  deleted_at?: string;
}

export interface AdminDeleteOptions {
  actorId: string;
  actorRole: string;
  actorEmail: string | null;
  reason?: string;
  ip?: string | null;
  userAgent?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    // H6 (D-H6-3): structured same-transaction audit substrate. Optional so
    // legacy direct-construction specs keep compiling; AuditLogModule is
    // @Global so production DI always populates it.
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  // ── Env helpers ─────────────────────────────────────────────────────────────

  private get graceDays(): number {
    const raw = this.config.get<string>('DELETION_GRACE_DAYS');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
  }

  private get tokenTtlHours(): number {
    const raw = this.config.get<string>('DELETION_TOKEN_TTL_HOURS');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  }

  // ── Token helpers ────────────────────────────────────────────────────────────

  /** Generate a cryptographically random single-use token and its SHA-256 hash. */
  private generateToken(): { token: string; hash: string } {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return { token, hash };
  }

  /** Hash an inbound token so it can be compared against the stored hash. */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // ── Step 1: Request deletion (sends confirmation email) ──────────────────────

  async requestDeletion(
    userId: string,
    opts: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ message: string; expires_at: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) throw new BadRequestException('Account is already deleted');

    // Idempotent — if a valid token already exists return the same expiry
    // without sending another email (prevents enumeration / token flooding).
    if (
      user.deletion_token_hash &&
      user.deletion_token_expires_at &&
      user.deletion_token_expires_at > new Date() &&
      user.deletion_requested_at
    ) {
      return {
        message:
          'A deletion request is already pending for your account. You can cancel it from Settings.',
        expires_at: user.deletion_token_expires_at.toISOString(),
      };
    }

    const { token, hash } = this.generateToken();
    const expiresAt = new Date(Date.now() + this.tokenTtlHours * 60 * 60 * 1000);
    const now = new Date();

    // H6 (D-H6-3): scheduling an account deletion is a high-stakes PII
    // mutation; record an audit row in the same transaction.
    const requestArgs: Prisma.UserUpdateArgs = {
      where: { id: userId },
      data: {
        deletion_requested_at: now,
        // Reset any prior confirmed state so the user has to re-confirm
        deletion_confirmed_at: null,
        deletion_token_hash: hash,
        deletion_token_expires_at: expiresAt,
      },
    };
    if (this.auditLog) {
      await this.auditLog.withAuditLog(
        {
          tenantId: userId,
          actorId: userId,
          actorType: 'user',
          action: 'update',
          resourceType: 'User',
          resourceId: userId,
          afterState: { deletion_requested: true },
          reason: 'account.deletion_requested',
        },
        (tx) => tx.user.update(requestArgs),
      );
    } else {
      await this.prisma.user.update(requestArgs);
    }

    // Send confirmation email via the same infra as Phase 9 digests.
    // If the email module is not yet wired, we log and continue — a missing
    // email is operational, not a data-integrity failure.
    await this.sendConfirmationEmail(user.email, user.name, token, expiresAt).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `AccountDeletion: failed to send confirmation email to user=${userId}: ${msg}`,
        );
      },
    );

    await this.writeDeletionAudit({
      userId,
      event: DeletionAuditEvent.DELETION_REQUESTED,
      actorId: userId,
      actorRole: user.role,
      metadata: {
        email_snapshot: user.email,
        ip: opts.ip,
        user_agent: opts.userAgent,
        token_expires_at: expiresAt.toISOString(),
      },
    });

    // Mirror to global AuditLog so the admin console shows this event.
    await this.auditService.write({
      action: 'account_deletion.requested',
      actorId: userId,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      metadata: { token_expires_at: expiresAt.toISOString() },
    });

    return {
      message:
        'Your deletion request has been received. A confirmation link will be sent to your email when email delivery is configured. You have 24 hours to confirm. You can cancel at any time from Settings.',
      expires_at: expiresAt.toISOString(),
    };
  }

  // ── Step 2: Confirm via one-time email link ───────────────────────────────────

  async confirmDeletion(token: string): Promise<{ message: string; purge_after: string }> {
    const hash = this.hashToken(token);

    const user = await this.prisma.user.findFirst({
      where: { deletion_token_hash: hash },
    });

    if (!user) {
      // Return 401 rather than 404 to avoid oracle: "this token doesn't exist
      // vs this token expired" are indistinguishable to the client.
      throw new UnauthorizedException('Invalid or expired confirmation link');
    }
    if (!user.deletion_token_expires_at || user.deletion_token_expires_at < new Date()) {
      throw new UnauthorizedException('Confirmation link has expired');
    }
    if (user.deleted_at) {
      throw new BadRequestException('Account is already deleted');
    }

    const now = new Date();
    const purgeAfter = new Date(now.getTime() + this.graceDays * 24 * 60 * 60 * 1000);

    // Consume the token (single-use): clear hash + expiry, set confirmed_at.
    const confirmArgs = {
      where: { id: user.id },
      data: {
        deletion_confirmed_at: now,
        deletion_token_hash: null,
        deletion_token_expires_at: null,
      },
    } as const;
    // H6 (D-H6-3): confirming a deletion schedules a user's PII for purge —
    // audit it in the same txn. afterState carries flags only (R98).
    if (this.auditLog) {
      await this.auditLog.withAuditLog(
        {
          tenantId: user.id,
          actorId: user.id,
          actorType: 'user',
          action: 'update',
          resourceType: 'User',
          resourceId: user.id,
          afterState: { deletion_confirmed: true },
          reason: 'account.deletion_confirmed',
        },
        (tx) => tx.user.update(confirmArgs),
      );
    } else {
      await this.prisma.user.update(confirmArgs);
    }

    await this.writeDeletionAudit({
      userId: user.id,
      event: DeletionAuditEvent.DELETION_CONFIRMED,
      actorId: user.id,
      actorRole: user.role,
      metadata: {
        email_snapshot: user.email,
        grace_days: this.graceDays,
        purge_after: purgeAfter.toISOString(),
      },
    });

    await this.auditService.write({
      action: 'account_deletion.confirmed',
      actorId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: user.id,
      targetType: 'user',
      targetId: user.id,
      metadata: { grace_days: this.graceDays, purge_after: purgeAfter.toISOString() },
    });

    return {
      message: `Your account is scheduled for permanent deletion on ${purgeAfter.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. You have ${this.graceDays} days to cancel.`,
      purge_after: purgeAfter.toISOString(),
    };
  }

  // ── Step 3: Cancel (within grace period) ─────────────────────────────────────

  async cancelDeletion(
    userId: string,
    opts: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) throw new BadRequestException('Account is already deleted');

    const hasRequest = !!user.deletion_requested_at;
    const hasConfirm = !!user.deletion_confirmed_at;

    if (!hasRequest && !hasConfirm) {
      throw new BadRequestException('No pending deletion request to cancel');
    }

    // If confirmed, ensure we're still within the grace window
    if (hasConfirm) {
      const graceEnd = new Date(
        user.deletion_confirmed_at!.getTime() + this.graceDays * 24 * 60 * 60 * 1000,
      );
      if (new Date() > graceEnd) {
        throw new BadRequestException(
          'The grace period has expired. Your account is being finalized for deletion.',
        );
      }
    }

    // H6 (D-H6-3): cancelling a pending deletion is also a PII-state
    // mutation; wrap it in withAuditLog().
    const cancelArgs: Prisma.UserUpdateArgs = {
      where: { id: userId },
      data: {
        deletion_requested_at: null,
        deletion_confirmed_at: null,
        deletion_token_hash: null,
        deletion_token_expires_at: null,
      },
    };
    if (this.auditLog) {
      await this.auditLog.withAuditLog(
        {
          tenantId: userId,
          actorId: userId,
          actorType: 'user',
          action: 'update',
          resourceType: 'User',
          resourceId: userId,
          afterState: { deletion_requested: false },
          reason: 'account.deletion_cancelled',
        },
        (tx) => tx.user.update(cancelArgs),
      );
    } else {
      await this.prisma.user.update(cancelArgs);
    }

    await this.writeDeletionAudit({
      userId,
      event: DeletionAuditEvent.DELETION_CANCELLED,
      actorId: userId,
      actorRole: user.role,
      metadata: {
        was_confirmed: hasConfirm,
        ip: opts.ip,
        user_agent: opts.userAgent,
      },
    });

    await this.auditService.write({
      action: 'account_deletion.cancelled',
      actorId: userId,
      actorRole: user.role,
      actorEmail: user.email,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
    });

    return { message: 'Your deletion request has been cancelled. Your account is active.' };
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  async getDeletionStatus(userId: string): Promise<DeletionStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        deleted_at: true,
        deletion_requested_at: true,
        deletion_confirmed_at: true,
        deletion_token_expires_at: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.deleted_at) {
      return { state: 'deleted', deleted_at: user.deleted_at.toISOString() };
    }
    if (user.deletion_confirmed_at) {
      const purgeAfter = new Date(
        user.deletion_confirmed_at.getTime() + this.graceDays * 24 * 60 * 60 * 1000,
      );
      return {
        state: 'confirmed',
        confirmed_at: user.deletion_confirmed_at.toISOString(),
        grace_days: this.graceDays,
        purge_after: purgeAfter.toISOString(),
      };
    }
    if (user.deletion_requested_at) {
      return {
        state: 'requested',
        requested_at: user.deletion_requested_at.toISOString(),
      };
    }
    return { state: 'none' };
  }

  // ── Admin force-delete ────────────────────────────────────────────────────────

  /**
   * Immediately scrub PII and finalize the account. No grace period.
   * Only reachable by OWNER-role admins.
   *
   * IMPORTANT: this is audited both in deletion_audit and AuditLog. The
   * dual write is intentional so GDPR auditors and security teams each
   * have their own query surface.
   */
  async adminForceDelete(
    targetUserId: string,
    opts: AdminDeleteOptions,
  ): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.deleted_at) {
      // Idempotent — already deleted.
      return { message: 'Account is already deleted (no-op).' };
    }

    await this.finalizeUserDeletion(targetUserId, {
      isAdminForced: true,
      actorId: opts.actorId,
    });

    await this.writeDeletionAudit({
      userId: targetUserId,
      event: DeletionAuditEvent.ADMIN_FORCE_DELETE,
      actorId: opts.actorId,
      actorRole: opts.actorRole,
      metadata: {
        email_snapshot: user.email,
        reason: opts.reason ?? null,
        ip: opts.ip,
        user_agent: opts.userAgent,
      },
    });

    await this.auditService.write({
      action: 'account_deletion.admin_force_delete',
      actorId: opts.actorId,
      actorRole: opts.actorRole,
      actorEmail: opts.actorEmail,
      targetUserId,
      targetType: 'user',
      targetId: targetUserId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      metadata: {
        reason: opts.reason ?? null,
        original_email_snapshot: user.email,
      },
    });

    return { message: `User ${targetUserId} has been permanently deleted.` };
  }

  // ── Nightly finalize cron ─────────────────────────────────────────────────────
  //
  // Runs at 03:00 UTC by default (DELETION_FINALIZE_CRON env). Finds all
  // users whose deletion_confirmed_at is older than DELETION_GRACE_DAYS and
  // whose deleted_at is still null, then finalizes them one by one.
  //
  // Idempotent: re-running against already-finalized rows is a safe no-op
  // because the WHERE predicate filters on deleted_at IS NULL.

  // 03:00 UTC slot in the nightly cron stagger. The pre-Connect cleanup
  // splits four 03:00 jobs across 15-minute windows (alphabetical by class
  // name) so the worker doesn't fan out four heavy reads against the same
  // Postgres connection pool at the same instant:
  //   AccountDeletionService    -> 03:00 (this)
  //   BloodworkStaleScheduler   -> 03:15
  //   DataExportCleanupCron     -> 03:30
  //   GdprScrubScheduler        -> 03:45
  // Override via DELETION_FINALIZE_CRON only when the operator deliberately
  // wants a different slot — the default keeps the stagger intact.
  @Cron(process.env['DELETION_FINALIZE_CRON'] ?? '0 3 * * *')
  async runFinalizeCron(): Promise<void> {
    this.logger.log('AccountDeletion finalize cron: starting');

    const cutoff = new Date(Date.now() - this.graceDays * 24 * 60 * 60 * 1000);

    const candidates = await this.prisma.user.findMany({
      where: {
        deletion_confirmed_at: { lte: cutoff, not: null },
        deleted_at: null,
      },
      select: { id: true, email: true },
      orderBy: { deletion_confirmed_at: 'asc' },
      take: 500, // safety batch cap
    });

    this.logger.log(
      `AccountDeletion finalize cron: ${candidates.length} candidate(s) past cutoff ${cutoff.toISOString()}`,
    );

    let finalized = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    for (const candidate of candidates) {
      try {
        const result = await this.finalizeUserDeletion(candidate.id, { isAdminForced: false });

        if (result && result.skipped) {
          this.logger.log(
            `AccountDeletion finalize: skipped user=${candidate.id} reason=${result.skipped}`,
          );
          continue;
        }

        await this.writeDeletionAudit({
          userId: candidate.id,
          event: DeletionAuditEvent.DELETION_FINALIZED,
          actorId: null,
          actorRole: 'system',
          metadata: {
            email_snapshot: candidate.email,
            grace_days: this.graceDays,
            cutoff: cutoff.toISOString(),
          },
        });

        await this.auditService.write({
          action: 'account_deletion.finalized',
          actorId: null,
          actorRole: 'system',
          targetUserId: candidate.id,
          targetType: 'user',
          targetId: candidate.id,
          metadata: { email_snapshot: candidate.email, grace_days: this.graceDays },
        });

        finalized += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`AccountDeletion finalize: failed for user=${candidate.id}: ${msg}`);
        errors.push({ userId: candidate.id, error: msg });
      }
    }

    this.logger.log(
      `AccountDeletion finalize cron: finalized=${finalized} errors=${errors.length}`,
    );
  }

  // ── Core PII scrub (per-model cascade strategy) ───────────────────────────────
  //
  // CASCADE STRATEGY — documented inline so every future engineer knows why
  // each model was handled this way. Edit the comment here when schema changes.
  //
  // HARD DELETE (row gone, FK referencing user_id also gone):
  //   • User row itself (last, inside the transaction)
  //   • UserProfile — personal biometric PII (height, DOB, body composition)
  //   • NotificationPreferences — no intrinsic value once user is gone
  //   • UserPreferences — local personalization only, no value to other party
  //   • LoggedFoodEntry — pure client calorie data, no coach dependency
  //   • WorkoutSession + ExerciseSet (cascade) — client training records
  //   • FastingWindow — client-only log
  //   • WeightLog — biometric PII
  //   • WaterLog — health data
  //   • CheckIn — daily diary entries
  //   • HabitLog + Habit (cascade) — client habit tracking
  //   • LessonCompletion — client progress through coach content
  //   • CommunityWin — the user's own posts
  //   • SavedRecipe — client-side bookmark, no shared value
  //   • ListItem — client grocery/prep lists
  //   • ClientSignal — PTM raw signals (scrubbing; retain aggregates via PtmPrediction anonymize)
  //   • ClientOutcome — PTM teaching label; labelled_by_id set to null via schema SetNull
  //   • PtmPrediction — risk/success scores contain user_id; purge
  //   • CoachEffectivenessScore — linked to coach user, not client; only delete if target IS coach
  //   • CoachAlert — remove alerts where either party is the deleted user
  //   • CoachOnboardingProgress — delete if user was a coach
  //   • CoachProfile — delete if user was a coach
  //   • CoachSubscription — delete if user was a coach
  //   • Invoice — delete if user was a coach (financial records must be kept per local law — NOTE: consider archiving off-platform rather than deleting for 7 years per UK law)
  //   • PaymentFailure — delete if user was a coach
  //   • MessageDraft — delete
  //   • InviteCode — delete if user was a coach
  //   • BuildWeekEnrollment + BuildWeekDayCompletion (cascade) — client progress
  //   • DataExportRequest — delete (payload is user's own data)
  //   • ClientCoachConsent — delete (consent record was consent to use data; no data = no consent needed)
  //   • ActivityEvent — delete where actor/coach/client matches
  //   • DiagnosticSubmission — nullify user_id (keep for lead analytics); see note below
  //
  // ANONYMIZE (user_id replaced with sentinel "__deleted_user_sentinel__"):
  //   • CoachMessage — preserve thread integrity for the OTHER party (coach or other client)
  //     who still has their own copy of the conversation. Replacing with sentinel keeps
  //     the message row valid so coach UI doesn't crash on orphan sender_id.
  //     Body text is cleared to remove the deleted user's actual words.
  //   • AuditLog (target_user_id) — compliance record must survive; the target column
  //     is nullable by schema (SetNull). actor_id is set to null so the scrubbed user's
  //     authorship is removed while the event itself is preserved.
  //   • MealPlan — the meal plan has a coach side (coach_id) and client side (client_id).
  //     If the deleted user is the CLIENT, nullify client_id. If they are the COACH, nullify coach_id.
  //     The plan content itself is not the deleted user's PII and is retained for the coach.
  //   • CoachGuideline — if deleted user is CLIENT, delete row entirely.
  //     If deleted user is COACH, set coach_id → sentinel (guideline content was created by coach).
  //   • CoachNudge — clear body, replace client_id/coach_id with sentinel as appropriate
  //
  // NOT TOUCHED:
  //   • DiagnosticSubmission.user_id → set NULL (no FK cascade, per schema comment: analytics)
  //   • AiRoadmap — belongs to DiagnosticSubmission; keep for funnel analytics
  //   • Recipe (created_by) → keep recipes (they are content shared to all; creator_id set null)
  //   • Lesson (coach_id) → keep lessons; set coach_id to null
  //   • WorkoutRoutine (creator_id) → delete if user is owner; keep if coach re-shares

  private async finalizeUserDeletion(
    userId: string,
    opts: { isAdminForced: boolean; actorId?: string },
  ): Promise<{ skipped?: string } | void> {
    // Pre-flight re-read (A1-C5-P1-4): abort early if the user cancelled
    // their deletion request after the cron snapshotted the candidates list.
    // This check is intentionally BEFORE the heavy anonymization steps so we
    // never touch PII for a user who cancelled mid-cron.
    //
    // The admin-force-delete path (opts.isAdminForced=true) bypasses this check
    // because it is a one-shot intentional scrub that does not require the user
    // to have deletion_confirmed_at set.
    if (!opts.isAdminForced) {
      const preCheck = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { deletion_confirmed_at: true, deleted_at: true },
      });
      if (!preCheck) return { skipped: 'user-not-found' };
      if (preCheck.deleted_at) return { skipped: 'already-deleted' };
      if (!preCheck.deletion_confirmed_at) {
        this.logger.warn(`finalizeUserDeletion: cancelled mid-cron for ${userId} — aborting scrub`);
        return { skipped: 'cancelled' };
      }
    }

    const tombstoneEmail = `deleted-${userId}@tombstone.invalid`;
    const tombstoneSupabaseId = `deleted-${userId}`;
    const now = new Date();

    // We process anonymizations BEFORE the transaction that deletes the User row,
    // because the sentinel row must exist before we can FK-reference it.
    // These operations are NOT transactional in the DB sense, but they are
    // idempotent so re-running after a partial failure is safe.

    // ── 1. Anonymize CoachMessage rows ────────────────────────────────────
    // Anonymize all CoachMessage rows where the deleted user is client, sender,
    // or coach. Body text is cleared on rows where they were the sender.
    // FK columns (client_id, coach_id, sender_id) are left pointing at the
    // tombstoned user row — the tombstone email/name are scrubbed so no PII leaks.
    // This preserves thread structure for the other participant.
    await this.prisma.coachMessage
      .updateMany({
        where: { sender_id: userId },
        data: { body: null },
      })
      .catch(() => undefined);
    // coach_id rows: body is NOT cleared (coach authored these; no other participant's
    // data is affected — only the relationship is preserved for billing/audit).
    // No additional update needed for coach_id; FK stays tombstoned.
    // ── 2. Nullify AuditLog actor_id for rows where actor is deleted user ───
    // Compliance: the event record stays; just the actor attribution is removed.
    await this.prisma.auditLog
      .updateMany({
        where: { actor_id: userId },
        data: { actor_id: null },
      })
      .catch(() => undefined);

    // ── 3. Delete MealPlan rows where user is client or coach ───────────────
    // Both coach_id and client_id are non-nullable in the schema (no FK cascade
    // to null). MealPlans are session-level content scoped to the coach-client
    // relationship; once either party is deleted the plan is removed.
    await this.prisma.mealPlan
      .deleteMany({
        where: { OR: [{ client_id: userId }, { coach_id: userId }] },
      })
      .catch(() => undefined);

    // ── 4. Nullify DiagnosticSubmission.user_id ──────────────────────────────
    await this.prisma.diagnosticSubmission
      .updateMany({ where: { user_id: userId }, data: { user_id: null } })
      .catch(() => undefined);

    // ── 5. Delete Recipe rows created by this user ──────────────────────
    // created_by_id is non-nullable in the schema. Recipes authored by the
    // deleted user are hard-deleted per GDPR. If you need to preserve coach
    // recipes for other clients, make created_by_id nullable in a future
    // migration and switch this to an updateMany nullification.
    await this.prisma.recipe
      .deleteMany({ where: { created_by_id: userId } })
      .catch(() => undefined);

    // ── 6. Delete Lesson rows where this user was the coach ──────────
    // coach_id is non-nullable. LessonCompletion rows cascade via their FK.
    await this.prisma.lesson
      .deleteMany({ where: { coach_id: userId } })
      .catch((err) =>
        this.logger.warn(
          `finalizeUserDeletion: lesson deleteMany failed for ${userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    // ── 7. Delete WorkoutRoutine rows created by this user ────────────
    // creator_id is non-nullable. RoutineExercise rows cascade.
    await this.prisma.workoutRoutine
      .deleteMany({ where: { creator_id: userId } })
      .catch(() => undefined);

    // ── 8. Delete CoachGuideline rows where this user was the coach ────────────
    // coach_id is non-nullable. If the deleted user was a coach, their guideline
    // rows are deleted (the client relationship is severed anyway since the coach
    // account no longer exists). The client_id rows are deleted below in step 10.
    await this.prisma.coachGuideline
      .deleteMany({ where: { coach_id: userId } })
      .catch(() => undefined);

    // ── 9. Delete CoachNudge rows where user is coach or client ─────────────
    // coach_id and client_id are non-nullable. Nudges are ephemeral coach-to-
    // client notifications; deleting them when either party is removed is safe.
    await this.prisma.coachNudge
      .deleteMany({
        where: { OR: [{ client_id: userId }, { coach_id: userId }] },
      })
      .catch(() => undefined);

    // ── 10. Delete rows with hard-delete cascade (no FK deps from other tables) ─
    // Most cascade deletions are handled below via the transactional User delete,
    // but some relations need explicit deletes because their FK is NOT the
    // direct user_id column or they reference via a different path.

    // CoachAlert — both coach_id and client_id must be cleaned
    await this.prisma.coachAlert
      .deleteMany({
        where: { OR: [{ coach_id: userId }, { client_id: userId }] },
      })
      .catch(() => undefined);

    // ActivityEvent — actor/coach/client can all be the deleted user
    await this.prisma.activityEvent
      .deleteMany({
        where: {
          OR: [{ actor_id: userId }, { coach_id: userId }, { client_id: userId }],
        },
      })
      .catch(() => undefined);

    // MessageDraft — coach_id and client_id
    await this.prisma.messageDraft
      .deleteMany({
        where: { OR: [{ coach_id: userId }, { client_id: userId }] },
      })
      .catch(() => undefined);

    // CoachGuideline — client_id rows (coach_id already nullified above)
    await this.prisma.coachGuideline
      .deleteMany({ where: { client_id: userId } })
      .catch(() => undefined);

    // CommunityWin — coach_id reference (author rows handled via cascade)
    await this.prisma.communityWin
      .updateMany({ where: { coach_id: userId }, data: { coach_id: null } })
      .catch(() => undefined);

    // ── 11. Revoke Supabase auth identity ──────────────────────────────────
    // Best-effort: a failure here is logged but does not block local deletion.
    // Placed OUTSIDE the $transaction because Supabase is an external call.
    try {
      const originalUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { supabase_id: true },
      });
      if (originalUser?.supabase_id && !originalUser.supabase_id.startsWith('deleted-')) {
        const adminClient = this.supabase.getClient();
        await adminClient.auth.admin.deleteUser(originalUser.supabase_id);
      }
    } catch (supabaseErr) {
      this.logger.error(
        `Failed to delete Supabase auth user for ${userId}: ${(supabaseErr as Error).message}. ` +
          'Local deletion proceeding — Supabase user may need manual cleanup.',
      );
    }

    // ── 12. Final transaction: delete user-owned rows + tombstone User ────────
    // H6 (D-H6-3): the final tombstone scrub is the canonical GDPR Art.17
    // erasure write — audit the scrub action itself (meta-audit). The entire
    // existing transaction body is handed to withAuditLog() unchanged so the
    // audit row commits in the same transaction as the tombstone; afterState
    // carries flags only (R98), never the scrubbed PII.
    const finalizeScrub = async (tx: Prisma.TransactionClient) => {
      // Re-read inside the transaction (A1-C5-P1-4 belt-and-suspenders):
      // A cancel could have arrived between the pre-flight check above and
      // the transaction start. Re-verify here under serializable-ish
      // transaction isolation before any destructive writes.
      if (!opts.isAdminForced) {
        const fresh = await tx.user.findUnique({
          where: { id: userId },
          select: { deletion_confirmed_at: true, deleted_at: true },
        });
        if (!fresh) return;
        if (fresh.deleted_at) return;
        if (!fresh.deletion_confirmed_at) {
          this.logger.warn(
            `finalizeUserDeletion tx: cancelled mid-cron for ${userId} — aborting scrub`,
          );
          return;
        }
      }

      // Belt-and-suspenders: explicitly delete Message rows where the user is
      // sender OR recipient BEFORE the User tombstone below.
      //
      // WHY explicit even though FKs are CASCADE?
      //   The FK cascade (added in migration 20260613000001_message_fk_cascade)
      //   guarantees no FK violation when the User row is deleted. However, the
      //   explicit deleteMany here serves two additional purposes:
      //     1. Gives us a concrete `count` we can log for GDPR audit trails.
      //     2. Makes the intent self-documenting — a future engineer reading
      //        this function can see that Message cleanup is intentional, not
      //        accidentally omitted.
      // (Finding 2 — CRITICAL, audit 2026-05-19)
      const deletedMessages = await tx.message.deleteMany({
        where: { OR: [{ sender_id: userId }, { recipient_id: userId }] },
      });
      this.logger.log(
        `[finalizeUserDeletion] deleted ${deletedMessages.count} Message row(s) for user ${userId}`,
      );

      // Hard-delete rows that are purely owned by this user (no cross-user FK dep):
      await tx.loggedFoodEntry.deleteMany({ where: { user_id: userId } });
      await tx.workoutSession.deleteMany({ where: { user_id: userId } });
      await tx.fastingWindow.deleteMany({ where: { user_id: userId } });
      await tx.weightLog.deleteMany({ where: { user_id: userId } });
      await tx.waterLog.deleteMany({ where: { user_id: userId } });
      await tx.checkIn.deleteMany({ where: { user_id: userId } });
      await tx.habit.deleteMany({ where: { user_id: userId } });
      await tx.lessonCompletion.deleteMany({ where: { user_id: userId } });
      await tx.communityWin.deleteMany({ where: { user_id: userId } });
      await tx.savedRecipe.deleteMany({ where: { user_id: userId } });
      await tx.listItem.deleteMany({ where: { user_id: userId } });
      await tx.clientSignal.deleteMany({ where: { user_id: userId } });
      await tx.clientOutcome.deleteMany({ where: { user_id: userId } });
      await tx.ptmPrediction.deleteMany({ where: { user_id: userId } });
      await tx.coachEffectivenessScore.deleteMany({ where: { coach_id: userId } });
      await tx.coachOnboardingProgress.deleteMany({ where: { coach_id: userId } });
      await tx.coachProfile.deleteMany({ where: { user_id: userId } });
      await tx.coachSubscription.deleteMany({ where: { coach_id: userId } });
      // NOTE: Invoice rows are intentionally kept per UK/EU financial records
      // retention obligations (Companies Act: 6 years). We nullify coach_id
      // instead of deleting so the billing row stays but is de-linked.
      // Invoice rows: kept for UK/EU financial records retention (6+ years).
      // The coach_id FK remains valid because the User row is tombstoned, not deleted.
      // No update needed — the FK stays pointing at the tombstoned user row.
      await tx.paymentFailure.deleteMany({ where: { coach_id: userId } });
      await tx.inviteCode.deleteMany({ where: { coach_id: userId } });
      await tx.buildWeekEnrollment.deleteMany({ where: { user_id: userId } });
      await tx.dataExportRequest.deleteMany({ where: { user_id: userId } });
      await tx.clientCoachConsent.deleteMany({
        where: { OR: [{ client_id: userId }, { coach_id: userId }] },
      });
      await tx.notificationPreferences.deleteMany({ where: { user_id: userId } });
      await tx.userPreferences.deleteMany({ where: { user_id: userId } });
      await tx.userProfile.deleteMany({ where: { user_id: userId } });

      // Detach any students still assigned to this coach so they are not
      // orphaned against a tombstoned coach_id.
      await tx.user.updateMany({
        where: { coach_id: userId, role: 'student' },
        data: { coach_id: null },
      });

      // Tombstone the User row (PII scrub + mark deleted). We do NOT DELETE
      // the row to preserve referential integrity on coach-side tables (billing,
      // CoachMessage, AuditLog) that reference user.id. The tombstone email uses
      // the reserved RFC 2606 .invalid TLD so no real address ever collides.
      await tx.user.update({
        where: { id: userId },
        data: {
          email: tombstoneEmail,
          name: 'Deleted user',
          phone: null,
          supabase_id: tombstoneSupabaseId,
          archived_at: now,
          deleted_at: now,
          deletion_token_hash: null,
          deletion_token_expires_at: null,
        },
      });
    };
    if (this.auditLog) {
      await this.auditLog.withAuditLog(
        {
          tenantId: userId,
          actorId: opts.actorId ?? userId,
          actorType: opts.isAdminForced ? 'admin' : 'system',
          action: 'delete',
          resourceType: 'User',
          resourceId: userId,
          afterState: { tombstoned: true, admin_forced: opts.isAdminForced },
          reason: 'account.finalize_deletion',
        },
        finalizeScrub,
      );
    } else {
      await this.prisma.$transaction(finalizeScrub);
    }
  }

  // ── Email ─────────────────────────────────────────────────────────────────────

  private async sendConfirmationEmail(
    email: string,
    name: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    // IMPORTANT: Never log the confirmation URL or the raw token. The token is
    // a single-use credential; logging it exposes it to anyone with log access.
    // The token hash is stored in the DB. The user retrieves a fresh status
    // from the app; email delivery will surface the URL once wired up.
    //
    // Phase 9 digest infra: replace the warn below with a MailService call.
    // Subject: "Confirm your account deletion request — The Growth Project"
    // Body:    Plain-text + HTML with the confirmation URL, expiry time, and a
    //          note that clicking starts a 14-day grace period during which the
    //          deletion can be cancelled from Settings.
    //
    // Do not send a second email after confirmation — the mobile client
    // shows the in-app status instead.
    // Do not log email, name, token, or any URL derived from the token.
    void email;
    void name;
    void token;
    this.logger.warn(
      `AccountDeletion: confirmation pending — email not yet configured. ` +
        `Token stored in DB, expires ${expiresAt.toISOString()}. ` +
        'Wire up MailService in Phase 9 to send the confirmation link.',
    );
  }

  // ── deletion_audit write ──────────────────────────────────────────────────────

  private async writeDeletionAudit(opts: {
    userId: string;
    event: DeletionAuditEventValue;
    actorId: string | null;
    actorRole?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "deletion_audit" ("id", "user_id", "event", "actor_id", "actor_role", "metadata", "created_at")
        VALUES (
          gen_random_uuid()::text,
          ${opts.userId},
          ${opts.event},
          ${opts.actorId ?? null},
          ${opts.actorRole ?? null},
          ${opts.metadata ? (opts.metadata as Prisma.InputJsonValue) : Prisma.DbNull}::jsonb,
          NOW()
        )
      `;
    } catch (err) {
      // Never surface to caller — audit write failures are operational, not
      // correctness failures. Log and continue.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`AccountDeletion: deletion_audit write failed: ${msg}`);
    }
  }
}
