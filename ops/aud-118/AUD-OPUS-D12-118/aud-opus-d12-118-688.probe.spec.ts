/**
 * AUD-OPUS-D12-118 probes on backend #688 @ b17f514c (audit only, never merge).
 *
 * Part 1 replays this lens's AUD-OPUS-D12-116 probe (B-688-1, lost dispute
 * during a payment cycle): at 6627044c the two "probe" cases failed and the
 * three controls passed. All five are expected to PASS at this head.
 *
 * Part 2 (new): the Day-10 lock is fenced on `entered_at` only. v1
 * `recordFailure` reopens a resolved row with step_index -1 and KEEPS the old
 * entered_at (v2 stamps a new one only when its Day-0 claim runs). A sweep
 * worker that read the row before it was paid and reopened therefore still
 * matches the CAS and locks the new cycle on its Day 0. The "probe" cases are
 * expected to FAIL at this head; the control is expected to PASS.
 */
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';
import { DUNNING_V2_DAY_MS } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { DunningService } from '../src/checkout/dunning.service';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const T0 = new Date('2026-10-05T16:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DUNNING_V2_DAY_MS);
const DECLINE = 'insufficient_funds';

function telemetry() {
  return {
    lockoutEntered: jest.fn(),
    lockoutExited: jest.fn(),
    recovered: jest.fn(),
    reversalDetected: jest.fn(),
    attemptFailed: jest.fn(),
    notifySent: jest.fn(),
    blockerShown: jest.fn(),
    coachNotified: jest.fn(),
  };
}

function setup(reason: string = DECLINE, locked = true) {
  const fake = new FakePrisma();
  const dispatcher = {
    dispatchStep: jest.fn(async () => ({})),
    dispatchStepDetailed: jest.fn(async () => ({ decision: {}, results: {} })),
  };
  const stripe = { retrieveSubscription: jest.fn(async () => ({ status: 'past_due' })) };
  const svc = new DunningV2Service(fake.client(), stub(telemetry()), stub(dispatcher), stub(stripe));
  fake.seed('user', { id: 'coach-1', name: 'Morgan Coach', email: 'coach@tgp.invalid' });
  fake.seed('user', { id: 'client-1', name: 'Avery Client', email: 'client@tgp.invalid' });
  fake.seed('clientPurchase', {
    id: 'p1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    status: 'past_due',
    entitlement_active: !locked,
    billing_type: 'recurring',
    amount_cents: 15000,
    currency: 'usd',
    stripe_subscription_id: 'sub_1',
  });
  fake.seed('connectTransfer', { id: 'tr_old', purchase_id: 'p1', source_stripe_charge_id: 'ch_old' });
  fake.seed('dunningState', {
    id: 'ds1',
    purchase_id: 'p1',
    status: 'active',
    step_index: 3,
    entered_at: T0,
    locked_out_at: locked ? at(10) : null,
    recovered_at: null,
    resolved_at: null,
    client_canceled_at: null,
    reversal_count: 0,
    failure_count: 4,
    last_failure_reason: reason,
    last_failed_amount_cents: 15000,
  });
  return { fake, svc, stripe };
}

describe('AUD-OPUS-D12-118 probe #688', () => {
  const prev = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prev;
  });

  describe('part 1: replay of AUD-OPUS-D12-116 (B-688-1)', () => {
    async function disputeDuringPaymentCycle(svc: DunningV2Service): Promise<void> {
      const r = await svc.handleLateReversal({
        purchaseId: 'p1',
        reversedChargeAt: at(2),
        disputeId: 'dp_9',
        chargeId: 'ch_old',
        now: at(2),
      });
      expect(r).toMatchObject({ opened: false, reason: 'cycle_already_active' });
    }

    it('control: dispute still open -> the renewal payment does not settle it', async () => {
      const { svc, fake } = setup();
      await disputeDuringPaymentCycle(svc);
      expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
      expect(await svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(at(10));
    });

    it('control: dispute cycle (marker) lost -> still a dispute cycle, lock kept', async () => {
      const { svc, fake } = setup('charge_disputed');
      fake.seed('dunningDisputeObligation', {
        stripe_dispute_id: 'dp_9',
        purchase_id: 'p1',
        stripe_charge_id: 'ch_old',
        status: 'open',
        closed_at: null,
      });
      const closed = await svc.onDisputeClosed({
        chargeId: 'ch_old',
        disputeId: 'dp_9',
        status: 'lost',
        now: at(20),
      });
      expect(closed.reason).toBe('not_won');
      expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
      expect(await svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
    });

    it('control: dispute won during the payment cycle -> the payment cycle resolves normally', async () => {
      const { svc } = setup();
      await disputeDuringPaymentCycle(svc);
      await svc.onDisputeClosed({ chargeId: 'ch_old', disputeId: 'dp_9', status: 'won', now: at(20) });
      expect(await svc.isDisputeCycleOpen('p1')).toBe(false);
    });

    it('replayed probe: dispute LOST before the renewal is paid -> isDisputeCycleOpen stays true', async () => {
      const { svc, fake } = setup();
      await disputeDuringPaymentCycle(svc);
      const closed = await svc.onDisputeClosed({
        chargeId: 'ch_old',
        disputeId: 'dp_9',
        status: 'lost',
        now: at(20),
      });
      expect(closed.reason).toBe('not_won');
      expect(fake.find('dunningDisputeObligation', { stripe_dispute_id: 'dp_9' })?.status).toBe('lost');
      expect(await svc.isDisputeCycleOpen('p1')).toBe(true);
    });

    it('replayed probe: dispute LOST before the renewal is paid -> applyImmediateClear keeps the lock', async () => {
      const { svc, fake } = setup();
      await disputeDuringPaymentCycle(svc);
      await svc.onDisputeClosed({ chargeId: 'ch_old', disputeId: 'dp_9', status: 'lost', now: at(20) });
      expect(await svc.applyImmediateClear('p1', 'retry')).toEqual({ liftedLockout: false });
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toEqual(at(10));
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    });

    it('control (new head): a lost dispute keeps a card-update clear refused too', async () => {
      const { svc } = setup();
      await disputeDuringPaymentCycle(svc);
      await svc.onDisputeClosed({ chargeId: 'ch_old', disputeId: 'dp_9', status: 'lost', now: at(20) });
      expect(await svc.applyImmediateClear('p1', 'card_update')).toEqual({ liftedLockout: false });
    });
  });

  describe('part 3 (control for the #687 copy finding): a card update never ends a dispute cycle', () => {
    it('control: dispute cycle, card update -> no clear, cycle stays active and locked', async () => {
      const { svc, fake } = setup('charge_disputed');
      fake.seed('dunningDisputeObligation', {
        stripe_dispute_id: 'dp_9',
        purchase_id: 'p1',
        stripe_charge_id: 'ch_old',
        status: 'open',
        closed_at: null,
      });
      expect(await svc.applyImmediateClear('p1', 'card_update')).toEqual({ liftedLockout: false });
      expect(fake.find('dunningState', { id: 'ds1' })).toMatchObject({
        status: 'active',
        locked_out_at: at(10),
      });
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    });
  });

  describe('part 4: no client notice renders an unresolved {token}', () => {
    /**
     * Checkout saves the first card ON the subscription
     * (save_default_payment_method=on_subscription), so ConnectCustomer.
     * default_card_last4 stays null until a card update. buildDispatchContext
     * passes `cardLast4: undefined` and applyTokens leaves "{cardLast4}" in
     * the Day-1 email (both variants carry the token).
     */
    async function stepEmails(last4: string | null, stepIndex: number) {
      const { fake } = setup(DECLINE, false);
      if (last4 !== null) {
        fake.seed('connectCustomer', { id: 'cc1', client_user_id: 'client-1', default_card_last4: last4 });
      }
      const sent: Array<{ to: string; data: Record<string, unknown> }> = [];
      const email = {
        send: jest.fn(async (m: { to: string; data: Record<string, unknown> }) => {
          sent.push(m);
          return { status: 'sent' };
        }),
      };
      const notifications = {
        pushToUser: jest.fn(async () => ({ delivered: true, code: 'delivered' })),
        createNotification: jest.fn(async () => ({ id: 'n1' })),
        pushToCoach: jest.fn(async () => true),
      };
      const t = telemetry();
      const dispatcher = new DunningV2Dispatcher(
        new DunningEscalationClassifier(),
        new DunningV2Renderer(),
        stub(t),
        stub(notifications),
        stub(email),
      );
      const svc = new DunningV2Service(fake.client(), stub(t), dispatcher, undefined);
      await svc.dispatchClaim({
        dunningStateId: 'ds1',
        purchaseId: 'p1',
        stepIndex,
        isLateReversalCycle: false,
      });
      const body = (to: string) => String(sent.find((m) => m.to === to)?.data.roman_body ?? '');
      return { client: body('client@tgp.invalid'), coach: body('coach@tgp.invalid') };
    }
    const dayOneEmail = async (last4: string | null) => (await stepEmails(last4, 1)).client;

    it('control: with a stored card the Day-1 email names it and has no braces', async () => {
      const body = await dayOneEmail('4242');
      expect(body).toContain('4242');
      expect(body).not.toMatch(/\{\w+\}/);
    });

    it('probe: with no stored card (checkout saves it on the subscription) the Day-1 email has no {cardLast4}', async () => {
      const body = await dayOneEmail(null);
      expect(body).not.toMatch(/\{\w+\}/);
    });

    it('probe: the Day-7 coach email has no unresolved token ({reason} is never supplied)', async () => {
      const { coach } = await stepEmails('4242', 3);
      expect(coach).toContain('Retry history');
      expect(coach).not.toMatch(/\{\w+\}/);
    });
  });

  describe('part 2: stale Day-10 worker vs a v1 reopen before the v2 Day-0 claim', () => {
    /**
     * Sweep reads the Day-11 row (unlocked, step 3). During its Stripe await
     * the open invoice is paid (v1 recordResolution) and a new renewal fails
     * (v1 recordFailure reopens: status active, step_index -1, entered_at kept).
     * The v2 Day-0 claim has not run yet (it runs after v1 in the webhook, in
     * its own transaction; a failed claim leaves this shape until the next
     * failure).
     */
    async function staleSweepAcrossV1Reopen(withV2Claim = false) {
      const { fake, svc, stripe } = setup(DECLINE, false);
      const now = at(11);
      const v1 = new DunningService(fake.client() as never, stub({}));
      let shape: Record<string, unknown> | null = null;
      let mockError: unknown = null;
      stripe.retrieveSubscription.mockImplementation(async () => {
        try {
        await v1.recordResolution('p1');
        fake.find('clientPurchase', { id: 'p1' })!.status = 'active';
        // A new renewal fails a moment later: Stripe sets past_due again.
        fake.find('clientPurchase', { id: 'p1' })!.status = 'past_due';
        const purchase = stub(fake.find('clientPurchase', { id: 'p1' }));
        await v1.recordFailure({
          purchase,
          stripe_invoice_id: 'in_new',
          amount_due_cents: 15000,
          attempt_number: 1,
          reason: DECLINE,
        });
        const reopened = fake.find('dunningState', { id: 'ds1' })!;
        if (withV2Claim) {
          // The builder's ABA case: v2 claims Day 0 (new entered_at) in time.
          await svc.recordPaymentFailed('p1', now);
          return { status: 'past_due' };
        }
        shape = {
          status: reopened.status,
          step_index: reopened.step_index,
          entered_at: reopened.entered_at,
          locked_out_at: reopened.locked_out_at,
        };
        } catch (err) {
          // Asserted below: tryLock swallows a throw from this await.
          mockError = err;
        }
        return { status: 'past_due' };
      });
      const out = await svc.runSweep(now);
      expect(mockError).toBeNull();
      if (withV2Claim) return { fake, svc, out, now };
      // The interleaving really happened: v1 reopened the row, kept entered_at.
      expect(shape).toEqual({ status: 'active', step_index: -1, entered_at: T0, locked_out_at: null });
      return { fake, svc, out, now };
    }

    it('control: an ordinary Day-10 cycle (no reopen) locks', async () => {
      const { fake, svc } = setup(DECLINE, false);
      expect((await svc.runSweep(at(11))).locked).toBe(1);
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(false);
    });

    it('control: v1 reopen AND the v2 Day-0 claim during the await -> not locked (fence works)', async () => {
      const { fake, out } = await staleSweepAcrossV1Reopen(true);
      expect(out.locked).toBe(0);
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
      expect(fake.find('dunningState', { id: 'ds1' })?.step_index).toBe(0);
    });

    it('probe: the reopened cycle is not locked on its Day 0', async () => {
      const { fake, out } = await staleSweepAcrossV1Reopen();
      expect(out.locked).toBe(0);
      expect(fake.find('dunningState', { id: 'ds1' })?.locked_out_at).toBeNull();
      expect(fake.find('clientPurchase', { id: 'p1' })?.entitlement_active).toBe(true);
    });

    it('probe: the reopened cycle still gets its v2 Day-0 claim afterwards', async () => {
      const { svc, now } = await staleSweepAcrossV1Reopen();
      const claim = await svc.recordPaymentFailed('p1', now);
      expect(claim?.stepIndex).toBe(0);
    });
  });
});
