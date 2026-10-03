import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  AppleRevocationOutcome,
  AppleTokenRevocationService,
} from './apple-token-revocation.service';
import { executeErasureManifest } from './account-deletion.manifest';
import {
  TOMBSTONE_AUTH_PREFIX,
  RECEIPT_KEY_PREFIX,
  LEGACY_RECEIPT_KEY_PREFIX,
  deletionReceiptKey,
  receiptCutoff,
} from './deletion-receipt';
import { AccountDeletionStorageService } from './account-deletion.storage';
import { AccountDeletionBillingService } from './account-deletion.billing';
import { VoiceUploadProvider } from '../community/voice/voice-upload.provider';
import {
  VoiceErasureRow,
  attemptVoiceErasures,
  objectTargets,
  recordVoiceErasures,
} from '../community/voice/voice-erasure';

// ─── State machine ────────────────────────────────────────────────────────────
//
//   NONE / REQUESTED → CONFIRMED   POST /me/delete-account (after RecentAuthGuard)
//                                   requested_at (kept if a legacy request
//                                   exists) + confirmed_at = now, one write
//   REQUESTED        → CONFIRMED   GET /me/delete-account/confirm?token= (legacy)
//   REQUESTED/CONFIRMED → NONE     POST /me/delete-account/cancel, while
//                                   now < purge_after
//   CONFIRMED        → DELETED     nightly cron, once now >= purge_after
//   ANY              → DELETED     POST /admin/users/:id/delete (owner only)
//
// Concurrency (A-608-2). Every transition runs in ONE database transaction
// that first takes a row lock on the User row (SELECT ... FOR UPDATE) and
// re-checks the state under that lock. The confirmed_at timestamp is the
// schedule version: the cron passes the value it saw and the finalizer
// refuses a row whose schedule changed (cancelled and re-requested).
//   - request waits for the lock, so two concurrent requests serialize; the
//     second sees CONFIRMED and returns the first schedule unchanged, and only
//     the winner calls Apple.
//   - cancel and the finalizer use SKIP LOCKED: a cancel that meets a running
//     finalization gets 409 instead of racing it, and a second cron worker
//     skips a row another worker holds.
//   - the finalizer checks the exact cutoff (now >= purge_after) under the
//     lock, so a cancel that passed its own check has either committed (the
//     finalizer then sees NONE) or not started (it then sees DELETED).
//   - the lifecycle audit row is written in the same transaction as the
//     transition, so an event exists if and only if the transition committed.
//
// Finalization order inside the locked transaction: collect storage keys and
// Stripe subscription ids from the rows, record the durable voice-recording
// erasure work (B-610-5; verified after commit, retried by
// VoiceErasureService until verified), tombstone the User row, run the
// erasure manifest (account-deletion.manifest.ts), delete the lifecycle audit
// rows, THEN remove the bytes and cancel the subscriptions (only after every
// DB statement succeeded; both idempotent, any failure throws and rolls the
// DB back for the next run), and write one non-identifying outcome row. After commit the Supabase auth identity is
// removed; the original supabase_id stays on the tombstone (the only retry
// handle) until that succeeds, and the cron retries it every night.
// ─────────────────────────────────────────────────────────────────────────────

/** Legacy sentinel id kept for callers that still import it. */
export const DELETED_USER_SENTINEL_ID = '__deleted_user_sentinel__';

export const DeletionAuditEvent = {
  DELETION_REQUESTED: 'deletion_requested',
  DELETION_CONFIRMED: 'deletion_confirmed',
  DELETION_CANCELLED: 'deletion_cancelled',
  DELETION_FINALIZED: 'deletion_finalized',
  ADMIN_FORCE_DELETE: 'admin_force_delete',
  APPLE_REVOCATION: 'apple_revocation',
  AUTH_IDENTITY_REMOVED: 'auth_identity_removed',
  AUTH_IDENTITY_CLEANUP_FAILED: 'auth_identity_cleanup_failed',
} as const;

export type DeletionAuditEventValue = (typeof DeletionAuditEvent)[keyof typeof DeletionAuditEvent];

const DAY_MS = 24 * 60 * 60 * 1000;
/** The finalize cron runs once a day, so completion can lag eligibility by up to a day. */
const FINALIZE_WINDOW_MS = DAY_MS;
const FINALIZE_TX_TIMEOUT_MS = 120_000;
// Re-exported for existing importers; defined with the completion receipt.
export { TOMBSTONE_AUTH_PREFIX };

export interface DeletionStatus {
  state: 'none' | 'requested' | 'confirmed' | 'deleted';
  requested_at?: string;
  confirmed_at?: string;
  grace_days?: number;
  purge_after?: string;
  /** Latest time the nightly job is expected to have finished the deletion. */
  completes_by?: string;
  deleted_at?: string;
  cancellable?: boolean;
}

export interface DeletionScheduledResponse {
  state: 'confirmed';
  already_scheduled: boolean;
  message: string;
  requested_at: string;
  confirmed_at: string;
  grace_days: number;
  purge_after: string;
  completes_by: string;
  cancellable: true;
  apple_revocation: AppleRevocationOutcome;
}

export interface AdminDeleteOptions {
  actorId: string;
  actorRole: string;
  actorEmail: string | null;
  reason?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type FinalizeSkipReason =
  'not_found' | 'locked' | 'already_deleted' | 'cancelled' | 'not_due' | 'rescheduled';

export type AuthIdentityOutcome = 'removed' | 'pending' | 'none';

export type FinalizeResult =
  | { outcome: 'finalized'; authIdentity: AuthIdentityOutcome }
  | { outcome: 'skipped'; reason: FinalizeSkipReason };

interface LockedUser {
  id: string;
  role: string;
  email: string;
  supabase_id: string | null;
  deleted_at: Date | null;
  deletion_requested_at: Date | null;
  deletion_confirmed_at: Date | null;
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
    private readonly appleRevocation: AppleTokenRevocationService,
    private readonly storage: AccountDeletionStorageService,
    private readonly billing: AccountDeletionBillingService,
  ) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  private get graceDays(): number {
    const raw = this.config.get<string>('DELETION_GRACE_DAYS');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private purgeAfterFor(confirmedAt: Date): Date {
    return new Date(confirmedAt.getTime() + this.graceDays * DAY_MS);
  }

  private completesByFor(confirmedAt: Date): Date {
    return new Date(this.purgeAfterFor(confirmedAt).getTime() + FINALIZE_WINDOW_MS);
  }

  /**
   * Lock the User row for the rest of the transaction and return its
   * lifecycle columns. `skip` returns null when another transaction holds
   * the lock (callers distinguish that from a missing row).
   */
  private async lockUser(
    tx: Prisma.TransactionClient,
    userId: string,
    mode: 'wait' | 'skip',
  ): Promise<LockedUser | null> {
    const rows =
      mode === 'skip'
        ? await tx.$queryRaw<LockedUser[]>`
            SELECT "id", "role"::text AS "role", "email", "supabase_id", "deleted_at",
                   "deletion_requested_at", "deletion_confirmed_at"
              FROM "User" WHERE "id" = ${userId}
               FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<LockedUser[]>`
            SELECT "id", "role"::text AS "role", "email", "supabase_id", "deleted_at",
                   "deletion_requested_at", "deletion_confirmed_at"
              FROM "User" WHERE "id" = ${userId}
               FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async userExists(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const row = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    return !!row;
  }

  /**
   * deletion_audit insert. Lifecycle events are written with the
   * transaction client of the transition they describe, so a failure rolls
   * the transition back (B-608-4). Metadata never carries email, IP or
   * user agent.
   */
  private async insertDeletionAudit(
    client: Prisma.TransactionClient,
    opts: {
      subjectId: string;
      event: DeletionAuditEventValue;
      actorId: string | null;
      actorRole?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.$executeRaw`
      INSERT INTO "deletion_audit" ("id", "user_id", "event", "actor_id", "actor_role", "metadata", "created_at")
      VALUES (
        gen_random_uuid()::text,
        ${opts.subjectId},
        ${opts.event},
        ${opts.actorId},
        ${opts.actorRole ?? null},
        ${opts.metadata ? (opts.metadata as Prisma.InputJsonValue) : Prisma.DbNull}::jsonb,
        NOW()
      )
    `;
  }

  // ── Request (in-app; schedules immediately) ─────────────────────────────────
  //
  // Apple 5.1.1(v): deletion must be initiable AND completable in the app. The
  // caller has just passed RecentAuthGuard (fresh password, Sign in with
  // Apple, or Google re-auth), which is the confirmation factor, so the grace
  // period starts now. A legacy REQUESTED row (old email flow) is confirmed
  // here too, so nobody is stranded waiting for an email that never comes.

  async requestDeletion(
    userId: string,
    opts: {
      ip?: string | null;
      userAgent?: string | null;
      appleAuthorizationCode?: string | null;
    } = {},
  ): Promise<DeletionScheduledResponse> {
    const tx = await this.prisma.$transaction(async (client) => {
      const user = await this.lockUser(client, userId, 'wait');
      if (!user) throw new NotFoundException('User not found');
      if (user.deleted_at) throw new BadRequestException('Account is already deleted');
      if (user.deletion_confirmed_at) {
        return {
          scheduled: false as const,
          role: user.role,
          email: user.email,
          requestedAt: user.deletion_requested_at ?? user.deletion_confirmed_at,
          confirmedAt: user.deletion_confirmed_at,
        };
      }
      const now = new Date();
      const requestedAt = user.deletion_requested_at ?? now;
      await client.user.update({
        where: { id: userId },
        data: {
          deletion_requested_at: requestedAt,
          deletion_confirmed_at: now,
          deletion_token_hash: null,
          deletion_token_expires_at: null,
        },
      });
      const purgeAfter = this.purgeAfterFor(now);
      await this.insertDeletionAudit(client, {
        subjectId: userId,
        event: DeletionAuditEvent.DELETION_REQUESTED,
        actorId: userId,
        actorRole: user.role,
        metadata: {
          confirmation: 'in_app_recent_auth',
          from_legacy_request: !!user.deletion_requested_at,
        },
      });
      await this.insertDeletionAudit(client, {
        subjectId: userId,
        event: DeletionAuditEvent.DELETION_CONFIRMED,
        actorId: userId,
        actorRole: user.role,
        metadata: { grace_days: this.graceDays, purge_after: purgeAfter.toISOString() },
      });
      return {
        scheduled: true as const,
        role: user.role,
        email: user.email,
        requestedAt,
        confirmedAt: now,
      };
    });

    if (!tx.scheduled) {
      return this.scheduledResponse(tx.requestedAt, tx.confirmedAt, 'not_requested', true);
    }

    // Only the transaction that actually scheduled the deletion revokes Apple
    // tokens (never blocks; the outcome is recorded and returned).
    const appleRevocation = await this.appleRevocation.revokeWithAuthorizationCode(
      opts.appleAuthorizationCode,
      userId,
    );
    this.logger.log(
      `account deletion scheduled user=${userId} apple_revocation=${appleRevocation}`,
    );
    try {
      await this.insertDeletionAudit(this.prisma, {
        subjectId: userId,
        event: DeletionAuditEvent.APPLE_REVOCATION,
        actorId: userId,
        actorRole: tx.role,
        metadata: { outcome: appleRevocation },
      });
    } catch (err) {
      // The schedule is committed; the outcome is also in the log line above.
      this.logger.error(
        `account deletion: apple revocation audit write failed user=${userId}: ${(err as Error).message}`,
      );
    }

    await this.auditService.write({
      action: 'account_deletion.requested',
      actorId: userId,
      actorRole: tx.role,
      actorEmail: tx.email,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      metadata: {
        grace_days: this.graceDays,
        purge_after: this.purgeAfterFor(tx.confirmedAt).toISOString(),
        apple_revocation: appleRevocation,
      },
    });

    return this.scheduledResponse(tx.requestedAt, tx.confirmedAt, appleRevocation, false);
  }

  private scheduledResponse(
    requestedAt: Date,
    confirmedAt: Date,
    appleRevocation: AppleRevocationOutcome,
    alreadyScheduled: boolean,
  ): DeletionScheduledResponse {
    const purgeAfter = this.purgeAfterFor(confirmedAt);
    const dateLabel = purgeAfter.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return {
      state: 'confirmed',
      already_scheduled: alreadyScheduled,
      message: `Your account and its data will be permanently deleted after ${dateLabel}. You can cancel before then from Settings.`,
      requested_at: requestedAt.toISOString(),
      confirmed_at: confirmedAt.toISOString(),
      grace_days: this.graceDays,
      purge_after: purgeAfter.toISOString(),
      completes_by: this.completesByFor(confirmedAt).toISOString(),
      cancellable: true,
      apple_revocation: appleRevocation,
    };
  }

  // ── Legacy: confirm via one-time email link ────────────────────────────────

  async confirmDeletion(token: string): Promise<{ message: string; purge_after: string }> {
    const hash = this.hashToken(token);
    const candidate = await this.prisma.user.findFirst({
      where: { deletion_token_hash: hash },
      select: { id: true },
    });
    if (!candidate) {
      // 401 rather than 404: "no such token" and "expired" look the same.
      throw new UnauthorizedException('Invalid or expired confirmation link');
    }

    const purgeAfter = await this.prisma.$transaction(async (client) => {
      const user = await this.lockUser(client, candidate.id, 'wait');
      const fresh = await client.user.findUnique({
        where: { id: candidate.id },
        select: { deletion_token_hash: true, deletion_token_expires_at: true },
      });
      if (!user || !fresh || fresh.deletion_token_hash !== hash) {
        throw new UnauthorizedException('Invalid or expired confirmation link');
      }
      if (!fresh.deletion_token_expires_at || fresh.deletion_token_expires_at < new Date()) {
        throw new UnauthorizedException('Confirmation link has expired');
      }
      if (user.deleted_at) throw new BadRequestException('Account is already deleted');
      const now = new Date();
      await client.user.update({
        where: { id: user.id },
        data: {
          deletion_confirmed_at: now,
          deletion_token_hash: null,
          deletion_token_expires_at: null,
        },
      });
      const after = this.purgeAfterFor(now);
      await this.insertDeletionAudit(client, {
        subjectId: user.id,
        event: DeletionAuditEvent.DELETION_CONFIRMED,
        actorId: user.id,
        actorRole: user.role,
        metadata: {
          grace_days: this.graceDays,
          purge_after: after.toISOString(),
          via: 'email_link',
        },
      });
      return after;
    });

    return {
      message: `Your account is scheduled for permanent deletion after ${purgeAfter.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. You have ${this.graceDays} days to cancel.`,
      purge_after: purgeAfter.toISOString(),
    };
  }

  // ── Cancel (within grace period) ───────────────────────────────────────────

  async cancelDeletion(
    userId: string,
    opts: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ message: string }> {
    const result = await this.prisma.$transaction(async (client) => {
      const user = await this.lockUser(client, userId, 'skip');
      if (!user) {
        if (!(await this.userExists(client, userId))) throw new NotFoundException('User not found');
        throw new ConflictException(
          'Your account deletion is already in progress and can no longer be cancelled.',
        );
      }
      if (user.deleted_at) throw new BadRequestException('Account is already deleted');
      const hasRequest = !!user.deletion_requested_at;
      const hasConfirm = !!user.deletion_confirmed_at;
      if (!hasRequest && !hasConfirm) {
        throw new BadRequestException('No pending deletion request to cancel');
      }
      // Same boundary as the finalizer: cancellable strictly before purge_after.
      if (
        user.deletion_confirmed_at &&
        Date.now() >= this.purgeAfterFor(user.deletion_confirmed_at).getTime()
      ) {
        throw new BadRequestException(
          'The grace period has expired. Your account is being finalized for deletion.',
        );
      }
      await client.user.update({
        where: { id: userId },
        data: {
          deletion_requested_at: null,
          deletion_confirmed_at: null,
          deletion_token_hash: null,
          deletion_token_expires_at: null,
        },
      });
      await this.insertDeletionAudit(client, {
        subjectId: userId,
        event: DeletionAuditEvent.DELETION_CANCELLED,
        actorId: userId,
        actorRole: user.role,
        metadata: { was_confirmed: hasConfirm },
      });
      return user;
    });

    await this.auditService.write({
      action: 'account_deletion.cancelled',
      actorId: userId,
      actorRole: result.role,
      actorEmail: result.email,
      targetUserId: userId,
      targetType: 'user',
      targetId: userId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
    });

    return { message: 'Your deletion request has been cancelled. Your account is active.' };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getDeletionStatus(userId: string): Promise<DeletionStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        deleted_at: true,
        deletion_requested_at: true,
        deletion_confirmed_at: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    if (user.deleted_at) {
      return { state: 'deleted', deleted_at: user.deleted_at.toISOString() };
    }
    if (user.deletion_confirmed_at) {
      const purgeAfter = this.purgeAfterFor(user.deletion_confirmed_at);
      return {
        state: 'confirmed',
        requested_at: (user.deletion_requested_at ?? user.deletion_confirmed_at).toISOString(),
        confirmed_at: user.deletion_confirmed_at.toISOString(),
        grace_days: this.graceDays,
        purge_after: purgeAfter.toISOString(),
        completes_by: this.completesByFor(user.deletion_confirmed_at).toISOString(),
        cancellable: Date.now() < purgeAfter.getTime(),
      };
    }
    if (user.deletion_requested_at) {
      // Legacy email-flow request that was never confirmed: not scheduled.
      // The app finishes it with a fresh re-auth + POST /me/delete-account.
      return {
        state: 'requested',
        requested_at: user.deletion_requested_at.toISOString(),
        grace_days: this.graceDays,
        cancellable: true,
      };
    }
    return { state: 'none', grace_days: this.graceDays };
  }

  // ── Admin force-delete ─────────────────────────────────────────────────────

  async adminForceDelete(
    targetUserId: string,
    opts: AdminDeleteOptions,
  ): Promise<{ message: string }> {
    const result = await this.finalizeUserDeletion(targetUserId, {
      mode: 'admin',
      actorId: opts.actorId,
      actorRole: opts.actorRole,
    });
    if (result.outcome === 'skipped') {
      if (result.reason === 'not_found') throw new NotFoundException('User not found');
      if (result.reason === 'already_deleted') {
        return { message: 'Account is already deleted (no-op).' };
      }
      throw new ConflictException('A deletion for this account is already running.');
    }

    await this.auditService.write({
      action: 'account_deletion.admin_force_delete',
      actorId: opts.actorId,
      actorRole: opts.actorRole,
      actorEmail: opts.actorEmail,
      targetType: 'user',
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      metadata: { reason: opts.reason ?? null, auth_identity: result.authIdentity },
    });

    return { message: `User ${targetUserId} has been permanently deleted.` };
  }

  // ── Nightly finalize cron ──────────────────────────────────────────────────
  //
  // 03:00 UTC slot in the nightly stagger (AccountDeletionService 03:00,
  // BloodworkStaleScheduler 03:15, DataExportCleanupCron 03:30,
  // GdprScrubScheduler 03:45). Override via DELETION_FINALIZE_CRON only on
  // purpose.

  @Cron(process.env['DELETION_FINALIZE_CRON'] ?? '0 3 * * *')
  async runFinalizeCron(): Promise<{ finalized: number; skipped: number; errors: number }> {
    this.logger.log('AccountDeletion finalize cron: starting');
    const cutoff = new Date(Date.now() - this.graceDays * DAY_MS);

    const candidates = await this.prisma.user.findMany({
      where: {
        deletion_confirmed_at: { lte: cutoff, not: null },
        deleted_at: null,
      },
      select: { id: true, deletion_confirmed_at: true },
      orderBy: { deletion_confirmed_at: 'asc' },
      take: 500,
    });

    let finalized = 0;
    let skipped = 0;
    let errors = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.finalizeUserDeletion(candidate.id, {
          mode: 'cron',
          expectedConfirmedAt: candidate.deletion_confirmed_at,
        });
        if (result.outcome === 'skipped') {
          skipped += 1;
          this.logger.log(
            `AccountDeletion finalize: skipped user=${candidate.id} reason=${result.reason}`,
          );
          continue;
        }
        finalized += 1;
        await this.auditService.write({
          action: 'account_deletion.finalized',
          actorId: null,
          actorRole: 'system',
          targetType: 'user',
          metadata: { grace_days: this.graceDays, auth_identity: result.authIdentity },
        });
      } catch (err) {
        errors += 1;
        this.logger.error(
          `AccountDeletion finalize: failed for user=${candidate.id}, will retry next run: ${(err as Error).message}`,
        );
      }
    }

    // Retry auth-identity removal for tombstones whose Supabase delete failed.
    const pendingAuth = await this.prisma.user.findMany({
      where: {
        deleted_at: { not: null },
        NOT: { supabase_id: { startsWith: TOMBSTONE_AUTH_PREFIX } },
      },
      select: { id: true, supabase_id: true },
      take: 100,
    });
    // One row's failure must not stop the rest of tonight's retries (C-608-5).
    for (const row of pendingAuth) {
      try {
        await this.removeAuthIdentity(row.id, row.supabase_id);
      } catch (err) {
        this.logger.error(
          `AccountDeletion auth retry: failed for user=${row.id}, will retry next run: ${(err as Error).message}`,
        );
      }
    }

    // Completion receipts are kept for DELETION_RECEIPT_DAYS only (B-608-10).
    let receiptsDropped = 0;
    try {
      receiptsDropped = await this.prisma.$executeRaw`
        UPDATE "User" SET "supabase_id" = ${TOMBSTONE_AUTH_PREFIX} || "id"
         WHERE ("supabase_id" LIKE ${`${RECEIPT_KEY_PREFIX}%`}
                OR "supabase_id" LIKE ${`${LEGACY_RECEIPT_KEY_PREFIX}%`})
           AND "deleted_at" < ${receiptCutoff()}
      `;
    } catch (err) {
      this.logger.error(
        `AccountDeletion receipt expiry failed, will retry next run: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `AccountDeletion finalize cron: finalized=${finalized} skipped=${skipped} errors=${errors} auth_retries=${pendingAuth.length} receipts_dropped=${receiptsDropped}`,
    );
    return { finalized, skipped, errors };
  }

  // ── Finalization ───────────────────────────────────────────────────────────

  async finalizeUserDeletion(
    userId: string,
    opts: {
      mode: 'cron' | 'admin';
      expectedConfirmedAt?: Date | null;
      actorId?: string;
      actorRole?: string;
    },
  ): Promise<FinalizeResult> {
    const committed = await this.prisma.$transaction(
      async (
        tx,
      ): Promise<
        | { skipped: FinalizeSkipReason }
        | { supabaseId: string | null; voiceWork: VoiceErasureRow[] }
      > => {
        const user = await this.lockUser(tx, userId, 'skip');
        if (!user) {
          const exists = await this.userExists(tx, userId);
          return { skipped: exists ? 'locked' : 'not_found' };
        }
        if (user.deleted_at) return { skipped: 'already_deleted' as const };
        if (opts.mode === 'cron') {
          if (!user.deletion_confirmed_at) return { skipped: 'cancelled' as const };
          if (Date.now() < this.purgeAfterFor(user.deletion_confirmed_at).getTime()) {
            return { skipped: 'not_due' as const };
          }
          if (
            opts.expectedConfirmedAt &&
            opts.expectedConfirmedAt.getTime() !== user.deletion_confirmed_at.getTime()
          ) {
            return { skipped: 'rescheduled' as const };
          }
        }

        const now = new Date();
        const tombstoneEmail = `deleted-${userId}@tombstone.invalid`;

        // 1. Collect object keys and Stripe subscription ids while the rows
        //    that hold them still exist. Nothing external happens yet.
        const objects = await this.storage.collect(tx, userId);
        const subscriptionIds = await this.billing.collectSubscriptionIds(tx, userId);

        // 1b. Community voice recordings (B-610-5, OR-110-1, Apple 5.1.1(v)).
        //     The verified-erasure work (every exact key on the user's notes
        //     plus their `<uid>/` owner folder) is recorded in
        //     community_voice_erasures inside THIS transaction, before the
        //     manifest deletes the note rows: it commits if and only if the
        //     deletion commits, and a failed record rolls the whole deletion
        //     back for the next run. The bytes are removed by storage.purge
        //     below (in the transaction); after commit the work is verified
        //     (object reads back missing, folder lists empty) and anything not
        //     verified stays open for VoiceErasureService to retry. The table
        //     has no FK to User, so the work survives the tombstone.
        const voiceNotes = await tx.communityVoiceNote.findMany({
          where: { author_id: userId },
          select: { id: true, storage_key: true },
        });
        const voiceWork = await recordVoiceErasures(
          tx,
          [
            ...objectTargets(voiceNotes.map((n) => n.storage_key)),
            { kind: 'owner_folder', target: userId },
          ],
          'account_deletion',
          now,
        );
        // Transcript search rows point at the note (targetId); the manifest
        // removes the user's search rows by authorId, and this also catches a
        // transcript row indexed without an author.
        if (voiceNotes.length > 0) {
          await tx.communitySearchEntry.deleteMany({
            where: {
              kind: 'voice_note_transcript',
              targetId: { in: voiceNotes.map((n) => n.id) },
            },
          });
        }

        // 2. Tombstone. Runs before the manifest because it clears User-row
        //    FKs (default payout method) to rows the manifest deletes.
        //    supabase_id is kept until the auth identity is gone.
        await tx.user.update({
          where: { id: userId },
          data: {
            email: tombstoneEmail,
            name: 'Deleted user',
            phone: null,
            coach_id: null,
            expo_push_token: null,
            leaderboard_display_name: null,
            show_on_leaderboard: false,
            signup_ref: null,
            default_payout_method_id: null,
            archived_at: now,
            deleted_at: now,
            deletion_scheduled_at: null,
            deletion_requested_at: null,
            deletion_confirmed_at: null,
            deletion_token_hash: null,
            deletion_token_expires_at: null,
          },
        });

        // 3. Every user-referencing table (A-608-1).
        const steps = await executeErasureManifest(tx, {
          userId,
          email: user.email,
          tombstoneEmail,
          now,
        });
        const rowsChanged = steps.reduce((sum, s) => sum + s.count, 0);

        // 4. Audit: lifecycle rows carry the user id, so they go; one outcome
        //    row with a random subject id stays (B-608-4).
        await tx.$executeRaw`DELETE FROM "deletion_audit" WHERE "user_id" = ${userId}`;

        // 5. External side effects last (A-608-3): every DB statement above
        //    has already succeeded, so a constraint or data error can no
        //    longer leave the bytes removed and billing stopped on an account
        //    that did not finish. Both are idempotent (a missing object or an
        //    already-canceled subscription counts as done), so if one throws
        //    (rollback, nightly retry) or the commit itself fails, repeating
        //    them is safe. Past purge_after the deletion cannot be cancelled.
        const storage = await this.storage.purge(objects);
        const billing = await this.billing.cancelAll(subscriptionIds);

        await this.insertDeletionAudit(tx, {
          subjectId: crypto.randomUUID(),
          event:
            opts.mode === 'admin'
              ? DeletionAuditEvent.ADMIN_FORCE_DELETE
              : DeletionAuditEvent.DELETION_FINALIZED,
          actorId: opts.mode === 'admin' ? (opts.actorId ?? null) : null,
          actorRole: opts.mode === 'admin' ? (opts.actorRole ?? 'owner') : 'system',
          metadata: {
            outcome: 'finalized',
            storage_objects_removed: storage.removed,
            subscriptions_canceled: billing.canceled + billing.alreadyInactive,
            rows_changed: rowsChanged,
            auth_identity: user.supabase_id ? 'pending' : 'none',
          },
        });
        this.logger.log(
          `account deletion finalized user=${userId} rows=${rowsChanged} objects=${storage.removed} subscriptions=${billing.canceled}`,
        );
        return { supabaseId: user.supabase_id, voiceWork };
      },
      { timeout: FINALIZE_TX_TIMEOUT_MS, maxWait: 10_000 },
    );

    if ('skipped' in committed) return { outcome: 'skipped', reason: committed.skipped };
    await this.verifyVoiceErasures(userId, committed.voiceWork);
    const authIdentity = await this.removeAuthIdentity(userId, committed.supabaseId);
    return { outcome: 'finalized', authIdentity };
  }

  /**
   * B-610-5: verify the voice-recording erasure recorded in the committed
   * finalization. Never fails the deletion (it already committed): any
   * removal not verified stays open in community_voice_erasures and
   * VoiceErasureService retries it until verified.
   */
  private async verifyVoiceErasures(userId: string, work: VoiceErasureRow[]): Promise<void> {
    if (work.length === 0) return;
    try {
      const outcome = await attemptVoiceErasures(
        this.prisma,
        new VoiceUploadProvider(this.supabase),
        work,
        this.logger,
      );
      if (outcome.pending > 0) {
        this.logger.warn(
          `account deletion: ${outcome.pending} voice erasure(s) for user=${userId} not yet verified; retried by VoiceErasureService`,
        );
      }
    } catch (err) {
      this.logger.error(
        `account deletion: voice erasure verification failed after commit for user=${userId} (${(err as Error).message}); VoiceErasureService retries it`,
      );
    }
  }

  /**
   * Remove the Supabase auth identity after the DB erasure committed
   * (B-608-2). Both a returned `error` and a thrown exception count as
   * failure; "not found" counts as already removed. On success the tombstone
   * forgets the provider id; on failure it keeps it so the cron retries.
   */
  async removeAuthIdentity(
    userId: string,
    supabaseId: string | null,
  ): Promise<AuthIdentityOutcome> {
    if (!supabaseId || supabaseId.startsWith(TOMBSTONE_AUTH_PREFIX)) return 'none';
    let failure: string | null = null;
    try {
      const { error } = await this.supabase.getClient().auth.admin.deleteUser(supabaseId);
      if (error && !(error.status === 404 || /not found/i.test(error.message))) {
        failure = error.message;
      }
    } catch (err) {
      failure = (err as Error).message;
    }

    if (failure !== null) {
      this.logger.error(
        `account deletion: auth identity removal failed user=${userId}; retrying nightly: ${failure}`,
      );
      await this.insertDeletionAudit(this.prisma, {
        subjectId: crypto.randomUUID(),
        event: DeletionAuditEvent.AUTH_IDENTITY_CLEANUP_FAILED,
        actorId: null,
        actorRole: 'system',
        metadata: { outcome: 'retry_scheduled' },
      });
      return 'pending';
    }

    // B-608-10: keep a keyed completion receipt (C-608-7: HMAC r2, see
    // deletion-receipt.ts) instead of forgetting the auth id at once, so the
    // person's own token gets 403 ACCOUNT_DELETED (and the receipt endpoint
    // answers) rather than a bare 401. The nightly cron drops the receipt
    // after DELETION_RECEIPT_DAYS. With no usable receipt secret the
    // tombstone forgets the auth id instead (never an unkeyed digest).
    const receiptKey = deletionReceiptKey(supabaseId);
    if (!receiptKey) {
      this.logger.error(
        `account deletion: no usable DELETION_RECEIPT_SECRET / RECENT_AUTH_SECRET; user=${userId} gets no completion receipt`,
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { supabase_id: receiptKey ?? `${TOMBSTONE_AUTH_PREFIX}${userId}` },
    });
    await this.insertDeletionAudit(this.prisma, {
      subjectId: crypto.randomUUID(),
      event: DeletionAuditEvent.AUTH_IDENTITY_REMOVED,
      actorId: null,
      actorRole: 'system',
      metadata: { outcome: 'removed' },
    });
    return 'removed';
  }
}
