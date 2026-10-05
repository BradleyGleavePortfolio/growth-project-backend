import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { PayoutAdjustmentNotice } from '@prisma/client';
import {
  formatMoney,
  heldBreakdownLines,
  type PayoutNoticeAmounts,
} from '../connect/fees/payout-notice-copy';
import { settlementFailureCode } from '../connect/fees/charge-settlement.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { NotificationKind } from '../notifications/notification-kind';
import { NotificationsService } from '../notifications/notifications.service';
import { PushAbortedError } from '../notifications/push-delivery.types';
import { PrismaService } from '../prisma.service';

// S-FEE round 5 (owner decision OR-111-1) — delivery and read side of the
// payee notices ChargeSettlementService writes after a refund / chargeback /
// dispute outcome converges.
//
// Delivery (at least once, never blocking the money path): an in-app
// Notification row (kind coach_alert), a push when the payee's coach-alert
// push preference is on, and the coach-payout-adjustment email through
// EmailService (EMAIL_TRANSPORT=log records it only; once the provider is
// live it is sent, keyed by the notice's idempotency key so a retry never
// sends twice). A notice is claimed with a CAS on dispatch_claimed_at before
// anything is sent, so two workers never deliver the same notice together;
// an expired claim (crash mid-delivery) is retried by the sweeper.
//
// Read side (Money page): the payee's open held balance per currency (every
// open PayeeRecovery: amount - collected) and their notices with the full
// breakdown, newest first, cursor-paginated, scoped to the caller.

export const PAYOUT_NOTICE_DEEP_LINK = 'tgp://coach/money';
export const PAYOUT_NOTICE_CLAIM_TTL_MS = 5 * 60_000;
export const PAYOUT_NOTICE_MAX_ATTEMPTS = 6;
// Round 17 (Sol B-684-3): no channel starts with less than this left on the notice's claim, so
// a provider call (bounded by its own client timeout) ends before another worker may take over.
export const PAYOUT_NOTICE_SEND_MARGIN_MS = 60_000;
export const PAYOUT_NOTICE_PAGE_MAX = 50;

// Channel outcomes that are final: a retry never repeats them (B-627-6).
const INAPP_DONE = new Set(['sent', 'off']);
const PUSH_DONE = new Set(['sent', 'off', 'no_token', 'invalid_token']);
const EMAIL_DONE = new Set(['sent', 'logged', 'no_address', 'disabled']);

// The limits one claim's channels are sent within (Sol B-684-3).
interface SendWindow {
  canSend: () => Promise<boolean>;
  stopAt: number;
  claimedAt: Date;
}

interface ChannelResult {
  status: string;
  notification_id?: string;
  // The channel's receipt was already written with the delivery itself.
  receipt_saved?: boolean;
  // Round 17 (Sol B-684-3): the send boundary refused; the channel stays as it was.
  stopped?: boolean;
}

class InAppAlreadyRecorded extends Error {
  constructor() {
    super('in-app receipt already recorded by another attempt');
  }
}

/** The EmailService idempotency key of one email attempt of a notice. */
export function payoutNoticeEmailKey(noticeKey: string, attempt: number): string {
  return attempt <= 1 ? noticeKey : `${noticeKey}:e${attempt}`;
}

export interface PayoutNoticeView {
  id: string;
  event: string;
  role: string;
  purchase_id: string;
  stripe_charge_id: string;
  currency: string;
  title: string;
  body: string;
  charge_gross_cents: number;
  customer_refunded_cents: number;
  // Round 13 (B-683-1): set on a converted charge's refund notice (the client's own currency).
  client_currency: string | null;
  client_refunded_cents: number | null;
  reversed_cents: number;
  reinstated_cents: number;
  held_cents: number;
  held_open_cents: number;
  held_now_open_cents: number;
  held_breakdown: Array<{ code: string; label: string; cents: number; display: string }>;
  needs_attention: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

export interface PayoutAdjustmentsView {
  open_balance: Array<{ currency: string; held_cents: number; display: string; charges: number }>;
  needs_attention_count: number;
  notices: PayoutNoticeView[];
  next_cursor: string | null;
}

const pastDeadline = (deadlineAt?: number): boolean =>
  deadlineAt !== undefined && Date.now() >= deadlineAt;

/** The email provider call was refused because the notice's send window closed. */
class NoticeSendWindowClosed extends Error {
  constructor() {
    super('SFEE_NOTICE_SEND_WINDOW_CLOSED');
    this.name = 'NoticeSendWindowClosed';
  }
}

/**
 * Round 19 (Sol B-684-3): the AbortSignal handed to a push / email provider call. It aborts at
 * `stopAt` (the run deadline or the end of this worker's claim, whichever comes first) on a
 * timer, and any read of `aborted` at or past `stopAt` aborts it on the spot: a provider's check
 * right before it sends reads the clock, so a late timer (busy event loop) never lets a send
 * start after the limit.
 */
export function noticeSendSignal(
  stopAt: number,
  reason: () => Error,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const { signal } = controller;
  let aborted = false;
  const expire = (): void => {
    if (aborted) return;
    aborted = true;
    controller.abort(reason());
  };
  const timer = setTimeout(expire, Math.max(0, stopAt - Date.now()));
  timer.unref?.();
  Object.defineProperty(signal, 'aborted', {
    configurable: true,
    get: (): boolean => {
      if (!aborted && Date.now() >= stopAt) expire();
      return aborted;
    },
  });
  return { signal, release: () => clearTimeout(timer) };
}

function amountsOf(n: PayoutAdjustmentNotice): PayoutNoticeAmounts {
  return {
    currency: n.currency,
    charge_gross_cents: n.charge_gross_cents,
    customer_refunded_cents: n.customer_refunded_cents,
    client_currency: n.client_currency,
    client_refunded_cents: n.client_refunded_cents,
    reversed_cents: n.reversed_cents,
    reinstated_cents: n.reinstated_cents,
    released_cents: 0,
    held_cents: n.held_cents,
    held_tgp_fee_cents: n.held_tgp_fee_cents,
    held_stripe_fee_cents: n.held_stripe_fee_cents,
    held_dispute_fee_cents: n.held_dispute_fee_cents,
    held_not_reversed_cents: n.held_not_reversed_cents,
    held_open_cents: n.held_open_cents,
  };
}

@Injectable()
export class PayoutNoticeService {
  private readonly logger = new Logger(PayoutNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Deliver every undelivered notice of one charge (after its adjustment).
   * `recorded` counts the charge's notices of any state, so a caller can tell
   * a settlement charge (exact-amount notice exists) from a legacy one.
   */
  async dispatchForCharge(chargeId: string): Promise<{ recorded: number; sent: number }> {
    const rows = await this.prisma.payoutAdjustmentNotice.findMany({
      where: { stripe_charge_id: chargeId },
      orderBy: { created_at: 'asc' },
    });
    let sent = 0;
    for (const n of rows) {
      if (n.dispatched_at) continue;
      if (await this.dispatchOne(n)) sent += 1;
    }
    return { recorded: rows.length, sent };
  }

  /**
   * Whether a charge has exact-amount notices (a settlement charge). Sends
   * nothing, so it is safe inside the webhook transaction (C-627-7).
   */
  async hasNotices(chargeId: string): Promise<boolean> {
    const n = await this.prisma.payoutAdjustmentNotice.count({
      where: { stripe_charge_id: chargeId },
    });
    return n > 0;
  }

  /**
   * Sweeper: notices still undelivered a minute after they were written. Round 13 (Sol
   * B-684-3): no new notice or channel starts once `deadlineAt` passes; an unfinished
   * channel stays pending and the next run sends only that channel.
   */
  async dispatchPending(now: Date = new Date(), limit = 25, deadlineAt?: number): Promise<number> {
    const rows = await this.prisma.payoutAdjustmentNotice.findMany({
      where: {
        dispatched_at: null,
        dispatch_attempts: { lt: PAYOUT_NOTICE_MAX_ATTEMPTS },
        created_at: { lte: new Date(now.getTime() - 60_000) },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    let sent = 0;
    for (const n of rows) {
      if (pastDeadline(deadlineAt)) break;
      if (await this.dispatchOne(n, now, deadlineAt)) sent += 1;
    }
    return sent;
  }

  private async dispatchOne(
    n: PayoutAdjustmentNotice,
    now: Date = new Date(),
    deadlineAt?: number,
  ): Promise<boolean> {
    if (n.dispatched_at) return false;
    // Round 17 (Sol B-684-3): the claim is stamped with the time it is taken, never an earlier
    // batch start, so a claim is never born older than its TTL.
    const claimedAt = new Date(Math.max(now.getTime(), Date.now()));
    const claim = await this.prisma.payoutAdjustmentNotice.updateMany({
      where: {
        id: n.id,
        dispatched_at: null,
        OR: [
          { dispatch_claimed_at: null },
          {
            dispatch_claimed_at: {
              lte: new Date(claimedAt.getTime() - PAYOUT_NOTICE_CLAIM_TTL_MS),
            },
          },
        ],
      },
      data: { dispatch_claimed_at: claimedAt, dispatch_attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return false;
    // Round 17 (Sol B-684-3): immediately before each channel starts, the claim is re-proved
    // (a fence that matches only this worker's claim) and then the run deadline and the claim's
    // remaining lifetime are checked, after every preparatory await. A stop keeps the unfinished
    // channels pending, releases the claim and does not count the attempt (C-684-10).
    const canSend = async (): Promise<boolean> => {
      const fence = await this.prisma.payoutAdjustmentNotice.updateMany({
        where: { id: n.id, dispatched_at: null, dispatch_claimed_at: claimedAt },
        data: { dispatch_claimed_at: claimedAt },
      });
      const sendBy =
        claimedAt.getTime() + PAYOUT_NOTICE_CLAIM_TTL_MS - PAYOUT_NOTICE_SEND_MARGIN_MS;
      return fence.count === 1 && !pastDeadline(deadlineAt) && Date.now() < sendBy;
    };
    // Round 19 (Sol B-684-3): a provider call in flight is aborted at the run deadline or when
    // this worker's claim ends, and none starts at or after that point (noticeSendSignal).
    const stopAt = Math.min(
      deadlineAt ?? Number.POSITIVE_INFINITY,
      claimedAt.getTime() + PAYOUT_NOTICE_CLAIM_TTL_MS,
    );
    const window = { canSend, stopAt, claimedAt };
    const stop = async (): Promise<false> => {
      await this.prisma.payoutAdjustmentNotice.updateMany({
        where: { id: n.id, dispatched_at: null, dispatch_claimed_at: claimedAt },
        data: { dispatch_claimed_at: null, dispatch_attempts: { decrement: 1 } },
      });
      return false;
    };
    // Re-read under the claim: the channels a previous attempt finished are
    // never repeated (B-627-6, round 6).
    const row = await this.prisma.payoutAdjustmentNotice.findUnique({ where: { id: n.id } });
    if (!row || row.dispatched_at) return false;
    const payload = {
      event: 'payout_adjustment',
      notice_id: row.id,
      notice_event: row.event,
      purchase_id: row.purchase_id,
      stripe_charge_id: row.stripe_charge_id,
      currency: row.currency,
      customer_refunded_cents: row.customer_refunded_cents,
      reversed_cents: row.reversed_cents,
      held_cents: row.held_cents,
      held_open_cents: row.held_open_cents,
      held_tgp_fee_cents: row.held_tgp_fee_cents,
      held_stripe_fee_cents: row.held_stripe_fee_cents,
      held_dispute_fee_cents: row.held_dispute_fee_cents,
      held_not_reversed_cents: row.held_not_reversed_cents,
    };
    // Each channel's outcome is written as soon as it is known, so a channel
    // whose receipt was persisted is never repeated. The in-app row and its
    // receipt commit together (C-627-8 Sol, round 7); push and email are
    // at least once across a receipt write that fails after the provider
    // accepted them (email additionally dedupes on its own attempt key).
    if (!INAPP_DONE.has(row.inapp_status) && !(await canSend())) return stop();
    const inapp: ChannelResult = INAPP_DONE.has(row.inapp_status)
      ? { status: row.inapp_status }
      : await this.deliverInApp(row, payload);
    if (!inapp.receipt_saved && (inapp.status !== row.inapp_status || inapp.notification_id)) {
      await this.saveChannel(row.id, {
        inapp_status: inapp.status,
        ...(inapp.notification_id ? { inapp_notification_id: inapp.notification_id } : {}),
      });
    }
    // Push and email wait for the next run once the deadline passes (Sol B-684-3).
    if (!PUSH_DONE.has(row.push_status) && !(await canSend())) return stop();
    const push: ChannelResult = PUSH_DONE.has(row.push_status)
      ? { status: row.push_status }
      : await this.deliverPush(row, payload, window);
    if (push.status !== row.push_status || push.notification_id) {
      await this.saveChannel(row.id, {
        push_status: push.status,
        ...(push.notification_id ? { push_notification_id: push.notification_id } : {}),
      });
    }
    if (push.stopped) return stop();
    if (!EMAIL_DONE.has(row.email_status) && !(await canSend())) return stop();
    const mailOutcome: ChannelResult = EMAIL_DONE.has(row.email_status)
      ? { status: row.email_status }
      : await this.deliverEmail(row, window);
    if (mailOutcome.stopped) return stop();
    if (mailOutcome.status !== row.email_status) {
      await this.saveChannel(row.id, { email_status: mailOutcome.status });
    }
    const failed =
      !INAPP_DONE.has(inapp.status) ||
      !PUSH_DONE.has(push.status) ||
      !EMAIL_DONE.has(mailOutcome.status);
    // A channel that is not done leaves the notice undelivered (the claim
    // expires and the sweeper retries only that channel, up to
    // PAYOUT_NOTICE_MAX_ATTEMPTS); the Money page shows it either way.
    const finalAttempt = row.dispatch_attempts >= PAYOUT_NOTICE_MAX_ATTEMPTS;
    if (!failed || finalAttempt) {
      await this.prisma.payoutAdjustmentNotice.updateMany({
        where: { id: row.id, dispatched_at: null },
        data: { dispatched_at: new Date() },
      });
    }
    if (failed && finalAttempt) {
      this.logger.error(
        `SFEE_NOTICE_UNDELIVERED alert=true notice=${row.id} payee=${row.payee_user_id} inapp=${inapp.status} push=${push.status} email=${mailOutcome.status}: gave up after ${PAYOUT_NOTICE_MAX_ATTEMPTS} attempts; the payee still sees it on the Money page`,
      );
    }
    return !failed;
  }

  private async saveChannel(
    id: string,
    data: {
      inapp_status?: string;
      inapp_notification_id?: string;
      push_status?: string;
      push_notification_id?: string;
      email_status?: string;
    },
  ): Promise<void> {
    await this.prisma.payoutAdjustmentNotice.updateMany({ where: { id }, data });
  }

  private async deliverInApp(
    n: PayoutAdjustmentNotice,
    payload: Record<string, unknown>,
  ): Promise<ChannelResult> {
    // C-627-8 (Sol, round 7): the inbox row and the notice's in-app receipt
    // are one transaction. A receipt write that fails rolls the inbox row
    // back, so the retry creates exactly one inbox row for the notice.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.notifications.createNotification(
          {
            user_id: n.payee_user_id,
            kind: NotificationKind.COACH_ALERT,
            body: n.body,
            payload,
            deep_link: PAYOUT_NOTICE_DEEP_LINK,
            channel: 'inapp',
          },
          tx,
        );
        const result: ChannelResult = created
          ? { status: 'sent', notification_id: created.id }
          : { status: 'off' };
        const receipt = await tx.payoutAdjustmentNotice.updateMany({
          where: { id: n.id, inapp_status: n.inapp_status },
          data: {
            inapp_status: result.status,
            ...(result.notification_id ? { inapp_notification_id: result.notification_id } : {}),
          },
        });
        if (receipt.count !== 1) {
          // Another worker recorded this channel first: roll this row back.
          throw new InAppAlreadyRecorded();
        }
        return { ...result, receipt_saved: true };
      });
    } catch (err) {
      if (err instanceof InAppAlreadyRecorded) {
        const fresh = await this.prisma.payoutAdjustmentNotice.findUnique({ where: { id: n.id } });
        return { status: fresh?.inapp_status ?? 'failed', receipt_saved: true };
      }
      this.logger.warn(
        `SFEE_NOTICE_INAPP_FAILED notice=${n.id} payee=${n.payee_user_id}: ${settlementFailureCode(err)}`,
      );
      return { status: 'failed' };
    }
  }

  // The push honours the payee's coach-alert push preference and mute ('off',
  // done). The 60 s limiter is keyed by the notice (C-627-7), so a second
  // notice to the same coach is never suppressed; a suppressed push of the
  // same notice is 'rate_limited' and retried, never mistaken for a mute.
  private async deliverPush(
    n: PayoutAdjustmentNotice,
    payload: Record<string, unknown>,
    { canSend, stopAt }: SendWindow,
  ): Promise<ChannelResult> {
    const unchanged = (rowId?: string | null): ChannelResult => ({
      status: n.push_status,
      stopped: true,
      ...(rowId ? { notification_id: rowId } : {}),
    });
    try {
      let rowId = n.push_notification_id;
      if (!rowId) {
        // Hand-built wiring without channelGate falls back to
        // createNotification's own gate (a null then reads as rate_limited).
        const gate =
          typeof this.notifications.channelGate === 'function'
            ? await this.notifications.channelGate(
                n.payee_user_id,
                NotificationKind.COACH_ALERT,
                'push',
              )
            : 'enabled';
        if (gate !== 'enabled') return { status: 'off' };
        if (!(await canSend())) return unchanged();
        const pushRow = await this.notifications.createNotification({
          user_id: n.payee_user_id,
          kind: NotificationKind.COACH_ALERT,
          body: n.body,
          payload,
          deep_link: PAYOUT_NOTICE_DEEP_LINK,
          channel: 'push',
          throttle_key: n.id,
          // Opus C-693-2: one inbox item per notice; hidden only behind its inapp row.
          push_twin: true,
        });
        if (!pushRow) {
          this.logger.warn(
            `SFEE_NOTICE_PUSH_DEFERRED notice=${n.id} payee=${n.payee_user_id}: push suppressed by the rate limit; the sweeper retries`,
          );
          return { status: 'rate_limited' };
        }
        rowId = pushRow.id;
      }
      if (!(await canSend())) return unchanged(rowId);
      // Round 19 (Sol B-684-3): pushToUser re-checks the signal after its token read and right
      // before Expo; an abort there leaves the push pending for the next run.
      const sendWindow = noticeSendSignal(
        stopAt,
        () => new PushAbortedError('SFEE_NOTICE_SEND_WINDOW_CLOSED'),
      );
      let res: Awaited<ReturnType<NotificationsService['pushToUser']>>;
      try {
        res = await this.notifications.pushToUser(
          n.payee_user_id,
          n.title,
          n.body,
          { type: 'payout_adjustment', notice_id: n.id, deep_link: PAYOUT_NOTICE_DEEP_LINK },
          sendWindow.signal,
        );
      } finally {
        sendWindow.release();
      }
      if (res.code === 'aborted') return unchanged(rowId);
      if (res.delivered) return { status: 'sent', notification_id: rowId };
      if (res.code === 'no-token') return { status: 'no_token', notification_id: rowId };
      // The device token is dead: a retry cannot reach it (done, not failed).
      if (res.code === 'invalid-token') return { status: 'invalid_token', notification_id: rowId };
      // A returned provider failure is a failure (B-627-6): retried.
      this.logger.warn(
        `SFEE_NOTICE_PUSH_FAILED notice=${n.id} payee=${n.payee_user_id}: ${res.code}`,
      );
      return { status: 'failed', notification_id: rowId };
    } catch (err) {
      this.logger.warn(
        `SFEE_NOTICE_PUSH_FAILED notice=${n.id} payee=${n.payee_user_id}: ${settlementFailureCode(err)}`,
      );
      return { status: 'failed', notification_id: n.push_notification_id ?? undefined };
    }
  }

  /**
   * Email retry protocol (B-627-6, round 6). EmailService keys every send
   * and never re-sends a key, even one whose log row ended 'failed' (a reuse
   * answers 'skipped'). So attempt k uses its own key (attempt 1 the notice
   * key, attempt k > 1 `${key}:e${k}`), and before a new attempt the previous
   * attempt's EmailSendLog row decides: sent / logged = done (nothing is
   * sent again); sending and younger than the claim TTL = still in flight
   * (wait); failed, missing or a stale sending row = send the next attempt.
   */
  private async deliverEmail(
    n: PayoutAdjustmentNotice,
    { canSend, stopAt, claimedAt: now }: SendWindow,
  ): Promise<ChannelResult> {
    if (!this.email) return { status: 'disabled' };
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: n.payee_user_id },
        select: { email: true, name: true },
      });
      if (!user?.email) return { status: 'no_address' };
      if (n.email_attempts > 0) {
        const prev = await this.prisma.emailSendLog.findUnique({
          where: { idempotency_key: payoutNoticeEmailKey(n.idempotency_key, n.email_attempts) },
          select: { status: true, created_at: true },
        });
        if (prev && (prev.status === 'sent' || prev.status === 'logged')) {
          return { status: prev.status };
        }
        if (
          prev &&
          prev.status === 'sending' &&
          prev.created_at.getTime() > now.getTime() - PAYOUT_NOTICE_CLAIM_TTL_MS
        ) {
          return { status: 'pending' };
        }
      }
      if (!(await canSend())) return { status: n.email_status, stopped: true };
      const attempt = n.email_attempts + 1;
      // Recorded before the send: a crash after it never reuses this key.
      const taken = await this.prisma.payoutAdjustmentNotice.updateMany({
        where: { id: n.id, email_attempts: n.email_attempts },
        data: { email_attempts: attempt },
      });
      // Round 19 (Sol B-684-3): another worker took this attempt number, so this one sends
      // nothing. After the write the claim and the budget are proved again; a stop returns the
      // unused attempt number (only while this worker still holds the claim) and sends nothing.
      if (taken.count !== 1) return { status: n.email_status, stopped: true };
      if (!(await canSend())) {
        await this.prisma.payoutAdjustmentNotice.updateMany({
          where: { id: n.id, email_attempts: attempt, dispatch_claimed_at: now },
          data: { email_attempts: n.email_attempts },
        });
        return { status: n.email_status, stopped: true };
      }
      const sendWindow = noticeSendSignal(stopAt, () => new NoticeSendWindowClosed());
      let status: string;
      try {
        status = await this.sendEmail(
          n,
          user,
          payoutNoticeEmailKey(n.idempotency_key, attempt),
          sendWindow.signal,
        );
      } finally {
        sendWindow.release();
      }
      // The provider was never called (EmailService checked the signal right before it): the
      // email stays as it was and the next run uses the next attempt number.
      if (status === 'not_started') return { status: n.email_status, stopped: true };
      // 'skipped' means the key is already in the log (another sender):
      // the next attempt reads that row instead of sending.
      return { status: status === 'skipped' ? 'pending' : status };
    } catch (err) {
      this.logger.warn(
        `SFEE_NOTICE_EMAIL_FAILED notice=${n.id} payee=${n.payee_user_id}: ${settlementFailureCode(err)}`,
      );
      return { status: 'failed' };
    }
  }

  private async sendEmail(
    n: PayoutAdjustmentNotice,
    user: { email: string; name: string | null },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.email) return 'disabled';
    const a = amountsOf(n);
    const m = (cents: number) => formatMoney(cents, n.currency);
    const collected = Math.max(0, n.held_cents - n.held_open_cents);
    const res = await this.email.send({
      to: user.email,
      template: EmailTemplateKey.COACH_PAYOUT_ADJUSTMENT,
      idempotencyKey,
      signal,
      data: {
        subject: n.title,
        title: n.title,
        recipient_name: user.name,
        summary: n.body,
        charge_display: m(n.charge_gross_cents),
        customer_refunded_display:
          n.client_currency && n.client_refunded_cents !== null
            ? `${formatMoney(n.client_refunded_cents, n.client_currency)} (${m(n.customer_refunded_cents)} after conversion)`
            : m(n.customer_refunded_cents),
        reversed_display: m(n.reversed_cents),
        reinstated_display: n.reinstated_cents > 0 ? m(n.reinstated_cents) : null,
        held_display: m(n.held_cents),
        held_open_display: m(n.held_open_cents),
        held_collected_display: collected > 0 ? m(collected) : null,
        held_lines: heldBreakdownLines(a),
        has_hold: n.held_cents > 0,
      },
    });
    if (res.notStarted) return 'not_started';
    if (res.status === 'failed') {
      this.logger.warn(
        `SFEE_NOTICE_EMAIL_FAILED notice=${n.id} payee=${n.payee_user_id}: provider_failed`,
      );
    }
    return res.status;
  }

  /** Money page: open held balance + notices for one payee (newest first). */
  async listForPayee(
    payeeUserId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<PayoutAdjustmentsView> {
    const limit = Math.max(1, Math.min(PAYOUT_NOTICE_PAGE_MAX, opts.limit ?? 20));
    const [open, page, unacknowledged] = await Promise.all([
      this.prisma.payeeRecovery.findMany({
        where: { payee_user_id: payeeUserId, status: 'open' },
        select: { settlement_id: true, currency: true, amount_cents: true, collected_cents: true },
      }),
      this.prisma.payoutAdjustmentNotice.findMany({
        where: { payee_user_id: payeeUserId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      }),
      this.prisma.payoutAdjustmentNotice.count({
        where: { payee_user_id: payeeUserId, acknowledged_at: null },
      }),
    ]);
    const byCurrency = new Map<string, { cents: number; settlements: Set<string> }>();
    const openBySettlement = new Map<string, number>();
    for (const r of open) {
      const left = Math.max(0, r.amount_cents - r.collected_cents);
      if (left <= 0) continue;
      const e = byCurrency.get(r.currency) ?? { cents: 0, settlements: new Set<string>() };
      e.cents += left;
      e.settlements.add(r.settlement_id);
      byCurrency.set(r.currency, e);
      openBySettlement.set(r.settlement_id, (openBySettlement.get(r.settlement_id) ?? 0) + left);
    }
    const rows = page.slice(0, limit);
    // Only the newest notice of a charge carries its live open amount, on any page (C-684-2).
    const openIds = [...new Set(rows.map((n) => n.settlement_id))].filter((id) =>
      openBySettlement.has(id),
    );
    const newest = new Map<string, string>();
    const latest = openIds.length
      ? await this.prisma.payoutAdjustmentNotice.findMany({
          where: { payee_user_id: payeeUserId, settlement_id: { in: openIds } },
          orderBy: [{ settlement_id: 'asc' }, { created_at: 'desc' }, { id: 'desc' }],
          // Sol C-684-4: one row per settlement (DISTINCT ON), never every historical notice.
          distinct: ['settlement_id'],
          select: { id: true, settlement_id: true },
        })
      : [];
    for (const n of latest) if (!newest.has(n.settlement_id)) newest.set(n.settlement_id, n.id);
    const notices = rows.map((n): PayoutNoticeView => {
      const live =
        newest.get(n.settlement_id) === n.id ? (openBySettlement.get(n.settlement_id) ?? 0) : 0;
      return {
        id: n.id,
        event: n.event,
        role: n.role,
        purchase_id: n.purchase_id,
        stripe_charge_id: n.stripe_charge_id,
        currency: n.currency,
        title: n.title,
        body: n.body,
        charge_gross_cents: n.charge_gross_cents,
        customer_refunded_cents: n.customer_refunded_cents,
        client_currency: n.client_currency,
        client_refunded_cents: n.client_refunded_cents,
        reversed_cents: n.reversed_cents,
        reinstated_cents: n.reinstated_cents,
        held_cents: n.held_cents,
        held_open_cents: n.held_open_cents,
        held_now_open_cents: live,
        held_breakdown: heldBreakdownLines(amountsOf(n)),
        needs_attention: n.acknowledged_at === null || live > 0,
        acknowledged_at: n.acknowledged_at ? n.acknowledged_at.toISOString() : null,
        created_at: n.created_at.toISOString(),
      };
    });
    return {
      open_balance: [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, e]) => ({
          currency,
          held_cents: e.cents,
          display: formatMoney(e.cents, currency),
          charges: e.settlements.size,
        })),
      needs_attention_count: unacknowledged,
      notices,
      next_cursor: page.length > limit ? (rows[rows.length - 1]?.id ?? null) : null,
    };
  }

  /** The payee has seen a notice (its open amount, if any, still shows). */
  async acknowledge(payeeUserId: string, noticeId: string): Promise<{ acknowledged_at: string }> {
    const now = new Date();
    const res = await this.prisma.payoutAdjustmentNotice.updateMany({
      where: { id: noticeId, payee_user_id: payeeUserId },
      data: { acknowledged_at: now },
    });
    if (res.count !== 1) {
      throw new NotFoundException({
        code: 'PAYOUT_NOTICE_NOT_FOUND',
        message:
          'That payout notice is not on this account. Refresh Money to see the current notices.',
      });
    }
    return { acknowledged_at: now.toISOString() };
  }
}
