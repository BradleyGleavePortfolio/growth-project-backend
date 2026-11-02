import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { PLAN_COACH, planView } from '../src/checkout/subscription-plan';
import {
  COACH_ACCOUNT_HOLD_REASON,
  coachAccountHoldRetryKey,
} from '../src/checkout/dunning-v2/coach-account-hold';
import {
  DAY,
  HOUR,
  READY,
  RESTRICTED,
  T0,
  at,
  buildWorld,
  fixture,
  flush,
  stub,
  type HoldWorld,
} from './support/pf7-hold-world';

/**
 * FR-1195 (b#1195 fix round 1): the builder's own red-then-green tests for
 * LO-1195 B1 (both client plan reads), LS-1195 B1 (each notice channel is
 * durable) and LS-1195 B2 (every held invoice, each paid once).
 */
describe('FR-1195: PF-7-BE fix round 1', () => {
  const saved = {
    v2: process.env['FEATURE_DUNNING_V2'],
    hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'],
  };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['FEATURE_DUNNING_V2', saved.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', saved.hold],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function clientReads(w: HoldWorld) {
    const checkout = new CheckoutService(w.prisma, stub({}), stub({}), stub({}), stub({}), stub({}));
    const { items } = await checkout.listForClient('client-1');
    const listed = items.find((p) => p.id === 'purchase-1');
    const row = await w.prisma.clientPurchase.findFirst({
      where: { id: 'purchase-1', client_user_id: 'client-1' },
      include: PLAN_COACH,
    });
    return { listed, plan: planView(row!, null) };
  }

  describe('LO-1195 B1: the held client plan on both reads', () => {
    it('a held renewal reads as active with no payment error on the purchases list and the plan view', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);
      // The stored row (what the coach's views read) keeps Stripe's status.
      expect(w.purchase()?.status).toBe('past_due');
      const { listed, plan } = await clientReads(w);
      expect(listed).toMatchObject({ status: 'active', last_error: null, entitlement_active: true });
      expect(listed).not.toHaveProperty('dunning');
      expect(plan).toMatchObject({ state: 'active', status: 'active', last_payment_error: null });
    });

    it('a card failure on a ready account still reads past_due on both reads', async () => {
      const w = buildWorld();
      await w.fail();
      expect(w.state()?.last_failure_reason).not.toBe(COACH_ACCOUNT_HOLD_REASON);
      const { listed, plan } = await clientReads(w);
      expect(listed?.status).toBe('past_due');
      expect(plan).toMatchObject({ state: 'past_due', status: 'past_due' });
      expect(plan.last_payment_error).not.toBeNull();
    });
  });

  describe('LS-1195 B1: each notice channel is durable', () => {
    it('push fails and email succeeds: only the push is sent again, once, with the same words', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      const emit = jest.fn(async (_p: unknown, _o?: { inapp?: boolean; push?: boolean }) => ({
        inapp: 'sent',
        push: 'sent',
      }));
      emit.mockResolvedValueOnce({ inapp: 'sent', push: 'failed' });
      Reflect.set(w.hold, 'coachAlert', { emit });
      await w.fail();
      await flush();
      expect(emit).toHaveBeenCalledTimes(1);
      expect(w.email).toHaveBeenCalledTimes(1);

      jest.setSystemTime(at(HOUR));
      await w.hold.runSweep();
      await flush();
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1]?.[1]).toEqual({ inapp: false, push: true });
      expect((emit.mock.calls[1]?.[0] as { message: string }).message).toBe(
        (emit.mock.calls[0]?.[0] as { message: string }).message,
      );
      expect(w.email).toHaveBeenCalledTimes(1);

      // Delivered now: later sweeps send nothing more.
      jest.setSystemTime(at(2 * HOUR));
      await w.hold.runSweep();
      jest.setSystemTime(at(3 * HOUR));
      await w.hold.runSweep();
      await flush();
      expect(emit).toHaveBeenCalledTimes(2);
      expect(w.email).toHaveBeenCalledTimes(1);
    });

    it('a failed email is sent again with its own key until it is delivered, then never again', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      w.email.mockResolvedValueOnce({ status: 'failed' }).mockResolvedValueOnce({ status: 'failed' });
      await w.fail();
      await flush();
      for (const h of [1, 2, 3]) {
        jest.setSystemTime(at(h * HOUR));
        await w.hold.runSweep();
        await flush();
      }
      const keys = w.email.mock.calls.map((c) => ((c as unknown[])[0] as { idempotencyKey: string }).idempotencyKey);
      expect(keys).toHaveLength(3);
      expect(keys[1]).toBe(`${keys[0]}:r1`);
      expect(keys[2]).toBe(`${keys[0]}:r2`);
      // The in-app row and push went out once, with the first send.
      expect(w.coachAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('LS-1195 B2: every held invoice, each paid once', () => {
    it('two held invoices on one purchase, paid over two sweeps and two webhooks: each charged once; the hold ends when none is left unpaid', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.prisma.coachPackage.update({ where: { id: 'pkg-1' }, data: { interval: 'week' } });
      await w.fail();
      const older = { id: 'in_dv2_renewal_1', status: 'open' };
      const newer = { id: 'in_dv2_renewal_1-next-period', status: 'open' };
      jest.setSystemTime(at(7 * DAY));
      await w.handler.handle(fixture('invoice.payment_failed', { id: newer.id }));
      await flush();
      expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);

      // Stripe's open list, newest first; a paid invoice leaves it.
      const open = new Map([
        [newer.id, newer],
        [older.id, older],
      ]);
      w.stripe.listOpenInvoices.mockImplementation(async () => [...open.values()]);
      let newerDown = true;
      w.stripe.retryInvoiceOffSession.mockImplementation(async (args: { invoiceId: string }) => {
        if (args.invoiceId === newer.id && newerDown) {
          newerDown = false;
          throw new StripeConnectApiError('Stripe unavailable', 503, null, 'api_error');
        }
        open.delete(args.invoiceId);
        return { id: args.invoiceId, status: 'paid' };
      });
      w.account.value = { ...READY };

      // Sweep 1 (two at once): the older is paid; the newer's outcome is unknown.
      jest.setSystemTime(at(7 * DAY + HOUR));
      await Promise.all([w.hold.runSweep(), w.hold.runSweep()]);
      await w.handler.handle(fixture('invoice.paid', { id: older.id }));
      await flush();
      // The newer renewal is still unpaid: the hold stays.
      expect(w.state()).toMatchObject({ status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON });

      // Sweep 2 pays the newer with the same key (an unknown outcome keeps it).
      jest.setSystemTime(at(7 * DAY + 2 * HOUR));
      await w.hold.runSweep();
      await w.handler.handle(fixture('invoice.paid', { id: newer.id }));
      await flush();
      expect(w.state()?.status).not.toBe('active');

      jest.setSystemTime(at(7 * DAY + 3 * HOUR));
      await w.hold.runSweep();

      const calls = w.stripe.retryInvoiceOffSession.mock.calls.map(
        ([args]) => args as { invoiceId: string; idempotencyKey: string },
      );
      const forOlder = calls.filter((c) => c.invoiceId === older.id);
      const forNewer = calls.filter((c) => c.invoiceId === newer.id);
      expect(forOlder).toHaveLength(1);
      expect(forNewer).toHaveLength(2);
      expect(new Set(forNewer.map((c) => c.idempotencyKey)).size).toBe(1);
      expect(forOlder[0]!.idempotencyKey).not.toBe(forNewer[0]!.idempotencyKey);
      const state = w.state()!;
      expect(forNewer[0]!.idempotencyKey).toBe(
        coachAccountHoldRetryKey(newer.id, String(state.id), state.entered_at as Date),
      );
    });

    it('invoice.paid on a held renewal with no fresh open-invoice answer fails the delivery and keeps the hold', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      w.stripe.listOpenInvoices.mockRejectedValue(new Error('stripe unreachable'));
      await expect(
        w.handler.handle(fixture('invoice.paid', { id: 'in_dv2_renewal_1' })),
      ).rejects.toThrow('COACH_HOLD_CHECK_FAILED');
      expect(w.state()).toMatchObject({ status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON });
      // Stripe redelivers once it answers again: the only held invoice is paid, so the hold ends.
      w.stripe.listOpenInvoices.mockResolvedValue([]);
      await w.handler.handle(fixture('invoice.paid', { id: 'in_dv2_renewal_1' }));
      await flush();
      expect(w.state()?.status).not.toBe('active');
    });

    it('the prefetch path reads the open invoices before the transaction and keeps the hold while one is unpaid', async () => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      w.stripe.listOpenInvoices.mockResolvedValue([
        { id: 'in_dv2_renewal_1-next-period', status: 'open' },
        { id: 'in_dv2_renewal_1', status: 'open' },
      ]);
      const evt = fixture('invoice.paid', { id: 'in_dv2_renewal_1' });
      const pre = await w.handler.prefetchForOuterTx(evt);
      expect((pre as { heldInvoicesUnpaid?: unknown }).heldInvoicesUnpaid).toEqual(['in_dv2_renewal_1-next-period']);
      const reads = w.stripe.listOpenInvoices.mock.calls.length;
      await w.handler.handle(evt, stub(w.prisma), pre);
      await flush();
      expect(w.stripe.listOpenInvoices.mock.calls.length).toBe(reads);
      expect(w.state()).toMatchObject({ status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON });
    });
  });
});
