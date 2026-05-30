import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { ScheduledDrop } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AssignableAssetResolverRegistry } from './asset-resolvers/assignable-asset-resolver.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';

// PR-10 — DripDispatcherCron.
//
// One-minute @Cron (locked operator decision #7) that wakes, claims due
// pending ScheduledDrop rows, dispatches them through the PR-7
// AssignableAssetResolverRegistry (the SAME registry PR-9's inline path
// uses), then fires buyer push + in-app alerts (decision #9). On
// resolver failure it increments attempt_count and stamps next_retry_at
// with exponential backoff (decision #10); on MAX_ATTEMPTS it flips
// status='failed', sends a COACH_ALERT via NotificationsService (mirrors
// PR-2's transfer.failed pattern in billing.service.ts:1115), and logs a
// structured error line.
//
// CONCURRENCY / DOUBLE-DISPATCH PREVENTION
// ----------------------------------------
// The codebase has no advisory-lock helper and no Bull/Redis queue; the
// pattern used by every existing @Cron (digest, checkout-receipt, PTM,
// coach-effectiveness, weekly-insight) is "claim-by-write". We follow
// the same shape: an atomic conditional UPDATE flips status='pending' ->
// 'dispatching' and stamps locked_at, returning only the rows it won.
// Two cron instances on a multi-replica deploy contend on the row-level
// write lock; the loser's UPDATE matches zero rows and the drop is
// processed exactly once per tick. A stale-claim cutoff (5 min) lets a
// crashed worker's claim expire so a drop never gets stuck.
//
// BATCH LIMIT
// -----------
// 250 drops per tick. Sized so a healthy steady-state never queues; a
// large backlog (e.g. after a multi-hour cron outage or a Stripe
// reconnect storm) drains over consecutive ticks without overlapping a
// 60-second budget. The mobile / web alert path is the main per-drop
// cost (Expo push round-trip up to ~500ms tail).
//
// SCOPE
// -----
// Future-dated drops only (fire_at <= now). on_completion / on_milestone
// drops are seeded by PR-9 with fire_at=NULL and naturally excluded by
// the SQL gate; they are PR-11's job. We never re-materialise a drop
// whose materialised_ref is set (PR-7's at-least-once gate).

const TICK_BATCH_SIZE = 250;
const MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes — crashed-worker recovery
// Exponential backoff schedule (decision #10). attempt_count is incremented
// BEFORE this lookup, so a first failure (attempt_count=1) waits 1 min, a
// second waits 5 min, etc. Past the table length we clamp to the last
// entry — but in practice we hit MAX_ATTEMPTS first and stop retrying.
const BACKOFF_MS: readonly number[] = [
  1 * 60 * 1000, //  1 min
  5 * 60 * 1000, //  5 min
  15 * 60 * 1000, // 15 min
  60 * 60 * 1000, //  1 hour
  6 * 60 * 60 * 1000, //  6 hours
];

export interface DripDispatcherTickStats {
  claimed: number;
  delivered: number;
  retried: number;
  failed_permanently: number;
}

@Injectable()
export class DripDispatcherCron {
  private readonly logger = new Logger(DripDispatcherCron.name);
  private running = false; // tick-overlap guard

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly resolvers?: AssignableAssetResolverRegistry,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'drip-dispatcher' })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.DRIP_DISPATCHER_ENABLED === 'false') return;
    if (this.running) {
      // Prior tick still running — skip rather than overlap.
      this.logger.warn('drip-dispatcher tick skipped: prior tick still running');
      return;
    }
    this.running = true;
    try {
      const stats = await this.runOnce();
      if (
        stats.delivered > 0 ||
        stats.retried > 0 ||
        stats.failed_permanently > 0
      ) {
        this.logger.log(
          `drip-dispatcher tick: claimed=${stats.claimed} delivered=${stats.delivered} retried=${stats.retried} failed_permanently=${stats.failed_permanently}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `drip-dispatcher tick crashed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Public entrypoint for tests and ops diagnostics. Claims at most
   * `TICK_BATCH_SIZE` due drops, dispatches each, returns counts.
   */
  async runOnce(now: Date = new Date()): Promise<DripDispatcherTickStats> {
    if (!this.resolvers) {
      this.logger.error(
        'drip-dispatcher: AssignableAssetResolverRegistry not wired — cannot dispatch',
      );
      return { claimed: 0, delivered: 0, retried: 0, failed_permanently: 0 };
    }
    const candidates = await this.findDue(now);
    let delivered = 0;
    let retried = 0;
    let failedPermanently = 0;
    let claimed = 0;
    let reclaimed = 0;
    for (const candidate of candidates) {
      const priorStatus =
        candidate.status === 'dispatching' ? 'dispatching' : 'pending';
      const claim = await this.claim(candidate.id, priorStatus, now);
      if (!claim) continue; // lost the race to another worker (or no longer eligible)
      claimed += 1;
      if (priorStatus === 'dispatching') {
        reclaimed += 1;
        this.logger.warn(
          `drip-dispatcher reclaiming stranded drop=${claim.id} (worker crash recovery); prior locked_at was stale`,
        );
      }
      const outcome = await this.dispatch(claim, now);
      if (outcome === 'delivered') delivered += 1;
      else if (outcome === 'retried') retried += 1;
      else if (outcome === 'failed_permanently') failedPermanently += 1;
    }
    if (reclaimed > 0) {
      this.logger.log(
        `drip-dispatcher reclaimed ${reclaimed} stranded dispatching drop(s)`,
      );
    }
    return { claimed, delivered, retried, failed_permanently: failedPermanently };
  }

  // --- internal --------------------------------------------------------

  /**
   * Find candidate due drops. The SQL gate enforces every invariant the
   * brief calls out:
   *   - status IN ('pending', 'dispatching') — 'pending' is the normal
   *     case; 'dispatching' WITH a stale locked_at is a stranded drop
   *     left behind by a worker that crashed between claim() and the
   *     follow-up success/failure update (SIGKILL / OOM / k8s eviction /
   *     deploy roll). Without this branch a crashed worker permanently
   *     loses delivery for that drop — the buyer paid but never gets
   *     content. The 'dispatching' branch is gated on locked_at <
   *     staleBefore so we never steal a healthy in-flight claim.
   *   - materialised_ref IS NULL — PR-7's at-least-once gate; we never
   *     re-materialise a drop that already shipped (the resolver-side
   *     stable-key dedup still catches a half-finished crash on retry).
   *   - fire_at <= now AND fire_at IS NOT NULL — naturally excludes
   *     on_completion / on_milestone drops (PR-11's job).
   *   - attempt_count < MAX_ATTEMPTS — exhausted retries don't get
   *     picked again. A reclaimed stranded drop respects this same gate
   *     so a poison drop eventually goes status='failed' + COACH_ALERT
   *     and never loops forever (the post-claim dispatch path
   *     increments attempt_count on every failure).
   *   - (next_retry_at IS NULL OR next_retry_at <= now) — honours the
   *     exponential-backoff schedule set on prior failures (only
   *     applies to pending rows; a stranded dispatching row has
   *     locked_at as its "next try" timer).
   * Ordered by fire_at ASC so the oldest-due drop drains first and a
   * backlog is processed FIFO.
   */
  private findDue(now: Date): Promise<ScheduledDrop[]> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    return this.prisma.scheduledDrop.findMany({
      where: {
        materialised_ref: null,
        fire_at: { lte: now, not: null },
        attempt_count: { lt: MAX_ATTEMPTS },
        OR: [
          {
            // Normal claim path.
            status: 'pending',
            AND: [
              {
                OR: [
                  { next_retry_at: null },
                  { next_retry_at: { lte: now } },
                ],
              },
              {
                OR: [
                  { locked_at: null },
                  { locked_at: { lte: staleBefore } },
                ],
              },
            ],
          },
          {
            // Stranded-dispatching reclaim path. A 'dispatching' row
            // whose claim is older than STALE_CLAIM_MS belongs to a
            // worker that crashed and never finished the dispatch — we
            // take it back so the buyer gets their content.
            status: 'dispatching',
            locked_at: { lte: staleBefore },
          },
        ],
      },
      orderBy: { fire_at: 'asc' },
      take: TICK_BATCH_SIZE,
    });
  }

  /**
   * Atomic claim. Two variants share one SQL UPDATE: a fresh claim flips
   * status='pending' -> 'dispatching' and stamps locked_at; a reclaim
   * flips status='dispatching' -> 'dispatching' and re-stamps locked_at
   * IF the prior claim is stale. The composite WHERE on (id, prior-state,
   * locked_at) is the mutex: a sibling worker that already (re)claimed
   * the row sees count===0 and moves on. Reclaim semantics: the row's
   * STABLE (clientPurchaseId, contentId) idempotency keys are reused
   * on the retry, so the resolver-side dedup (PR-9 R1) collapses any
   * partial work the crashed worker did — workout via
   * WorkoutBuilderIdempotencyKey 'drip:workout:p={p}:c={c}', auto_message
   * via DripResolverMarker(purpose,purchase,content). Returns the
   * freshly-claimed row or null on contention. We also re-validate the
   * materialised_ref IS NULL gate inside the WHERE so a TOCTOU race
   * between findDue and claim still can't double-materialise a row that
   * was just delivered.
   */
  private async claim(
    id: string,
    priorStatus: 'pending' | 'dispatching',
    now: Date,
  ): Promise<ScheduledDrop | null> {
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    const where: Record<string, unknown> = {
      id,
      status: priorStatus,
      materialised_ref: null,
    };
    if (priorStatus === 'pending') {
      // Pending row must be unlocked OR stale-locked.
      where.OR = [
        { locked_at: null },
        { locked_at: { lte: staleBefore } },
      ];
    } else {
      // Reclaim path: row is dispatching AND locked_at is stale.
      where.locked_at = { lte: staleBefore };
    }
    const updated = await this.prisma.scheduledDrop.updateMany({
      where,
      data: {
        status: 'dispatching',
        locked_at: now,
      },
    });
    if (updated.count === 0) return null;
    return this.prisma.scheduledDrop.findUnique({ where: { id } });
  }

  /**
   * Dispatch one already-claimed drop. Per the PR-7 contract we call
   * `registry.materialise(asset_type, input)` with the SAME stable
   * idempotency keys PR-9's inline path uses (clientPurchaseId,
   * contentId) — so a drop that flipped between inline and cron paths
   * (or was retried on this path) cannot double-deliver. On success we
   * stamp materialised_ref+status='delivered'+delivered_at and fire the
   * buyer alert (alert failure NEVER un-delivers). On failure we either
   * schedule a retry (attempt_count++ + next_retry_at = now + backoff)
   * or escalate to permanent failure (status='failed' + COACH_ALERT).
   */
  private async dispatch(
    drop: ScheduledDrop,
    now: Date,
  ): Promise<'delivered' | 'retried' | 'failed_permanently' | 'noop'> {
    // Load purchase to recover client_user_id + coach_user_id.
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: drop.client_purchase_id },
      select: {
        id: true,
        client_user_id: true,
        coach_user_id: true,
        package_id: true,
      },
    });
    if (!purchase) {
      // Defensive — Cascade should never let this happen, but if it
      // does we don't want to spin forever. Flip the drop to canceled
      // and move on.
      await this.prisma.scheduledDrop.updateMany({
        where: { id: drop.id, status: 'dispatching' },
        data: {
          status: 'canceled',
          failure_reason: 'parent ClientPurchase row missing',
          locked_at: null,
        },
      });
      this.logger.error(
        `drip-dispatcher: drop=${drop.id} has no ClientPurchase row — canceled`,
      );
      return 'noop';
    }

    try {
      // PR-17 B1 — resolver-key bypass for re-send drops (decision #5).
      //
      // The resolver idempotency keys ride the STABLE (clientPurchaseId,
      // contentId) pair: auto-message.resolver claims a DripResolverMarker
      // keyed on (purpose, purchase_id, content_id) and returns the CACHED
      // CoachMessage on a repeat; workout.resolver keys the
      // WorkoutBuilderIdempotencyKey ledger on drip:workout:p={p}:c={c} and
      // collapses to the cached assignment. For an ORIGINAL drop
      // (push_seq === 0) that is exactly what we want — it preserves the
      // PR-9 R1 rollback-retry idempotency so a race between the inline
      // retry and this cron path can never double-deliver.
      //
      // But a coach "re-send updated version" of an already-FIRED drop is a
      // NEW ScheduledDrop row sharing the same (purchase, content) pair with
      // push_seq > 0. If we passed the pair, the resolvers would short-
      // circuit to the cached delivery and the buyer would get NOTHING new —
      // the opposite of a re-send. So for push_seq > 0 we pass ONLY the
      // per-drop scheduledDropId and OMIT the pair; both resolvers fall back
      // to a per-drop key (auto-message: marker skipped; workout:
      // drip:workout:{client}:{asset}:{scheduledDropId}) and produce a
      // GENUINELY FRESH delivery. (meal_plan rides
      // DailyMealPlanAssignment.drip_drop_id @unique — already fresh per
      // row; media rides ClientAssetGrant @@unique[client,media] — a re-send
      // of identical media collapses to the existing grant, which is
      // expected and acceptable: the buyer already has access and the
      // re-send's value is the new fire_at / notification, not a duplicate
      // grant.) See PR17_EXPANSION_PLAN.md §1.3 / §2.4.
      const isResend = drop.push_seq > 0;
      const result = await this.resolvers!.materialise(drop.asset_type, {
        clientId: purchase.client_user_id,
        coachId: purchase.coach_user_id,
        assetId: drop.asset_id,
        assetRevisionId: drop.asset_revision_id ?? null,
        displayTitle: drop.display_title,
        displayCaption: drop.display_caption,
        scheduledDropId: drop.id,
        // PR-9 R1 stable keys — same pair PR-9 inline used so a hypothetical
        // race between the inline retry and this cron path cannot create a
        // second ClientWorkoutAssignment / CoachMessage / etc. ONLY for
        // original (push_seq === 0) drops; a re-send (push_seq > 0)
        // deliberately omits the pair so it does not collapse to the cached
        // delivery (see comment above).
        clientPurchaseId: isResend ? null : purchase.id,
        contentId: isResend ? null : drop.content_id,
        // Cron path: no ambient outer $transaction — the resolver writes
        // commit on this.prisma directly.
      });

      // Success — stamp delivery. Re-assert status='dispatching' so a
      // concurrent claim cannot stomp the row.
      await this.prisma.scheduledDrop.updateMany({
        where: { id: drop.id, status: 'dispatching' },
        data: {
          materialised_ref: result.materialisedRef,
          status: 'delivered',
          fired_at: now,
          attempt_count: { increment: 1 },
          failure_reason: null,
          locked_at: null,
          next_retry_at: null,
        },
      });

      // Fire push + in-app alert (decision #9). Wrapped so any failure
      // here NEVER un-delivers the content — we already committed
      // materialised_ref above.
      await this.dispatchBuyerAlert(drop, purchase.client_user_id);
      return 'delivered';
    } catch (err) {
      return this.handleDispatchFailure(drop, purchase, err as Error, now);
    }
  }

  /**
   * Decision #9 — buyer push + in-app on successful materialise. Reuses
   * NotificationsService.createNotification (the same envelope PR-2
   * uses for transfer.failed COACH_ALERTs at billing.service.ts:1115)
   * and pushToUser. Both are wrapped in try/catch and logged: a hostile
   * notification provider must never reach back into the content
   * pipeline. After the dispatch attempt we stamp alert_dispatched_at
   * so a safety sweep can never double-push the buyer.
   *
   * PR-17 B1 — notify-suppression guard (decision #9 prep for B2). If
   * alert_dispatched_at is ALREADY set when we reach this method, the
   * buyer alert has already been handled (or was deliberately suppressed)
   * and we SKIP the send — no double-alert. B2's push service sets
   * alert_dispatched_at at SEED time when the coach toggles "notify" OFF
   * for a push, so a forward-dated push that the coach asked NOT to
   * announce delivers silently: the cron materialises the content but this
   * guard short-circuits the DRIP_RELEASED push + in-app. The gate is
   * strictly on the column being pre-set; a NORMAL drip drop is never
   * pre-stamped at seed (fan-out + PR-10 leave it NULL until after the
   * first dispatch), so its behaviour is unchanged.
   */
  private async dispatchBuyerAlert(
    drop: ScheduledDrop,
    clientUserId: string,
  ): Promise<void> {
    if (drop.alert_dispatched_at != null) {
      this.logger.debug(
        `drip-dispatcher alert suppressed for drop=${drop.id} client=${clientUserId}: alert_dispatched_at already set (notify off or already alerted)`,
      );
      return;
    }
    const title = drop.display_title?.slice(0, 80) || 'New content unlocked';
    const body = drop.display_title
      ? `New content unlocked: ${drop.display_title}`.slice(0, 160)
      : 'New content unlocked';
    const payload = {
      scheduled_drop_id: drop.id,
      client_purchase_id: drop.client_purchase_id,
      asset_type: drop.asset_type,
      asset_id: drop.asset_id,
      content_id: drop.content_id,
    };
    if (!this.notifications) {
      this.logger.log(
        `drip-dispatcher alert (no NotificationsService wired): drop=${drop.id} client=${clientUserId} asset=${drop.asset_type}`,
      );
    } else {
      // Each call is independently wrapped. A failure in the first
      // call must not cascade and skip the other two — a transient
      // prisma.notification.create blip would otherwise silently drop
      // the push send + the second DB row write.
      try {
        await this.notifications.createNotification({
          user_id: clientUserId,
          kind: NotificationKind.DRIP_RELEASED,
          body,
          payload,
          deep_link: 'tgp://client/library',
          channel: 'inapp',
        });
      } catch (err) {
        this.logger.warn(
          `drip-dispatcher in-app notification failed drop=${drop.id} client=${clientUserId}: ${(err as Error).message}`,
        );
      }
      try {
        await this.notifications.pushToUser(clientUserId, title, body, {
          kind: NotificationKind.DRIP_RELEASED,
          scheduled_drop_id: drop.id,
          asset_type: drop.asset_type,
        });
      } catch (err) {
        this.logger.warn(
          `drip-dispatcher push notification failed drop=${drop.id} client=${clientUserId}: ${(err as Error).message}`,
        );
      }
      try {
        await this.notifications.createNotification({
          user_id: clientUserId,
          kind: NotificationKind.DRIP_RELEASED,
          body,
          payload,
          deep_link: 'tgp://client/library',
          channel: 'push',
        });
      } catch (err) {
        this.logger.warn(
          `drip-dispatcher push-channel notification row failed drop=${drop.id} client=${clientUserId}: ${(err as Error).message}`,
        );
      }
    }
    // Stamp regardless of success/failure so a future tick never
    // re-pushes for the same drop. Per decision #9 a failed push must
    // not roll back delivery.
    try {
      await this.prisma.scheduledDrop.update({
        where: { id: drop.id },
        data: { alert_dispatched_at: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `drip-dispatcher could not stamp alert_dispatched_at for drop=${drop.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Decision #10 — retry-with-backoff, then COACH_ALERT on permanent
   * failure. attempt_count is incremented BEFORE checking the cap so a
   * resolver throw on the 5th attempt is reported as the 5th failure
   * (matches the MAX_ATTEMPTS=5 envelope the brief documents).
   *
   * On permanent failure we emit a COACH_ALERT via the same
   * NotificationsService.createNotification call PR-2 uses for
   * transfer.failed (kind=COACH_ALERT, channel='inapp'). We name the
   * buyer, the package, and the content so the coach can investigate
   * without a ticket round-trip. A structured `error` log line is
   * always written.
   */
  private async handleDispatchFailure(
    drop: ScheduledDrop,
    purchase: { id: string; client_user_id: string; coach_user_id: string; package_id: string },
    err: Error,
    now: Date,
  ): Promise<'retried' | 'failed_permanently'> {
    const nextAttempt = drop.attempt_count + 1;
    const isPermanent = nextAttempt >= MAX_ATTEMPTS;
    const reason = (err.message ?? 'unknown').slice(0, 500);

    if (!isPermanent) {
      const backoffIdx = Math.min(nextAttempt - 1, BACKOFF_MS.length - 1);
      const nextRetryAt = new Date(now.getTime() + BACKOFF_MS[backoffIdx]);
      await this.prisma.scheduledDrop.updateMany({
        where: { id: drop.id, status: 'dispatching' },
        data: {
          status: 'pending',
          attempt_count: { increment: 1 },
          failure_reason: reason,
          next_retry_at: nextRetryAt,
          locked_at: null,
        },
      });
      this.logger.warn(
        `drip-dispatcher transient failure drop=${drop.id} attempt=${nextAttempt}/${MAX_ATTEMPTS} next_retry_at=${nextRetryAt.toISOString()} reason=${reason}`,
      );
      return 'retried';
    }

    // Permanent — flip status + COACH_ALERT the coach.
    await this.prisma.scheduledDrop.updateMany({
      where: { id: drop.id, status: 'dispatching' },
      data: {
        status: 'failed',
        attempt_count: { increment: 1 },
        failure_reason: reason,
        next_retry_at: null,
        locked_at: null,
      },
    });
    this.logger.error(
      `drip-dispatcher PERMANENT FAILURE drop=${drop.id} client=${purchase.client_user_id} coach=${purchase.coach_user_id} package=${purchase.package_id} content=${drop.content_id} asset_type=${drop.asset_type} attempts=${nextAttempt}/${MAX_ATTEMPTS} reason=${reason}`,
    );
    await this.fireCoachAlert(drop, purchase, reason);
    return 'failed_permanently';
  }

  /**
   * COACH_ALERT for permanent drop failure. Mirrors PR-2's transfer.failed
   * COACH_ALERT envelope (billing.service.ts:1115-1131) — same kind, same
   * channel, same fire-and-forget swallow on push provider error.
   */
  private async fireCoachAlert(
    drop: ScheduledDrop,
    purchase: { id: string; client_user_id: string; coach_user_id: string; package_id: string },
    reason: string,
  ): Promise<void> {
    if (!this.notifications) {
      this.logger.warn(
        `drip-dispatcher: NotificationsService not wired — skipping COACH_ALERT for drop=${drop.id}`,
      );
      return;
    }
    const title = drop.display_title ?? drop.asset_type;
    const body = `Drip drop failed to deliver to a buyer: "${title}". Please review.`;
    try {
      await this.notifications.createNotification({
        user_id: purchase.coach_user_id,
        kind: NotificationKind.COACH_ALERT,
        body,
        payload: {
          event: 'drip_drop_failed',
          scheduled_drop_id: drop.id,
          client_purchase_id: purchase.id,
          client_user_id: purchase.client_user_id,
          package_id: purchase.package_id,
          content_id: drop.content_id,
          asset_type: drop.asset_type,
          attempts: MAX_ATTEMPTS,
          failure_reason: reason,
        },
        deep_link: `tgp://coach/clients/${purchase.client_user_id}`,
        channel: 'inapp',
      });
    } catch (err) {
      // COACH_ALERT side-effect failure must not bubble — the drop is
      // already marked 'failed' in the DB; oncall reads structured logs.
      this.logger.warn(
        `drip-dispatcher COACH_ALERT failed drop=${drop.id} coach=${purchase.coach_user_id}: ${(err as Error).message}`,
      );
    }
  }
}

// Constants exported for tests.
export const __dripDispatcherConsts = {
  TICK_BATCH_SIZE,
  MAX_ATTEMPTS,
  STALE_CLAIM_MS,
  BACKOFF_MS,
};
