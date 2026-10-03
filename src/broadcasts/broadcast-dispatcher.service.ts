import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { MessageReceivedEmitter } from '../notifications/emitters/message-received.emitter';
import { QuietHoursPolicy } from '../notifications/nudges/quiet-hours.policy';
import { coachBroadcastsEnabled } from './broadcasts.feature';
import { parseStoredRecurrence } from './broadcasts.service';
import { BroadcastScopeService } from './broadcast-scope.service';
import { readStoredCard } from './cards.service';
import { parseSegment } from './segment';
import { SegmentResolverService } from './segment-resolver.service';
import { nextOccurrence } from './recurrence';

/**
 * Optional per-thread mute probe. Lane A3 (thread mute) can bind this token;
 * until then the global NotificationPreferences mute and message_push
 * preference are honoured. A muted recipient still receives the message in
 * their thread, silently (no push), the same as a muted 1:1 thread.
 */
export const BROADCAST_THREAD_MUTE_PROBE = Symbol('BROADCAST_THREAD_MUTE_PROBE');
export interface BroadcastThreadMuteProbe {
  isThreadMuted(recipientId: string, tenantCoachId: string): Promise<boolean>;
}

/** Fan-out lease: long enough for a big roster, short enough to recover. */
export const RUN_LEASE_MS = 5 * 60_000;
/** Per-delivery lease: one message write plus a push. */
export const DELIVERY_LEASE_MS = 2 * 60_000;
/** A recurring occurrence older than this is recorded as missed, not sent late. */
export const STALE_OCCURRENCE_MS = 12 * 60 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 5;
const CLAIM_BATCH = 25;
const DELIVERY_BATCH = 200;

export type DeliveryOutcome =
  | 'delivered'
  | 'deferred'
  | 'skipped_blocked'
  | 'skipped_ineligible'
  | 'parked'
  | 'retry'
  | 'failed'
  | 'lost_lease';

/**
 * Broadcast dispatcher. One tick (every minute, flag-gated) runs four
 * idempotent steps. Any number of instances may run concurrently and any
 * instance may die at any point; correctness rests on database guards,
 * never on in-memory state:
 *
 *  1. claimDue      compare-and-set on coach_broadcasts.next_run_at plus the
 *                   unique (broadcast_id, run_key): an occurrence becomes a
 *                   run row exactly once.
 *  2. fanOutRuns    CronLease-style conditional UPDATE lease on the run;
 *                   deliveries are inserted with createMany(skipDuplicates)
 *                   over the unique (run_id, recipient_id), so a re-run after
 *                   a crash adds nobody twice.
 *  3. deliverDue    per-delivery lease; the CoachMessage insert, the card
 *                   insert and the delivered state commit in ONE transaction
 *                   fenced on lease_holder, so a delivery writes at most one
 *                   message (message_id is also unique). Quiet hours
 *                   (21:00-08:00 recipient local, OR-113-5) defer non-urgent
 *                   deliveries to 08:00 local; blocks and roster departures
 *                   skip; mute delivers silently.
 *  4. finalizeRuns  closes runs with nothing left to deliver and marks
 *                   one-off broadcasts sent.
 */
@Injectable()
export class BroadcastDispatcherService {
  private readonly logger = new Logger(BroadcastDispatcherService.name);
  readonly holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scopes: BroadcastScopeService,
    private readonly segments: SegmentResolverService,
    private readonly supabase: SupabaseService,
    private readonly messageReceived: MessageReceivedEmitter,
    @Optional()
    @Inject(BROADCAST_THREAD_MUTE_PROBE)
    private readonly muteProbe: BroadcastThreadMuteProbe | null = null,
  ) {}

  @Cron('* * * * *', { name: 'coach-broadcast-dispatch', timeZone: 'UTC' })
  async onTick(): Promise<void> {
    if (!coachBroadcastsEnabled() || this.running) return;
    this.running = true;
    try {
      await this.tick(new Date());
    } catch (err) {
      this.logger.error(
        `broadcast tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async tick(now: Date): Promise<void> {
    await this.claimDue(now);
    await this.fanOutRuns(now);
    await this.deliverDue(now);
    await this.finalizeRuns(now);
  }

  // ---- 1. occurrences -> runs ------------------------------------------------

  async claimDue(now: Date): Promise<number> {
    const due = await this.prisma.coachBroadcast.findMany({
      where: { status: { in: ['scheduled', 'sending'] }, next_run_at: { lte: now } },
      orderBy: { next_run_at: 'asc' },
      take: CLAIM_BATCH,
    });
    let created = 0;
    for (const b of due) {
      if (!b.next_run_at) continue;
      const occurrence = b.next_run_at;
      const rule = b.recurrence ? parseStoredRecurrence(b.recurrence) : null;
      const sentAfter = b.occurrences_sent + 1;
      let next: Date | null = null;
      if (rule && (!rule.count || sentAfter < rule.count)) {
        // Skip any backlog: the next occurrence is always in the future.
        next = nextOccurrence(rule, b.timezone, occurrence > now ? occurrence : now);
      }
      const stale = !!rule && now.getTime() - occurrence.getTime() > STALE_OCCURRENCE_MS;
      try {
        const won = await this.prisma.$transaction(async (tx) => {
          const cas = await tx.coachBroadcast.updateMany({
            where: { id: b.id, next_run_at: occurrence, status: { in: ['scheduled', 'sending'] } },
            data: {
              next_run_at: next,
              status: next ? 'scheduled' : 'sending',
              last_run_at: now,
              occurrences_sent: stale ? undefined : { increment: 1 },
            },
          });
          if (cas.count !== 1) return false;
          await tx.coachBroadcastRun.create({
            data: {
              broadcast_id: b.id,
              run_key: occurrence.toISOString(),
              scheduled_for: occurrence,
              status: stale ? 'failed' : 'pending',
              failure_code: stale ? 'missed_window' : null,
              completed_at: stale ? now : null,
            },
          });
          return true;
        });
        if (won) created++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    return created;
  }

  // ---- 2. runs -> deliveries ---------------------------------------------------

  async fanOutRuns(now: Date): Promise<number> {
    const runs = await this.prisma.coachBroadcastRun.findMany({
      where: { status: 'pending', OR: [{ lease_until: null }, { lease_until: { lt: now } }] },
      orderBy: { scheduled_for: 'asc' },
      take: CLAIM_BATCH,
      select: { id: true },
    });
    let done = 0;
    for (const r of runs) if (await this.fanOutRun(r.id, now)) done++;
    return done;
  }

  async fanOutRun(runId: string, now: Date): Promise<boolean> {
    const lease = await this.prisma.coachBroadcastRun.updateMany({
      where: {
        id: runId,
        status: 'pending',
        OR: [{ lease_until: null }, { lease_until: { lt: now } }],
      },
      data: { lease_holder: this.holder, lease_until: new Date(now.getTime() + RUN_LEASE_MS) },
    });
    if (lease.count !== 1) return false;
    const run = await this.prisma.coachBroadcastRun.findUnique({
      where: { id: runId },
      include: { broadcast: true },
    });
    if (!run) return false;
    const b = run.broadcast;
    const fence = { id: run.id, lease_holder: this.holder, status: 'pending' };
    const failRun = async (code: string): Promise<true> => {
      await this.prisma.coachBroadcastRun.updateMany({
        where: fence,
        data: { status: 'failed', failure_code: code, completed_at: now, lease_until: null },
      });
      // A broadcast with no further occurrence surfaces the reason to the coach.
      await this.prisma.coachBroadcast.updateMany({
        where: { id: b.id, status: 'sending', next_run_at: null },
        data: { status: 'failed', failure_code: code },
      });
      return true;
    };
    if (b.status === 'canceled') {
      return failRun('broadcast_canceled');
    }
    let segment;
    try {
      segment = parseSegment(b.segment);
    } catch {
      return failRun('segment_invalid');
    }
    const scope = await this.scopes.resolve(b.author_user_id ?? b.coach_id);
    if (scope.tenantId !== b.coach_id) {
      // The author left the tenant (sub-coach seat closed): send as the head
      // coach's roster is NOT assumed; the run fails closed and the coach sees why.
      return failRun('author_not_in_tenant');
    }
    let audience;
    try {
      audience = await this.segments.resolve(scope, segment, now);
    } catch {
      return failRun('segment_ref_not_found');
    }
    const rows: Prisma.CoachBroadcastDeliveryCreateManyInput[] = [
      ...audience.recipientIds.map((id) => ({
        run_id: run.id,
        broadcast_id: b.id,
        recipient_id: id,
        status: 'pending',
        deliver_after: now,
      })),
      ...audience.blockedIds.map((id) => ({
        run_id: run.id,
        broadcast_id: b.id,
        recipient_id: id,
        status: 'skipped_blocked',
        deliver_after: now,
      })),
    ];
    for (let i = 0; i < rows.length; i += 500) {
      await this.prisma.coachBroadcastDelivery.createMany({
        data: rows.slice(i, i + 500),
        skipDuplicates: true,
      });
    }
    await this.prisma.coachBroadcastRun.updateMany({
      where: fence,
      data: {
        status: 'delivering',
        recipient_count: audience.recipientIds.length,
        fanned_out_at: now,
        lease_until: null,
      },
    });
    return true;
  }

  // ---- 3. deliveries -> messages ---------------------------------------------

  async deliverDue(now: Date): Promise<Record<DeliveryOutcome, number>> {
    const due = await this.prisma.coachBroadcastDelivery.findMany({
      where: {
        status: { in: ['pending', 'deferred'] },
        deliver_after: { lte: now },
        OR: [{ lease_until: null }, { lease_until: { lt: now } }],
      },
      orderBy: { deliver_after: 'asc' },
      take: DELIVERY_BATCH,
      select: { id: true },
    });
    const tally: Record<DeliveryOutcome, number> = {
      delivered: 0,
      deferred: 0,
      skipped_blocked: 0,
      skipped_ineligible: 0,
      parked: 0,
      retry: 0,
      failed: 0,
      lost_lease: 0,
    };
    for (const d of due) tally[await this.deliverOne(d.id, now)]++;
    return tally;
  }

  async deliverOne(deliveryId: string, now: Date): Promise<DeliveryOutcome> {
    const claim = await this.prisma.coachBroadcastDelivery.updateMany({
      where: {
        id: deliveryId,
        status: { in: ['pending', 'deferred'] },
        deliver_after: { lte: now },
        OR: [{ lease_until: null }, { lease_until: { lt: now } }],
      },
      data: {
        lease_holder: this.holder,
        lease_until: new Date(now.getTime() + DELIVERY_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claim.count !== 1) return 'lost_lease';
    const d = await this.prisma.coachBroadcastDelivery.findUnique({
      where: { id: deliveryId },
      include: { run: { include: { broadcast: true } } },
    });
    if (!d) return 'lost_lease';
    const fence = { id: d.id, lease_holder: this.holder, status: { in: ['pending', 'deferred'] } };
    const settle = async (data: Prisma.CoachBroadcastDeliveryUpdateManyMutationInput) =>
      this.prisma.coachBroadcastDelivery.updateMany({
        where: fence,
        data: { lease_until: null, ...data },
      });
    const b = d.run.broadcast;
    try {
      if (b.status === 'canceled') {
        await settle({ status: 'skipped_ineligible', failure_code: 'broadcast_canceled' });
        return 'skipped_ineligible';
      }
      if (b.status === 'paused') {
        await settle({ deliver_after: new Date(now.getTime() + 5 * 60_000) });
        return 'parked';
      }
      const authorId = b.author_user_id ?? b.coach_id;
      // Re-check eligibility at send time: still a live client of this tenant.
      const client = await this.prisma.user.findFirst({
        where: { id: d.recipient_id, role: 'student', deleted_at: null, coach_id: b.coach_id },
        select: { id: true, name: true },
      });
      if (!client) {
        await settle({ status: 'skipped_ineligible', failure_code: 'not_on_roster' });
        return 'skipped_ineligible';
      }
      const blocked = await this.prisma.userBlock.findFirst({
        where: {
          OR: [
            { blocker_id: { in: [authorId, b.coach_id] }, blocked_id: client.id },
            { blocker_id: client.id, blocked_id: { in: [authorId, b.coach_id] } },
          ],
        },
        select: { id: true },
      });
      if (blocked) {
        await settle({ status: 'skipped_blocked' });
        return 'skipped_blocked';
      }
      const prefs = await this.prisma.notificationPreferences.findUnique({
        where: { user_id: client.id },
        select: { timezone: true, muted: true, message_push: true },
      });
      if (!b.urgent) {
        const quiet = QuietHoursPolicy.evaluate(now, prefs?.timezone ?? 'America/Los_Angeles');
        if (!quiet.allowed && quiet.deferred_until) {
          await settle({
            status: 'deferred',
            deliver_after: quiet.deferred_until,
            defer_reason: 'quiet_hours',
          });
          return 'deferred';
        }
      }
      const threadMuted = this.muteProbe
        ? await this.muteProbe.isThreadMuted(client.id, b.coach_id)
        : false;
      const pushDecision =
        prefs?.muted || threadMuted
          ? 'suppressed_muted'
          : prefs && !prefs.message_push
            ? 'suppressed_pref'
            : 'pending';
      const card = readStoredCard(b.card);
      const body = personalize(b.body, client.name);
      const delivered = await this.prisma.$transaction(async (tx) => {
        const msg = await tx.coachMessage.create({
          data: { coach_id: b.coach_id, client_id: client.id, sender_id: authorId, body },
          select: { id: true },
        });
        if (card) {
          await tx.coachMessageCard.create({
            data: {
              message_id: msg.id,
              card_type: card.type,
              ref_id: card.ref_id,
              snapshot: card.snapshot,
            },
          });
        }
        const res = await tx.coachBroadcastDelivery.updateMany({
          where: fence,
          data: {
            status: 'delivered',
            message_id: msg.id,
            delivered_at: now,
            push_status: pushDecision,
            lease_until: null,
            defer_reason: null,
            failure_code: null,
          },
        });
        if (res.count !== 1) throw new LeaseLostError();
        return msg.id;
      });
      void this.supabase.broadcastNewMessage(client.id);
      if (pushDecision === 'pending') {
        const senderName = await this.senderName(authorId);
        await this.messageReceived.emit(client.id, { senderName, threadId: client.id });
        await this.prisma.coachBroadcastDelivery.updateMany({
          where: { id: d.id, message_id: delivered },
          data: { push_status: 'sent' },
        });
      }
      return 'delivered';
    } catch (err) {
      if (err instanceof LeaseLostError) return 'lost_lease';
      const attempts = d.attempts;
      this.logger.warn(
        `broadcast delivery ${d.id} attempt ${attempts} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        await settle({ status: 'failed', failure_code: 'delivery_error' });
        return 'failed';
      }
      await settle({ deliver_after: new Date(now.getTime() + 2 ** attempts * 60_000) });
      return 'retry';
    }
  }

  // ---- 4. close runs ----------------------------------------------------------

  async finalizeRuns(now: Date): Promise<number> {
    const open = await this.prisma.coachBroadcastRun.findMany({
      where: {
        status: 'delivering',
        deliveries: { none: { status: { in: ['pending', 'deferred'] } } },
      },
      select: { id: true, broadcast_id: true },
      take: 100,
    });
    let closed = 0;
    for (const r of open) {
      const res = await this.prisma.coachBroadcastRun.updateMany({
        where: {
          id: r.id,
          status: 'delivering',
          deliveries: { none: { status: { in: ['pending', 'deferred'] } } },
        },
        data: { status: 'complete', completed_at: now },
      });
      if (res.count !== 1) continue;
      closed++;
      // A broadcast with no future occurrence and no open run is finished.
      const openRuns = await this.prisma.coachBroadcastRun.count({
        where: { broadcast_id: r.broadcast_id, status: { in: ['pending', 'delivering'] } },
      });
      if (openRuns === 0) {
        await this.prisma.coachBroadcast.updateMany({
          where: { id: r.broadcast_id, status: 'sending', next_run_at: null },
          data: { status: 'sent' },
        });
      }
    }
    // A finished recurring series whose last occurrence was missed (stale)
    // never had a delivering run; close it too.
    await this.prisma.coachBroadcast.updateMany({
      where: {
        status: 'sending',
        next_run_at: null,
        runs: { none: { status: { in: ['pending', 'delivering'] } } },
      },
      data: { status: 'sent' },
    });
    return closed;
  }

  private async senderName(userId: string): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name?.trim() || 'Your coach';
  }
}

class LeaseLostError extends Error {
  readonly code = 'BROADCAST_DELIVERY_LEASE_LOST' as const;
  constructor() {
    super('delivery lease lost');
    this.name = 'LeaseLostError';
  }
}

/** `{first_name}` -> the recipient's first name (or "there"). */
export function personalize(body: string, name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{first_name\}/g, first);
}
