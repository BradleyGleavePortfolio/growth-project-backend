import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  COACH_ACCOUNT_HOLD_REASON,
  coachAccountHoldNotice,
  coachAccountHoldRetryKey,
  coachAccountWaitingLine,
  coachLocalDay,
  isCoachAccountHoldEnabled,
} from '../src/checkout/dunning-v2/coach-account-hold';
import { formatLockoutDate } from '../src/checkout/dunning-v2/dunning-v2.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  BRIEF_MAX_NARRATIVE_CHARS,
  buildFallbackNarrative,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import type { BriefContext, BriefContextHeadCoach } from '../src/coach/brief/coach-brief.types';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import {
  DAY,
  HOUR,
  READY,
  RESTRICTED,
  T0,
  at,
  buildWorld,
  flush,
  fixture,
  stub,
  type HoldWorld,
} from './support/pf7-hold-world';

/**
 * PF-7-BE (owner #PF-STRIPE option 1; operator rulings R1-R7). A renewal
 * that fails because the coach's own Stripe account can't take payments
 * keeps the client's access, tells the coach (PF-W8 at once, PF-W9 in the
 * brief), and is paid once the account is fixed.
 */

const PF_W8_TWO =
  "Your Stripe account can't take payments right now, so 2 clients' renewals did not go through. Their access continues. Fix it in Stripe, and TGP tries again.";
const PF_W9_TWO = '2 renewals are waiting on your Stripe account. Fix it in Stripe, and TGP tries again.';

function holdNotices(w: HoldWorld) {
  return w.coachAlert.mock.calls
    .map((c) => (c as unknown[])[0] as { alertType?: string; message?: string; coachId?: string })
    .filter((a) => a.alertType === 'coach_account_hold');
}
function coachEmails(w: HoldWorld) {
  return w.email.mock.calls
    .map((c) => (c as unknown[])[0] as { to?: string; data?: Record<string, unknown>; idempotencyKey?: string })
    .filter((e) => e.to === 'coach@tgp.invalid');
}

describe('PF-7-BE: a renewal waiting on the coach Stripe account', () => {
  const prev = { v2: process.env['FEATURE_DUNNING_V2'], hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'] };

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    for (const [k, v] of [
      ['FEATURE_DUNNING_V2', prev.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', prev.hold],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('the cause comes from a fresh read, never the saved row alone (R1/R2)', () => {
    it('saved row ready but Stripe says restricted: the renewal waits and the mirror is corrected', async () => {
      const w = buildWorld({ saved: READY, stripeNow: RESTRICTED });
      await w.fail();
      expect(w.stripe.retrieveAccount).toHaveBeenCalledWith('acct_pf7_coach');
      expect(w.state()).toMatchObject({
        status: 'active',
        step_index: -1,
        last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
        locked_out_at: null,
      });
      expect(w.fake.find('connectAccount', { id: 'ca-1' })).toMatchObject({
        charges_enabled: false,
        disabled_reason: 'requirements.past_due',
      });
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
    });

    it('saved row restricted but Stripe says ready: the normal ten days, exactly as main', async () => {
      const w = buildWorld({ saved: RESTRICTED, stripeNow: READY });
      await w.fail();
      expect(w.state()?.step_index).toBe(0);
      expect(w.state()?.last_failure_reason).not.toBe(COACH_ACCOUNT_HOLD_REASON);
      expect((await w.v2.getClientStatus('client-1')).state).toBe('past_due');
      expect(w.clientPushes()).toBe(1);
      expect(holdNotices(w)).toHaveLength(0);
      expect(w.fake.find('connectAccount', { id: 'ca-1' })?.charges_enabled).toBe(true);
    });

    it('no fresh answer from Stripe (unsure): main ten days, never a guess', async () => {
      const w = buildWorld({ saved: RESTRICTED, stripeNow: { ...READY, unreachable: true } });
      await w.fail();
      expect(w.state()?.last_failure_reason).not.toBe(COACH_ACCOUNT_HOLD_REASON);
      expect((await w.v2.getClientStatus('client-1')).state).toBe('past_due');
      expect(w.clientPushes()).toBe(1);
      expect(holdNotices(w)).toHaveLength(0);
    });

    it('a card failure on a ready account is unchanged: Day 0 now, client told, no coach hold notice', async () => {
      const w = buildWorld();
      await w.fail();
      const status = await w.v2.getClientStatus('client-1');
      expect(status.state).toBe('past_due');
      expect(status.failed_at).toEqual(T0.toISOString());
      expect(w.clientPushes()).toBe(1);
      expect(holdNotices(w)).toHaveLength(0);
      expect(w.stripe.retryInvoiceOffSession).not.toHaveBeenCalled();
    });

    it('the prefetch path (outer webhook tx) reads the account before the tx and holds', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      const evt = fixture('invoice.payment_failed', { attempt_count: 1 });
      const pre = await w.handler.prefetchForOuterTx(evt);
      expect(pre.coachAccountReady).toBe(false);
      const calls = w.stripe.retrieveAccount.mock.calls.length;
      await w.handler.handle(evt, stub(w.prisma), pre);
      await flush();
      // No Stripe read inside the transaction.
      expect(w.stripe.retrieveAccount.mock.calls.length).toBe(calls);
      expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);
    });
  });

  describe('each of the five cycle steps is skipped and the client keeps access (R1)', () => {
    it('Day 0 push, Day 1 push+email, Day 3 pop-up, Day 7 coach notice and Day 10 lock never happen', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      for (const day of [0, 1, 3, 7, 10]) {
        jest.setSystemTime(at(day * DAY + 2 * HOUR));
        await w.v2.runSweep();
        await flush();
        expect(w.clientPushes()).toBe(0);
        expect(w.clientEmails()).toBe(0);
        expect(
          w.fake.rows('notification').filter(
            (n) => n.user_id === 'client-1' && n.kind === NotificationKind.DUNNING_BLOCKER,
          ),
        ).toHaveLength(0);
        // The only coach notice is PF-W8, never the Day-7 money notice.
        expect(w.coachAlert.mock.calls.length).toBe(holdNotices(w).length);
        expect(w.state()?.locked_out_at ?? null).toBeNull();
        expect(await w.entitled()).toBe('allowed');
        expect(await w.lockVerdict('/api/v1/scheduling/my-coaches')).toBe('allowed');
      }
      expect(w.fake.rows('dunningNoticeDelivery')).toHaveLength(0);
      expect(w.purchase()?.entitlement_active).toBe(true);
    });
  });

  describe('PF-W8: the coach is told at once, with the count, once per coach per day (R4)', () => {
    it('push and email the same day; a second waiting renewal that day sends nothing more; no client named', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      await flush();
      expect(holdNotices(w)).toEqual([
        expect.objectContaining({
          coachId: 'coach-1',
          money: true,
          message: coachAccountHoldNotice(1),
        }),
      ]);
      expect(coachAccountHoldNotice(1)).toBe(
        "Your Stripe account can't take payments right now, so 1 client's renewal did not go through. Their access continues. Fix it in Stripe, and TGP tries again.",
      );
      expect(coachEmails(w)).toHaveLength(1);
      expect(coachEmails(w)[0].data).toMatchObject({
        roman_body: coachAccountHoldNotice(1),
        coach_account_hold: true,
      });

      jest.setSystemTime(at(2 * HOUR));
      await w.fail('sub_pf7_second');
      await flush();
      expect(holdNotices(w)).toHaveLength(1);
      expect(coachEmails(w)).toHaveLength(1);

      // Next day in the coach's zone: one more, with the count now 2.
      jest.setSystemTime(at(DAY));
      await w.fail('sub_pf7_second', 2);
      await flush();
      expect(holdNotices(w)).toHaveLength(2);
      expect(holdNotices(w)[1].message).toBe(PF_W8_TWO);
      expect(coachEmails(w)).toHaveLength(2);
      for (const text of [...holdNotices(w).map((n) => n.message), ...coachEmails(w).map((e) => String(e.data?.roman_body))]) {
        expect(text).not.toMatch(/Avery|Rowan|client-1|client-3|\$|150/);
      }
    });

    it('the day is the coach-local day at both edges', async () => {
      // 23:50 and 00:10 Los Angeles time: two days, two notices.
      const w = buildWorld({ stripeNow: RESTRICTED });
      jest.setSystemTime(new Date('2026-10-06T06:50:00.000Z')); // Oct 5 23:50 PDT
      await w.fail();
      jest.setSystemTime(new Date('2026-10-06T07:10:00.000Z')); // Oct 6 00:10 PDT
      await w.fail('sub_pf7_second');
      await flush();
      expect(holdNotices(w)).toHaveLength(2);

      // 00:10 and 23:50 the same Los Angeles day (across UTC midnight): one.
      const w2 = buildWorld({ stripeNow: RESTRICTED });
      jest.setSystemTime(new Date('2026-10-06T07:10:00.000Z')); // Oct 6 00:10 PDT
      await w2.fail();
      jest.setSystemTime(new Date('2026-10-07T06:50:00.000Z')); // Oct 6 23:50 PDT
      await w2.fail('sub_pf7_second');
      await flush();
      expect(holdNotices(w2)).toHaveLength(1);
      expect(coachLocalDay(new Date('2026-10-07T06:50:00.000Z'), 'America/Los_Angeles')).toBe('2026-10-06');
      expect(coachLocalDay(new Date('2026-10-07T06:50:00.000Z'), 'Not/AZone')).toBe('2026-10-06');
    });
  });

  describe('retry once the account is fixed (R5)', () => {
    async function heldWorld() {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      return w;
    }

    it('still restricted: no payment try, and the account is read again no sooner than an hour', async () => {
      const w = await heldWorld();
      const reads = w.stripe.retrieveAccount.mock.calls.length;
      jest.setSystemTime(at(HOUR));
      await w.hold.runSweep();
      expect(w.stripe.retrieveAccount.mock.calls.length).toBe(reads + 1);
      expect(w.stripe.retryInvoiceOffSession).not.toHaveBeenCalled();
      jest.setSystemTime(at(HOUR + 30 * 60 * 1000));
      await w.hold.runSweep();
      expect(w.stripe.retrieveAccount.mock.calls.length).toBe(reads + 1);
      jest.setSystemTime(at(2 * HOUR + 10 * 1000)); // next hourly tick, jitter
      await w.hold.runSweep();
      expect(w.stripe.retrieveAccount.mock.calls.length).toBe(reads + 2);
    });

    it('fixed: pays the waiting renewal once with one key per invoice and hold; two sweeps at once pay once', async () => {
      const w = await heldWorld();
      w.account.value = { ...READY };
      jest.setSystemTime(at(HOUR));
      await Promise.all([w.hold.runSweep(), w.hold.runSweep()]);
      expect(w.stripe.retryInvoiceOffSession).toHaveBeenCalledTimes(1);
      const state = w.state()!;
      expect(w.stripe.retryInvoiceOffSession).toHaveBeenCalledWith({
        invoiceId: 'in_dv2_renewal_1',
        idempotencyKey: coachAccountHoldRetryKey('in_dv2_renewal_1', String(state.id), state.entered_at as Date),
      });
      await w.hold.runSweep();
      expect(w.stripe.retryInvoiceOffSession).toHaveBeenCalledTimes(1);
      // Paid: Stripe's invoice.paid closes the row as on main.
      await w.handler.handle(fixture('invoice.paid', { subscription: 'sub_dv2_client' }));
      await flush();
      expect(w.state()?.status).not.toBe('active');
      expect(w.clientPushes()).toBe(0);
      expect(holdNotices(w)).toHaveLength(1);
    });

    it('the card fails on the retry: the normal ten days start from that retry (client time zone at the day edge)', async () => {
      const w = await heldWorld();
      w.account.value = { ...READY };
      w.stripe.retryInvoiceOffSession.mockRejectedValueOnce(
        new StripeConnectApiError('Your card was declined.', 402, 'card_declined', 'card_error', 'generic_decline'),
      );
      // 23:30 in Los Angeles on Oct 9 is already Oct 10 in UTC.
      const retryAt = new Date('2026-10-10T06:30:00.000Z');
      jest.setSystemTime(retryAt);
      await w.hold.runSweep();
      await flush();
      expect(w.state()).toMatchObject({ step_index: 0, last_failure_reason: null });
      expect((w.state()?.entered_at as Date).getTime()).toBe(retryAt.getTime());
      const status = await w.v2.getClientStatus('client-1');
      expect(status.state).toBe('past_due');
      expect(status.failed_at).toBe(retryAt.toISOString());
      expect(status.lockout_at).toBe(new Date(retryAt.getTime() + 10 * DAY).toISOString());
      expect(formatLockoutDate(new Date(retryAt.getTime() + 10 * DAY), 'America/Los_Angeles')).toBe('Monday, October 19');
      expect(formatLockoutDate(new Date(retryAt.getTime() + 10 * DAY), 'Asia/Tokyo')).toBe('Tuesday, October 20');
      expect(w.clientPushes()).toBe(1);
      // Stripe's own invoice.payment_failed for that try claims nothing twice.
      await w.fail('sub_dv2_client', 2);
      expect(w.state()?.step_index).toBe(0);
      expect((w.state()?.entered_at as Date).getTime()).toBe(retryAt.getTime());
      expect(w.clientPushes()).toBe(1);
    });

    it('the retry is refused on the coach account again: stays waiting, next try is a new call', async () => {
      const w = await heldWorld();
      w.account.value = { ...READY };
      w.stripe.retryInvoiceOffSession.mockRejectedValueOnce(
        new StripeConnectApiError('account cannot take charges', 400, 'account_invalid', 'invalid_request_error'),
      );
      const firstHeld = (w.state()?.entered_at as Date).getTime();
      jest.setSystemTime(at(HOUR));
      await w.hold.runSweep();
      expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);
      expect((w.state()?.entered_at as Date).getTime()).toBeGreaterThan(firstHeld);
      jest.setSystemTime(at(2 * HOUR));
      await w.hold.runSweep();
      const keys = w.stripe.retryInvoiceOffSession.mock.calls.map((c) => (c as unknown[])[0] as { idempotencyKey: string });
      expect(keys).toHaveLength(2);
      expect(keys[0].idempotencyKey).not.toBe(keys[1].idempotencyKey);
      expect(w.clientPushes()).toBe(0);
    });

    it('a later Stripe retry that fails while the account is fixed starts the ten days then', async () => {
      const w = await heldWorld();
      w.account.value = { ...READY };
      jest.setSystemTime(at(3 * DAY));
      await w.fail('sub_dv2_client', 2);
      expect(w.state()).toMatchObject({ step_index: 0 });
      expect((w.state()?.entered_at as Date).getTime()).toBe(at(3 * DAY).getTime());
      expect(w.clientPushes()).toBe(1);
    });
  });

  describe('the switch FEATURE_COACH_ACCOUNT_HOLD (R6)', () => {
    it('is on unless exactly "false", and rides on dunning v2', () => {
      for (const v of [undefined, '', 'true', 'FALSE', '0', 'off']) {
        if (v === undefined) delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
        else process.env['FEATURE_COACH_ACCOUNT_HOLD'] = v;
        expect(isCoachAccountHoldEnabled()).toBe(true);
      }
      process.env['FEATURE_COACH_ACCOUNT_HOLD'] = 'false';
      expect(isCoachAccountHoldEnabled()).toBe(false);
      delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
      process.env['FEATURE_DUNNING_V2'] = 'false';
      expect(isCoachAccountHoldEnabled()).toBe(false);
    });

    it('off: a new failure gets the normal ten days; a waiting one starts them at the next sweep; on again holds', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);

      process.env['FEATURE_COACH_ACCOUNT_HOLD'] = 'false';
      await w.fail('sub_pf7_second');
      expect(w.state('purchase-3')?.step_index).toBe(0);
      const reads = w.stripe.retrieveAccount.mock.calls.length;
      jest.setSystemTime(at(HOUR));
      await w.hold.runSweep();
      await flush();
      expect(w.stripe.retrieveAccount.mock.calls.length).toBe(reads);
      expect(w.state()).toMatchObject({ step_index: 0, last_failure_reason: null });
      expect((w.state()?.entered_at as Date).getTime()).toBe(at(HOUR).getTime());
      expect(w.clientPushes()).toBe(1);
      expect(w.stripe.retryInvoiceOffSession).not.toHaveBeenCalled();

      delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
      jest.setSystemTime(at(2 * DAY));
      await w.fail('sub_pf7_second', 2);
      expect(w.state('purchase-3')).toMatchObject({
        step_index: -1,
        last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
      });
    });
  });

  describe('an open cycle found restricted moves to waiting (R3)', () => {
    it('Day 4 of a card cycle: the cycle stops, the pop-up goes, nothing more is sent', async () => {
      const w = buildWorld();
      await w.fail();
      jest.setSystemTime(at(3 * DAY + HOUR));
      await w.v2.runSweep();
      await flush();
      const pushes = w.clientPushes();
      w.account.value = { ...RESTRICTED };
      jest.setSystemTime(at(4 * DAY));
      await w.fail('sub_dv2_client', 3);
      expect(w.state()).toMatchObject({ step_index: -1, last_failure_reason: COACH_ACCOUNT_HOLD_REASON });
      expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
      expect(
        w.fake.rows('notification').filter(
          (n) => n.user_id === 'client-1' && n.kind === NotificationKind.DUNNING_BLOCKER && n.read_at === null,
        ),
      ).toHaveLength(0);
      for (const day of [7, 10, 12]) {
        jest.setSystemTime(at(day * DAY + HOUR));
        await w.v2.runSweep();
        await flush();
      }
      expect(w.clientPushes()).toBe(pushes);
      expect(w.state()?.locked_out_at ?? null).toBeNull();
      expect(await w.entitled()).toBe('allowed');
    });

    it('a Day-10 lock is lifted', async () => {
      const w = buildWorld();
      await w.fail();
      jest.setSystemTime(at(10 * DAY + HOUR));
      await w.v2.runSweep();
      await flush();
      expect(w.state()?.locked_out_at).not.toBeNull();
      expect(await w.lockVerdict('/api/v1/scheduling/my-coaches')).toBe('LOCKED_DUNNING');
      w.account.value = { ...RESTRICTED };
      jest.setSystemTime(at(11 * DAY));
      await w.fail('sub_dv2_client', 4);
      expect(w.state()?.locked_out_at).toBeNull();
      expect(w.purchase()?.entitlement_active).toBe(true);
      expect(await w.lockVerdict('/api/v1/scheduling/my-coaches')).toBe('allowed');
      expect(await w.entitled()).toBe('allowed');
    });

    it('a dispute-paused cycle is never moved', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      w.fake.seed('dunningState', {
        id: 'ds-dispute',
        purchase_id: 'purchase-1',
        status: 'active',
        step_index: 2,
        entered_at: at(-2 * DAY),
        locked_out_at: at(-DAY),
        last_failure_reason: 'charge_disputed',
        client_canceled_at: null,
        failure_count: 1,
      });
      await w.fail();
      expect(w.state()?.last_failure_reason).toBe('charge_disputed');
      expect(holdNotices(w)).toHaveLength(0);
    });
  });

  describe('brief and Money (R7)', () => {
    const solo = {
      brief_mode: 'solo',
      coach_first_name: 'Morgan',
      coach_name: 'Morgan Coach',
      date: '2026-10-05',
      clients_checked_in_today: 0,
      clients_total: 2,
      workouts_completed_today: 0,
      workouts_approved_today: 0,
      paid_today_count: 0,
      total_revenue_today_cents: 0,
      renewals_upcoming_7d: 0,
      dunning_in_progress: 0,
      weight_logs_flagged: 0,
      unread_client_messages: 0,
      clients_missing_checkin_2d: 0,
      new_clients_last_24h: 0,
    } as unknown as BriefContext;

    it('PF-W9 is in the brief while renewals wait, with the count; never otherwise', () => {
      expect(coachAccountWaitingLine(2)).toBe(PF_W9_TWO);
      expect(coachAccountWaitingLine(1)).toBe(
        '1 renewal is waiting on your Stripe account. Fix it in Stripe, and TGP tries again.',
      );
      const plain = buildFallbackNarrative(solo);
      expect(plain).not.toContain('waiting on your Stripe account');
      const withWait = buildFallbackNarrative({ ...solo, coach_account_waiting: 2 });
      expect(withWait).toContain(PF_W9_TWO);
      expect(withWait).not.toMatch(/failed|payment retr/i);
      const head = {
        brief_mode: 'head_coach',
        coach_first_name: 'Morgan',
        coach_name: 'Morgan Coach',
        date: '2026-10-05',
        team_size: 1,
        team_clients_total: 2,
        team_revenue_30d_cents: 0,
        total_revenue_today_cents: 0,
        paid_today_count: 0,
        mrr_projected_cents: 0,
        new_clients_last_24h: 0,
        dunning_in_progress: 0,
        dunning_amount_cents: 0,
        sub_coach_highlights: [],
        coach_account_waiting: 1,
      } as unknown as BriefContextHeadCoach;
      expect(buildFallbackNarrative(head)).toContain(coachAccountWaitingLine(1));
    });

    it('an AI narrative gets PF-W9 after the greeting and stays within the cap', () => {
      const long = ['Good morning, Morgan.', ...Array.from({ length: 8 }, (_, i) => `Sentence ${i} ${'x'.repeat(60)}.`)].join(' ');
      const out = withCoachAccountWaiting(long, { coach_account_waiting: 2 });
      expect(out.startsWith(`Good morning, Morgan. ${PF_W9_TWO}`)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
      expect(withCoachAccountWaiting(long, {})).toBe(long);
    });

    it('Money: a waiting renewal is not a failed-payment to-do', async () => {
      const row = (id: string, reason: string) => ({
        id,
        amount_cents: 15000,
        currency: 'usd',
        updated_at: new Date('2026-10-05T00:00:00Z'),
        last_error: null,
        client: { id: `c-${id}`, name: 'Sam Lee' },
        package: { name: 'Monthly coaching' },
        dunning: {
          status: 'active',
          failure_count: 1,
          step_index: reason === COACH_ACCOUNT_HOLD_REASON ? -1 : 0,
          next_attempt_at: null,
          locked_out_at: null,
          last_failed_amount_cents: 15000,
          last_failure_at: new Date('2026-10-05T00:00:00Z'),
          last_failure_reason: reason,
          attempts: [],
        },
      });
      const prisma = {
        clientPurchase: { findMany: jest.fn(async () => [row('held', COACH_ACCOUNT_HOLD_REASON), row('card', 'card_declined')]) },
        chargeDispute: { findMany: jest.fn(async () => []) },
        connectAccount: { findUnique: jest.fn(async () => null) },
        user: { findMany: jest.fn(async () => []) },
      };
      const svc: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
      const out = await svc.getAttention('coach-1');
      const ids = out.items.filter((i) => i.kind === 'failed_payment').map((i) => i.failed_payment?.purchase_id);
      expect(ids).toEqual(['card']);
    });
  });
});
