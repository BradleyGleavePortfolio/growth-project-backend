/**
 * NudgeEngine — the single decision point for Nudge v1.
 *
 * Walks a NudgeCandidate through five gates in order, recording the
 * terminal outcome in NudgeLog exactly once:
 *
 *   1. Idempotency  — unique (user_id, trigger_type, signal_key)
 *   2. Opt-out      — per-trigger pref in NotificationPreferences
 *   3. Global mute  — NotificationPreferences.muted
 *   4. Frequency    — 48h cap across all trigger types (spec §3)
 *   5. Quiet hours  — defer if outside 8am–9pm local (spec §4)
 *
 * Past all gates: route to in-app + (optional) email + (optional) push,
 * each gated by its own channel pref. At least one channel must deliver
 * for status='sent'; if every attempted channel transport throws we
 * record status='failed'. The in-app write is always best-effort — it
 * is the primary channel (spec §2) and most resilient.
 *
 * Every gate decision writes EXACTLY ONE NudgeLog row. Tests assert the
 * row count downstream.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma.service';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';
import { EmailService } from '../../email/email.service';
import { EmailTemplateKey } from '../../email/email.types';
import { nudgeCopyFor } from './copy';
import { QuietHoursPolicy } from './quiet-hours.policy';
import {
  NUDGE_FREQUENCY_CAP_MS,
  NudgeCandidate,
  NudgeChannel,
  NudgeOutcome,
  NudgeStatus,
  NudgeTriggerType,
  capBucketStart,
} from './nudge.types';

/** Map trigger → email template key. Keeps the engine declarative. */
const TRIGGER_TO_EMAIL_TEMPLATE: Record<NudgeTriggerType, EmailTemplateKey> = {
  missed_checkin: EmailTemplateKey.NUDGE_MISSED_CHECKIN,
  streak_broken: EmailTemplateKey.NUDGE_STREAK_BROKEN,
  onboarding_abandoned: EmailTemplateKey.NUDGE_ONBOARDING_ABANDONED,
  inactive: EmailTemplateKey.NUDGE_INACTIVE,
};

/** Map trigger → notification kind (also drives _kindToPrefsPrefix lookups). */
const TRIGGER_TO_KIND: Record<NudgeTriggerType, string> = {
  missed_checkin: NotificationKind.NUDGE_MISSED_CHECKIN,
  streak_broken: NotificationKind.NUDGE_STREAK_BROKEN,
  onboarding_abandoned: NotificationKind.NUDGE_ONBOARDING_ABANDONED,
  inactive: NotificationKind.NUDGE_INACTIVE,
};

/**
 * Prefs-column prefix per trigger, e.g. 'nudge_missed_checkin_email'.
 *
 * Note: the streak_broken trigger maps to 'nudge_practice_paused' columns
 * because the schema doctrine bans the 'streak_' substring in schema.prisma.
 * The TS trigger value remains 'streak_broken' for product clarity.
 */
const TRIGGER_TO_PREFS_PREFIX: Record<NudgeTriggerType, string> = {
  missed_checkin: 'nudge_missed_checkin',
  streak_broken: 'nudge_practice_paused',
  onboarding_abandoned: 'nudge_onboarding_abandoned',
  inactive: 'nudge_inactive',
};

@Injectable()
export class NudgeEngineService {
  private readonly logger = new Logger(NudgeEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    // EmailService is optional so unit tests that exercise gates alone do
    // not need the full email subsystem wired up. In prod the DI graph
    // always provides it.
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Process one candidate end-to-end. Returns the terminal outcome.
   * Never throws — transport errors become status='failed' log rows.
   */
  async process(candidate: NudgeCandidate, now: Date = new Date()): Promise<NudgeOutcome> {
    // ── Gate 1: idempotency / dedupe ────────────────────────────────────
    // Claim the (user_id, trigger_type, signal_key) slot up-front so two
    // concurrent scans cannot both deliver. The row starts as 'pending'
    // and is updated to the terminal status before we return.
    let logRow: { id: string } | null = null;
    try {
      logRow = await this.prisma.nudgeLog.create({
        data: {
          user_id: candidate.user_id,
          trigger_type: candidate.trigger_type,
          signal_key: candidate.signal_key,
          status: 'pending',
          attempted_at: now,
        },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        // Duplicate signal_key — another scan already owns this candidate.
        this.logger.debug(
          `nudge.decision user=${candidate.user_id} trigger=${candidate.trigger_type} status=suppressed_dedupe`,
        );
        return { status: NudgeStatus.SUPPRESSED_DEDUPE, channels: [] };
      }
      // Any other DB error — log and bail with failed (no row to update).
      this.logger.error(
        `NudgeLog claim failed for user=${candidate.user_id} trigger=${candidate.trigger_type}`,
        err,
      );
      return { status: NudgeStatus.FAILED, channels: [] };
    }

    // From here on every return path calls `finalize` so the row is never
    // left in 'pending'.
    try {
      const prefs = await this.notifications.getPreferences(candidate.user_id);

      // ── Gate 2: global mute ──────────────────────────────────────────
      if ((prefs as Record<string, unknown>).muted) {
        return this.finalize(logRow.id, NudgeStatus.SUPPRESSED_MUTED, [], candidate, now);
      }

      // ── Gate 3: per-trigger opt-out ──────────────────────────────────
      const channels = this.resolveEnabledChannels(candidate.trigger_type, prefs);
      if (channels.length === 0) {
        return this.finalize(logRow.id, NudgeStatus.SUPPRESSED_OPT_OUT, [], candidate, now);
      }

      // ── Gate 4: 48h frequency cap (across all trigger types) ─────────
      const capWindowStart = new Date(now.getTime() - NUDGE_FREQUENCY_CAP_MS);
      const recentSend = await this.prisma.nudgeLog.findFirst({
        where: {
          user_id: candidate.user_id,
          status: 'sent',
          sent_at: { gte: capWindowStart },
        },
        select: { id: true },
      });
      if (recentSend) {
        return this.finalize(logRow.id, NudgeStatus.SUPPRESSED_CAP, [], candidate, now);
      }

      // ── Gate 5: quiet hours (defer rather than drop) ─────────────────
      const tz =
        (prefs as { timezone?: string }).timezone ?? 'America/Los_Angeles';
      const quiet = QuietHoursPolicy.evaluate(now, tz);
      if (!quiet.allowed) {
        await this.prisma.nudgeLog.update({
          where: { id: logRow.id },
          data: {
            status: NudgeStatus.DEFERRED,
            deferred_until: quiet.deferred_until,
          },
        });
        this.logger.debug(
          `nudge.decision user=${candidate.user_id} trigger=${candidate.trigger_type} status=deferred until=${quiet.deferred_until?.toISOString()}`,
        );
        return {
          status: NudgeStatus.DEFERRED,
          channels: [],
          log_id: logRow.id,
          deferred_until: quiet.deferred_until,
        };
      }

      // ── Atomic cap reservation ───────────────────────────────────────
      // Race-safe enforcement of spec §3 "max 1 nudge per user per 48h".
      // Two concurrent triggers (different trigger_type, same user) both
      // passed the read-side cap check above; the unique
      // (user_id, cap_bucket) index makes the WRITE side serialise. The
      // loser sees P2002 → status='suppressed_cap', no delivery occurs.
      const reserved = await this.tryReserveCapBucket(logRow.id, candidate.user_id, now);
      if (!reserved) {
        return this.finalize(logRow.id, NudgeStatus.SUPPRESSED_CAP, [], candidate, now);
      }

      // ── Deliver ──────────────────────────────────────────────────────
      const delivered = await this.deliver(candidate, channels, prefs);
      if (delivered.length === 0) {
        return this.finalize(logRow.id, NudgeStatus.FAILED, [], candidate, now);
      }
      return this.finalize(logRow.id, NudgeStatus.SENT, delivered, candidate, now);
    } catch (err) {
      this.logger.error(
        `NudgeEngine.process unexpected error user=${candidate.user_id}`,
        err,
      );
      return this.finalize(logRow.id, NudgeStatus.FAILED, [], candidate, now);
    }
  }

  /**
   * Re-scan deferred rows whose deferred_until has elapsed. Used by the
   * scheduler so a candidate suppressed at 3am surfaces at 8am.
   *
   * Returns the number of deferred rows reprocessed.
   */
  async reprocessDeferred(now: Date = new Date()): Promise<number> {
    const ready = await this.prisma.nudgeLog.findMany({
      where: {
        status: 'deferred',
        deferred_until: { lte: now },
      },
      select: {
        id: true,
        user_id: true,
        trigger_type: true,
        signal_key: true,
      },
      take: 200, // soft per-tick cap; the cron's frequent cadence catches up.
    });
    let count = 0;
    for (const row of ready) {
      // Reset the row so process() can drive it through the gates again.
      // We delete-and-recreate via update so the unique key stays intact.
      await this.prisma.nudgeLog.update({
        where: { id: row.id },
        data: { status: 'reprocessing', deferred_until: null },
      });
      // Then process the candidate, which will fail the dedupe gate
      // because the row already exists — so we run the gates manually
      // by mutating the existing row instead. Simpler: call processExisting.
      await this.processExisting(row.id, {
        user_id: row.user_id,
        trigger_type: row.trigger_type as NudgeTriggerType,
        signal_key: row.signal_key,
      }, now);
      count++;
    }
    return count;
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Atomically reserve the (user_id, cap_bucket) slot for this candidate.
   *
   * Returns true if the slot was successfully claimed (this row owns the
   * cap window for the next 48h), false if another concurrent row already
   * holds it (caller must terminate with status='suppressed_cap').
   *
   * Race model: two replicas firing `nudge-detection` at the same
   * every-15-min boundary both pass the read-side Gate 4 check. They then both
   * call this method. The unique @@unique([user_id, cap_bucket]) index
   * on NudgeLog rejects the second update with P2002; we catch the
   * violation and return false. This is the ONLY hard primitive
   * preventing two nudges to the same user inside one 48h bucket.
   *
   * Why update (not create): the NudgeLog row already exists (claimed
   * at Gate 1 dedupe). We mutate cap_bucket in place. NULL on every
   * non-sent row — PG treats NULL as distinct in unique indexes, so
   * sibling deferred / suppressed_opt_out / suppressed_muted rows for
   * the same user do not collide.
   */
  private async tryReserveCapBucket(
    logId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const bucket = capBucketStart(now);
    try {
      await this.prisma.nudgeLog.update({
        where: { id: logId },
        data: { cap_bucket: bucket },
      });
      return true;
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.debug(
          `nudge.cap_bucket conflict user=${userId} bucket=${bucket.toISOString()} — sibling tick already holds slot`,
        );
        return false;
      }
      // Non-unique-violation update error: bubble up so the outer catch
      // logs it and the row finalises as 'failed'.
      throw err;
    }
  }

  /**
   * Gate walk for a row that already exists (used by reprocessDeferred).
   * Identical logic to `process` minus the row-creation step.
   */
  private async processExisting(
    logId: string,
    candidate: NudgeCandidate,
    now: Date,
  ): Promise<NudgeOutcome> {
    try {
      const prefs = await this.notifications.getPreferences(candidate.user_id);
      if ((prefs as Record<string, unknown>).muted) {
        return this.finalize(logId, NudgeStatus.SUPPRESSED_MUTED, [], candidate, now);
      }
      const channels = this.resolveEnabledChannels(candidate.trigger_type, prefs);
      if (channels.length === 0) {
        return this.finalize(logId, NudgeStatus.SUPPRESSED_OPT_OUT, [], candidate, now);
      }
      const capWindowStart = new Date(now.getTime() - NUDGE_FREQUENCY_CAP_MS);
      const recentSend = await this.prisma.nudgeLog.findFirst({
        where: {
          user_id: candidate.user_id,
          status: 'sent',
          sent_at: { gte: capWindowStart },
          id: { not: logId },
        },
        select: { id: true },
      });
      if (recentSend) {
        return this.finalize(logId, NudgeStatus.SUPPRESSED_CAP, [], candidate, now);
      }
      const tz = (prefs as { timezone?: string }).timezone ?? 'America/Los_Angeles';
      const quiet = QuietHoursPolicy.evaluate(now, tz);
      if (!quiet.allowed) {
        await this.prisma.nudgeLog.update({
          where: { id: logId },
          data: { status: NudgeStatus.DEFERRED, deferred_until: quiet.deferred_until },
        });
        return {
          status: NudgeStatus.DEFERRED,
          channels: [],
          log_id: logId,
          deferred_until: quiet.deferred_until,
        };
      }
      // Atomic cap reservation — see process() for full rationale.
      const reserved = await this.tryReserveCapBucket(logId, candidate.user_id, now);
      if (!reserved) {
        return this.finalize(logId, NudgeStatus.SUPPRESSED_CAP, [], candidate, now);
      }
      const delivered = await this.deliver(candidate, channels, prefs);
      if (delivered.length === 0) {
        return this.finalize(logId, NudgeStatus.FAILED, [], candidate, now);
      }
      return this.finalize(logId, NudgeStatus.SENT, delivered, candidate, now);
    } catch (err) {
      this.logger.error(
        `processExisting unexpected error user=${candidate.user_id}`,
        err,
      );
      return this.finalize(logId, NudgeStatus.FAILED, [], candidate, now);
    }
  }

  /**
   * Resolve which channels are enabled for this user/trigger combination.
   * Returns a (possibly empty) ordered list: in-app first (primary),
   * then email, then push. Spec §2 channel ordering.
   */
  private resolveEnabledChannels(
    trigger: NudgeTriggerType,
    prefs: Record<string, unknown>,
  ): NudgeChannel[] {
    const prefix = TRIGGER_TO_PREFS_PREFIX[trigger];
    const out: NudgeChannel[] = [];
    if (prefs[`${prefix}_inapp`] !== false) out.push('inapp');
    if (prefs[`${prefix}_email`] === true) out.push('email');
    if (prefs[`${prefix}_push`] !== false) out.push('push');
    return out;
  }

  /**
   * Fan-out to each enabled channel. Returns the channels that actually
   * delivered (best-effort per channel — one channel's transport failure
   * does not abort the others).
   */
  private async deliver(
    candidate: NudgeCandidate,
    channels: NudgeChannel[],
    prefs: Record<string, unknown>,
  ): Promise<NudgeChannel[]> {
    const delivered: NudgeChannel[] = [];
    const firstName =
      typeof candidate.context?.first_name === 'string'
        ? (candidate.context.first_name as string)
        : undefined;
    const copy = nudgeCopyFor(candidate.trigger_type, { first_name: firstName });
    const kind = TRIGGER_TO_KIND[candidate.trigger_type] as
      | typeof NotificationKind[keyof typeof NotificationKind];

    // ── inapp ──────────────────────────────────────────────────────────
    if (channels.includes('inapp')) {
      try {
        const row = await this.notifications.createNotification({
          user_id: candidate.user_id,
          kind,
          body: copy.body,
          deep_link: copy.deepLink,
          payload: {
            trigger_type: candidate.trigger_type,
            signal_key: candidate.signal_key,
          },
          channel: 'inapp',
        });
        if (row) delivered.push('inapp');
      } catch (err) {
        this.logger.warn(
          `inapp deliver failed user=${candidate.user_id} trigger=${candidate.trigger_type}: ${(err as Error).message}`,
        );
      }
    }

    // ── push ───────────────────────────────────────────────────────────
    if (channels.includes('push')) {
      try {
        const result = await this.notifications.pushToUser(
          candidate.user_id,
          copy.pushTitle,
          copy.body,
          {
            kind,
            trigger_type: candidate.trigger_type,
            signal_key: candidate.signal_key,
            deep_link: copy.deepLink,
          },
        );
        if (result.delivered) delivered.push('push');
      } catch (err) {
        this.logger.warn(
          `push deliver failed user=${candidate.user_id} trigger=${candidate.trigger_type}: ${(err as Error).message}`,
        );
      }
    }

    // ── email ──────────────────────────────────────────────────────────
    if (channels.includes('email') && this.email) {
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: candidate.user_id },
          select: { email: true, name: true },
        });
        if (user?.email) {
          const appUrl =
            this.config?.get<string>('APP_URL') ??
            'https://app.thegrowthproject.app';
          const result = await this.email.send({
            to: user.email,
            template: TRIGGER_TO_EMAIL_TEMPLATE[candidate.trigger_type],
            data: {
              first_name: firstName ?? deriveFirstName(user.name),
              app_url: appUrl,
              preferences_url: `${appUrl}/settings/notifications`,
            },
            idempotencyKey: `nudge:${candidate.trigger_type}:${candidate.signal_key}:${candidate.user_id}`,
          });
          if (result.status === 'sent' || result.status === 'logged') {
            delivered.push('email');
          }
        }
      } catch (err) {
        this.logger.warn(
          `email deliver failed user=${candidate.user_id} trigger=${candidate.trigger_type}: ${(err as Error).message}`,
        );
      }
    }

    return delivered;
  }

  /**
   * Single point that closes out a NudgeLog row and emits the decision log
   * line. `now` defaults to wall-clock so test inputs that thread a fixed
   * `now` through process()/processExisting() produce sent_at values
   * consistent with the gates above (the 48h cap query and sent_at must
   * agree on the timeline).
   */
  private async finalize(
    logId: string,
    status: NudgeStatus,
    channels: NudgeChannel[],
    candidate: NudgeCandidate,
    now: Date = new Date(),
  ): Promise<NudgeOutcome> {
    const sent_at = status === NudgeStatus.SENT ? now : null;
    try {
      await this.prisma.nudgeLog.update({
        where: { id: logId },
        data: {
          status,
          channels: channels as unknown as Prisma.NudgeLogUpdateInput['channels'],
          sent_at: sent_at ?? undefined,
        },
      });
    } catch (err) {
      this.logger.error(`finalize NudgeLog update failed id=${logId}`, err);
    }
    this.logger.log(
      `nudge.decision user=${candidate.user_id} trigger=${candidate.trigger_type} status=${status} channels=${channels.join(',') || 'none'}`,
    );
    return { status, channels, log_id: logId };
  }
}

/** Best-effort first-name derivation from "Full Name". */
function deriveFirstName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/)[0];
}
