// B-TRIALS (OR-113-2) — trial-ending notice (timing, idempotency, copy,
// channels) and the webhook trial lifecycle (card up front, one trial per
// coach, release on abandon, post-commit hooks). All of these failed before:
// customer.subscription.trial_will_end was unhandled (claimed: false), a
// trialing subscription was entitled with no card, and nothing recorded a
// client's trial.
import { BillingService } from '../src/billing/billing.service';
import { EmailService } from '../src/email/email.service';
import { EmailTemplateKey } from '../src/email/email.types';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import {
  TrialNoticeService,
  upcomingChargeCents,
} from '../src/packages/trials/trial-notice.service';
import {
  trialEndingCopy,
  formatTrialAmount,
  formatTrialDate,
} from '../src/packages/trials/trial-copy';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { purchaseTrialView } from '../src/packages/trials/trial-view';
import { makeTrialNoticeTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
const TRIAL_END = new Date('2026-10-12T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

function purchaseRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pur-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'trialing',
    entitlement_active: true,
    stripe_subscription_id: 'sub_1',
    stripe_customer_id: 'cus_1',
    cancel_at_period_end: false,
    trial_days: 7,
    trial_ends_at: TRIAL_END,
    created_at: new Date('2026-10-05T17:00:00Z'),
    ...over,
  };
}

function trialSub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'trialing',
    trial_start: epoch(new Date('2026-10-05T17:00:00Z')),
    trial_end: epoch(TRIAL_END),
    current_period_end: epoch(TRIAL_END),
    cancel_at_period_end: false,
    default_payment_method: 'pm_card_visa',
    items: { data: [{ quantity: 1, price: { unit_amount: 4900, currency: 'usd' } }] },
    ...over,
  };
}

function world(opts: { tz?: string | null; email?: string | null; pushCode?: string } = {}) {
  const notices = makeTrialNoticeTable();
  const usage = makeTrialUsageTable();
  const purchases = [purchaseRow()];
  const prisma = {
    packageTrialNotice: notices,
    packageTrialUsage: usage,
    // B-TRIALS-3 (B-656-5) — a completed read: this client has no customer
    // default card (an unreadable one is "unknown" and defers delivery).
    connectCustomer: { findUnique: jest.fn(async () => null) },
    notificationPreferences: {
      findUnique: jest.fn(async () =>
        // B-TR2-117 — the client's own (stamped) zone: the date reads bare (C-672-7).
        opts.tz === null
          ? null
          : { timezone: opts.tz ?? 'America/Los_Angeles', timezone_updated_at: NOW },
      ),
    },
    coachPackage: {
      findUnique: jest.fn(async () => ({ id: 'pkg-1', duration_periods: null, trial_days: 7 })),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => {
        const row = purchases.find(
          (p) =>
            (where.id && p.id === where.id) ||
            (where.stripe_subscription_id &&
              p.stripe_subscription_id === where.stripe_subscription_id),
        );
        if (!row) return null;
        return {
          ...row,
          package: { name: 'GP Monthly', interval: 'month', interval_count: 1 },
          coach: { name: 'Bradley Coach' },
          client: {
            email: opts.email === undefined ? 'client@example.test' : opts.email,
            name: 'Ana Client',
          },
        };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = purchases.find((p) => p.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> => cb(prisma)),
  };
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>, _tx?: unknown) => ({
      id: 'n-1',
      ...input,
      _tx,
    })),
    // B-TRIALS-3 (B-656-4) — delivery re-reads the client's preferences.
    getPreferences: jest.fn(async () => ({ muted: false })),
    pushToUser: jest.fn(async () =>
      opts.pushCode
        ? { delivered: false, code: opts.pushCode }
        : { delivered: true, code: 'delivered' },
    ),
  };
  const email = {
    send: jest.fn(async (input: { idempotencyKey: string }) => ({
      status: 'sent',
      providerMessageId: 'm',
      idempotencyKey: input.idempotencyKey,
    })),
  };
  const noticeSvc = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const usageSvc = new TrialUsageService(
    stub<ConstructorParameters<typeof TrialUsageService>[0]>(prisma),
  );
  const stripe = stub<StripeConnectApiService>({
    cancelSubscription: jest.fn(async () => ({ id: 'sub_x', status: 'canceled' })),
    retrieveSubscription: jest.fn(),
  });
  const handler = new CheckoutWebhookHandlerService(
    stub<ConstructorParameters<typeof CheckoutWebhookHandlerService>[0]>(prisma),
    stripe,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    usageSvc,
    noticeSvc,
  );
  const tx = stub<Parameters<CheckoutWebhookHandlerService['handle']>[1]>(prisma);
  return {
    prisma,
    notices,
    usage,
    purchases,
    notifications,
    email,
    noticeSvc,
    usageSvc,
    handler,
    stripe,
    tx,
  };
}

const event = (type: string, object: Record<string, unknown>, id = 'evt_1') => ({
  id,
  type,
  data: { object },
});

describe('B-TRIALS — trial-ending copy', () => {
  it('matches the owner spec word for word', () => {
    const copy = trialEndingCopy({
      trialEndsAt: TRIAL_END,
      amountCents: 4900,
      currency: 'usd',
      timeZone: 'America/Los_Angeles',
      cancelAtPeriodEnd: false,
    });
    expect(copy.body).toBe(
      'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.',
    );
  });

  it('after a cancel it says nothing will be charged', () => {
    const copy = trialEndingCopy({
      trialEndsAt: TRIAL_END,
      amountCents: 4900,
      currency: 'usd',
      cancelAtPeriodEnd: true,
    });
    expect(copy.body).toBe(
      'Your free trial ends on Oct 12. Your card will not be charged, and your plan ends then.',
    );
  });

  it('formats cents, other currencies, and the date in the client time zone', () => {
    expect(formatTrialAmount(4999, 'usd')).toBe('$49.99');
    expect(formatTrialAmount(4900, 'gbp')).toBe('£49');
    // 2026-10-12T03:00Z is still Oct 11 in Los Angeles.
    expect(formatTrialDate(new Date('2026-10-12T03:00:00Z'), 'America/Los_Angeles')).toBe('Oct 11');
    expect(formatTrialDate(new Date('2026-10-12T03:00:00Z'), 'Not/AZone')).toBe('Oct 12');
  });

  it('never uses emojis, exclamation marks or first person', () => {
    for (const cancel of [false, true]) {
      const { title, body } = trialEndingCopy({
        trialEndsAt: TRIAL_END,
        amountCents: 4900,
        currency: 'usd',
        cancelAtPeriodEnd: cancel,
      });
      for (const text of [title, body]) {
        expect(text).not.toMatch(/!/);
        expect(text).not.toMatch(/\b(we|us|our)\b/i);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it('the email template renders the date and amount, with a plain subject', () => {
    const prev = process.env.EMAIL_TRANSPORT;
    delete process.env.EMAIL_TRANSPORT;
    const svc = new EmailService(
      stub<ConstructorParameters<typeof EmailService>[0]>({ emailSendLog: {} }),
      stub<ConstructorParameters<typeof EmailService>[1]>({ get: () => undefined }),
    );
    if (prev !== undefined) process.env.EMAIL_TRANSPORT = prev;
    const { html, subject } = svc.render(EmailTemplateKey.TRIAL_ENDING, {
      recipient_name: 'Ana',
      plan_name: 'GP Monthly',
      coach_name: 'Bradley Coach',
      trial_end_date: 'Oct 12',
      amount_display: '$49',
      cadence: 'monthly',
      will_charge: true,
    });
    expect(subject).toBe('Your free trial ends on Oct 12');
    const flat = html.replace(/\s+/g, ' ');
    expect(flat).toContain('Your card will be charged <strong>$49</strong> then');
    expect(flat).toContain('cancel anytime before Oct 12');
    // Text between tags only (split, not a tag-stripping replace: this is a
    // copy assertion, not sanitization). No exclamation mark in any copy.
    const textNodes = html.split(/<[^>]*>/).join(' ');
    expect(textNodes).not.toMatch(/!/);
  });
});

describe('B-TRIALS — recordTrialWillEnd timing and idempotency', () => {
  it('records once per (purchase, trial end): a redelivery or a second event is a no-op', async () => {
    const w = world();
    const purchase =
      stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(purchaseRow());
    const tx = stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[0]>(w.prisma);
    const first = await w.noticeSvc.recordTrialWillEnd(tx, {
      purchase,
      sub: trialSub(),
      eventId: 'evt_1',
      now: NOW,
    });
    const again = await w.noticeSvc.recordTrialWillEnd(tx, {
      purchase,
      sub: trialSub(),
      eventId: 'evt_2',
      now: NOW,
    });
    expect(first).toEqual(expect.any(String));
    expect(again).toBeNull();
    expect(w.notices.rows).toHaveLength(1);
    expect(w.notifications.createNotification).toHaveBeenCalledTimes(1);
    const [input, passedTx] = w.notifications.createNotification.mock.calls[0];
    expect(passedTx).toBe(tx); // in-app row rides the webhook transaction
    expect(input).toMatchObject({
      user_id: 'client-1',
      kind: 'trial_ending',
      channel: 'inapp',
      body: 'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.',
    });
  });

  it('RACE: two concurrent deliveries of the event write one notice', async () => {
    const w = world();
    const purchase =
      stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(purchaseRow());
    const tx = stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[0]>(w.prisma);
    const ids = await Promise.all([
      w.noticeSvc.recordTrialWillEnd(tx, { purchase, sub: trialSub(), eventId: 'evt_1', now: NOW }),
      w.noticeSvc.recordTrialWillEnd(tx, {
        purchase,
        sub: trialSub(),
        eventId: 'evt_1b',
        now: NOW,
      }),
    ]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect(w.notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('an extended trial (new trial end) gets its own notice', async () => {
    const w = world();
    const purchase =
      stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(purchaseRow());
    const tx = stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[0]>(w.prisma);
    await w.noticeSvc.recordTrialWillEnd(tx, {
      purchase,
      sub: trialSub(),
      eventId: 'evt_1',
      now: NOW,
    });
    const later = epoch(new Date('2026-10-19T17:00:00Z'));
    expect(
      await w.noticeSvc.recordTrialWillEnd(tx, {
        purchase,
        sub: trialSub({ trial_end: later }),
        eventId: 'evt_3',
        now: NOW,
      }),
    ).toEqual(expect.any(String));
    expect(w.notices.rows).toHaveLength(2);
  });

  it('skips a trial that already ended (trial_end=now), a non-trialing sub, and a trial that has not started (no card saved yet)', async () => {
    const w = world();
    const purchase =
      stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(purchaseRow());
    const notStarted = stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(
      purchaseRow({ entitlement_active: false }),
    );
    const tx = stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[0]>(w.prisma);
    const cases = [
      { purchase, sub: trialSub({ trial_end: epoch(NOW) }) },
      { purchase, sub: trialSub({ status: 'active' }) },
      // B-TRIALS-3: a started trial whose card was removed IS noticed (with
      // the no-card copy, see b-trials-3-fix-round); one that never started
      // is noticed once the card is saved.
      { purchase: notStarted, sub: trialSub({ default_payment_method: null }) },
    ];
    for (const c of cases) {
      expect(await w.noticeSvc.recordTrialWillEnd(tx, { ...c, eventId: 'e', now: NOW })).toBeNull();
    }
    expect(w.notices.rows).toHaveLength(0);
    expect(w.notifications.createNotification).not.toHaveBeenCalled();
  });

  it('the amount is what Stripe will charge (items), falling back to the purchase price', () => {
    expect(
      upcomingChargeCents(
        trialSub({ items: { data: [{ quantity: 2, price: { unit_amount: 2500 } }] } }),
        4900,
      ),
    ).toBe(5000);
    expect(upcomingChargeCents(trialSub({ items: null }), 4900)).toBe(4900);
  });
});

describe('B-TRIALS — delivery (push + email after commit, retried by the sweep)', () => {
  async function recorded(w: ReturnType<typeof world>) {
    const purchase =
      stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(purchaseRow());
    const tx = stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[0]>(w.prisma);
    const id = await w.noticeSvc.recordTrialWillEnd(tx, {
      purchase,
      sub: trialSub(),
      eventId: 'evt_1',
      now: NOW,
    });
    if (!id) throw new Error('expected a notice');
    return id;
  }

  it('sends one push and one email with the exact copy and a stable idempotency key', async () => {
    const w = world();
    const id = await recorded(w);
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledWith(
      'client-1',
      'Your free trial',
      'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.',
      expect.objectContaining({
        kind: 'trial_ending',
        purchase_id: 'pur-1',
        actionScreen: 'ClientPackages',
      }),
      // B-TRIALS-3 (B-656-2) — the push is bounded: an abort signal fires
      // when the transport outlives TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS.
      expect.any(AbortSignal),
    );
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({
      to: 'client@example.test',
      template: 'trial-ending',
      idempotencyKey: `trial-ending:pur-1:${TRIAL_END.getTime()}`,
    });
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'delivered', email_status: 'sent' });
    // A second delivery (sweep, duplicate hook) sends nothing more.
    await w.noticeSvc.deliver(id, NOW);
    await w.noticeSvc.sweep(new Date(NOW.getTime() + 60 * 60 * 1000));
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
  });

  it('RACE: two concurrent deliveries send the push once', async () => {
    const w = world();
    const id = await recorded(w);
    await Promise.all([w.noticeSvc.deliver(id, NOW), w.noticeSvc.deliver(id, NOW)]);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
  });

  it('a transport failure stays pending and the sweep retries it', async () => {
    const w = world({ pushCode: 'transport-error' });
    const id = await recorded(w);
    // The fake table stamps created_at with the wall clock; pin it to the test
    // clock so the sweep's minimum-age check does not depend on the time of day.
    w.notices.rows[0].created_at = NOW;
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notices.rows[0].push_status).toBe('pending');
    w.notifications.pushToUser.mockResolvedValueOnce({ delivered: true, code: 'delivered' });
    const swept = await w.noticeSvc.sweep(new Date(NOW.getTime() + 10 * 60 * 1000));
    expect(swept).toBe(1);
    expect(w.notices.rows[0].push_status).toBe('delivered');
  });

  it('no push token or no email is recorded, not retried forever', async () => {
    const w = world({ pushCode: 'no-token', email: null });
    const id = await recorded(w);
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'no_token', email_status: 'no_email' });
    expect(await w.noticeSvc.sweep(new Date(NOW.getTime() + 10 * 60 * 1000))).toBe(0);
  });

  it('nothing is sent once the trial has ended', async () => {
    const w = world();
    const id = await recorded(w);
    await w.noticeSvc.deliver(id, new Date(TRIAL_END.getTime() + 1000));
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
  });
});

describe('B-TRIALS — webhook trial lifecycle', () => {
  it('customer.subscription.trial_will_end is claimed and hands the notice to post-commit delivery', async () => {
    const w = world();
    // B-TR2-117 — the purchase mirrors the trial end the event announces.
    const end = new Date(epoch(new Date(Date.now() + 3 * 864e5)) * 1000);
    w.purchases[0].trial_ends_at = end;
    const res = await w.handler.handle(
      event('customer.subscription.trial_will_end', trialSub({ trial_end: epoch(end) })),
      w.tx,
    );
    expect(res.claimed).toBe(true);
    expect(res.deferredTrialNoticeId).toEqual(expect.any(String));
    expect(w.notifications.pushToUser).not.toHaveBeenCalled(); // never inside the tx
    await w.handler.deliverTrialNotice(res.deferredTrialNoticeId as string);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('a trialing subscription WITHOUT a saved card grants no access (card up front)', async () => {
    const w = world();
    w.purchases[0].entitlement_active = false;
    await w.handler.handle(
      event('customer.subscription.updated', trialSub({ default_payment_method: null })),
      w.tx,
    );
    expect(w.purchases[0].entitlement_active).toBe(false);
    expect(w.usage.rows).toHaveLength(0);
  });

  it('C-671-4 (B-TR2-117) — a trial that never started keeps no trial end: never "The trial is over"', async () => {
    const w = world();
    Object.assign(w.purchases[0], { entitlement_active: false, trial_ends_at: null });
    const noCard = trialSub({ default_payment_method: null });
    await w.handler.handle(event('customer.subscription.updated', noCard), w.tx);
    expect(w.purchases[0].trial_ends_at).toBeNull();
    expect(purchaseTrialView(w.purchases[0]).state).toBe('setup_incomplete');
    const gone = trialSub({ status: 'canceled', default_payment_method: null });
    await w.handler.handle(event('customer.subscription.updated', gone, 'evt_2'), w.tx);
    expect(w.purchases[0]).toMatchObject({ status: 'canceled', trial_ends_at: null });
    expect(purchaseTrialView(w.purchases[0]).state).toBe('none');
    // Control: a trial that started keeps its end through the cancel and reads 'ended'.
    const s = world();
    Object.assign(s.purchases[0], { entitlement_active: false, trial_ends_at: null });
    await s.handler.handle(event('customer.subscription.updated', trialSub()), s.tx);
    await s.handler.handle(
      event('customer.subscription.updated', trialSub({ status: 'canceled' }), 'evt_2'),
      s.tx,
    );
    expect(s.purchases[0].trial_ends_at).toEqual(TRIAL_END);
    expect(purchaseTrialView(s.purchases[0]).state).toBe('ended');
  });

  it('a trialing subscription WITH a saved card grants access, records trial_ends_at and starts the trial', async () => {
    const w = world();
    w.purchases[0].entitlement_active = false;
    w.purchases[0].trial_days = 0;
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchases[0]).toMatchObject({
      entitlement_active: true,
      status: 'trialing',
      trial_days: 7,
    });
    expect((w.purchases[0].trial_ends_at as Date).toISOString()).toBe(TRIAL_END.toISOString());
    expect(w.usage.rows[0]).toMatchObject({ status: 'started', purchase_id: 'pur-1' });
  });

  it('a second trial with the same coach gets no access and is cancelled after commit', async () => {
    const w = world();
    w.usage.rows.push({
      id: 'u-old',
      client_user_id: 'client-1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-0',
      purchase_id: 'pur-0',
      trial_days: 7,
      status: 'started',
      reserved_at: new Date(),
    });
    const res = await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchases[0].entitlement_active).toBe(false);
    expect(res.trialConflictSubscriptionId).toBe('sub_1');
    await w.handler.cancelTrialConflict('sub_1');
    expect(w.stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
  });

  it('a subscription deleted before the card was saved gives the trial back; a started one stays used', async () => {
    const w = world();
    await w.usageSvc.reserve(stub<Parameters<TrialUsageService['reserve']>[0]>(w.prisma), {
      clientUserId: 'client-1',
      coachUserId: 'coach-1',
      packageId: 'pkg-1',
      purchaseId: 'pur-1',
      trialDays: 7,
    });
    await w.handler.handle(event('customer.subscription.deleted', { id: 'sub_1' }), w.tx);
    expect(w.usage.rows[0].status).toBe('released');
  });

  it('B-TRIALS-2: a started trial keeps access to its end when the card is later removed (no charge: Stripe cancels at trial end)', async () => {
    const w = world();
    w.purchases[0].entitlement_active = false;
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchases[0].entitlement_active).toBe(true);
    await w.handler.handle(
      event('customer.subscription.updated', trialSub({ default_payment_method: null }), 'evt_2'),
      w.tx,
    );
    expect(w.purchases[0].entitlement_active).toBe(true);
    expect(w.usage.rows[0]).toMatchObject({ status: 'started', purchase_id: 'pur-1' });
  });

  it('B-TRIALS-2: a reserved (never started) trial without a card still grants nothing', async () => {
    const w = world();
    w.purchases[0].entitlement_active = false;
    await w.usageSvc.reserve(stub<Parameters<TrialUsageService['reserve']>[0]>(w.prisma), {
      clientUserId: 'client-1',
      coachUserId: 'coach-1',
      packageId: 'pkg-1',
      purchaseId: 'pur-1',
      trialDays: 7,
    });
    await w.handler.handle(
      event('customer.subscription.updated', trialSub({ default_payment_method: null })),
      w.tx,
    );
    expect(w.purchases[0].entitlement_active).toBe(false);
    expect(w.usage.rows[0].status).toBe('reserved');
  });

  it('invoice.paid for the $0 trial invoice does not grant access without a card', async () => {
    const w = world();
    w.purchases[0].entitlement_active = false;
    const res = await w.handler.handle(
      event('invoice.paid', { id: 'in_1', subscription: 'sub_1', amount_paid: 0 }),
      w.tx,
      {
        invoiceSubscription: stub<
          NonNullable<Parameters<CheckoutWebhookHandlerService['handle']>[2]>['invoiceSubscription']
        >(trialSub({ default_payment_method: null })),
      },
    );
    expect(res.claimed).toBe(true);
    expect(w.purchases[0].entitlement_active).toBe(false);
  });
});

describe('B-TRIALS — purchase trial view (Home / Your plan)', () => {
  const row = {
    status: 'trialing',
    entitlement_active: true,
    amount_cents: 4900,
    currency: 'usd',
    cancel_at_period_end: false,
    trial_days: 7,
    trial_ends_at: TRIAL_END,
  };
  it('trialing with a card: will charge at the trial end', () => {
    expect(purchaseTrialView(row, NOW)).toEqual({
      state: 'trialing',
      trial_days: 7,
      ends_at: TRIAL_END.toISOString(),
      will_charge: true,
      no_charge_reason: null,
      charge_amount_cents: 4900,
      currency: 'usd',
    });
  });
  it('cancelled during the trial: no charge', () => {
    expect(purchaseTrialView({ ...row, cancel_at_period_end: true }, NOW)).toMatchObject({
      state: 'trialing',
      will_charge: false,
      no_charge_reason: 'cancelled',
    });
  });
  it('no card yet, trial over, and no trial', () => {
    expect(purchaseTrialView({ ...row, entitlement_active: false }, NOW).state).toBe(
      'setup_incomplete',
    );
    expect(purchaseTrialView({ ...row, status: 'active' }, NOW).state).toBe('ended');
    expect(
      purchaseTrialView({ ...row, trial_days: 0, trial_ends_at: null, status: 'active' }, NOW)
        .state,
    ).toBe('none');
  });
});

describe('B-TRIALS — TRIAL_ENDING is never dropped by notification preferences', () => {
  it('writes the in-app row even though digest defaults are off', async () => {
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'n',
      ...data,
    }));
    const prisma = { notification: { create } };
    const svc = new NotificationsService(
      stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
    );
    jest.spyOn(svc, 'getPreferences').mockResolvedValue(
      stub<Awaited<ReturnType<NotificationsService['getPreferences']>>>({
        muted: false,
        digest_inapp: false,
        digest_push: false,
      }),
    );
    const row = await svc.createNotification({
      user_id: 'client-1',
      kind: 'trial_ending',
      body: 'x',
      channel: 'inapp',
    });
    expect(row).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('B-TRIALS — BillingService runs trial side effects only after commit', () => {
  function build(opts: { failInTx?: boolean } = {}) {
    const order: string[] = [];
    const processed: Array<Record<string, unknown>> = [];
    const prisma: Record<string, unknown> = {
      stripeProcessedEvent: {
        findUnique: jest.fn(async () => null),
        updateMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          processed.push(data);
          if (opts.failInTx) throw new Error('db down');
          return data;
        }),
      },
      coachProfile: { findFirst: jest.fn(async () => null) },
    };
    prisma.$transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const out = await cb(prisma);
      order.push('commit');
      return out;
    });
    const checkout = {
      handle: jest.fn(async () => ({
        claimed: true,
        purchase_id: 'pur-1',
        deferredTrialNoticeId: 'notice-1',
        trialConflictSubscriptionId: 'sub_dup',
      })),
      deliverTrialNotice: jest.fn(async () => {
        order.push('deliver');
      }),
      cancelTrialConflict: jest.fn(async () => {
        order.push('cancel');
      }),
    };
    type Ctor = ConstructorParameters<typeof BillingService>;
    const svc = new BillingService(
      stub<Ctor[0]>(prisma),
      stub<Ctor[1]>({ capture: jest.fn(), identify: jest.fn() }),
      stub<Ctor[2]>({ write: jest.fn(async () => undefined), list: jest.fn(async () => []) }),
      stub<Ctor[3]>({
        syncFromStripe: jest.fn(async () => null),
        markDeauthorized: jest.fn(async () => undefined),
      }),
      stub<Ctor[4]>(checkout),
    );
    return { svc, checkout, order };
  }

  it('delivers the notice and cancels the duplicate trial after the transaction commits', async () => {
    const { svc, checkout, order } = build();
    await svc.handleEvent(
      stub<Parameters<BillingService['handleEvent']>[0]>({
        id: 'evt_t',
        type: 'customer.subscription.trial_will_end',
        data: { object: { id: 'sub_1' } },
      }),
    );
    expect(checkout.deliverTrialNotice).toHaveBeenCalledWith('notice-1');
    expect(checkout.cancelTrialConflict).toHaveBeenCalledWith('sub_dup');
    expect(order).toEqual(['commit', 'deliver', 'cancel']);
  });

  it('sends nothing when the transaction rolls back (Stripe retries the event)', async () => {
    const { svc, checkout } = build({ failInTx: true });
    await expect(
      svc.handleEvent(
        stub<Parameters<BillingService['handleEvent']>[0]>({
          id: 'evt_t2',
          type: 'customer.subscription.trial_will_end',
          data: { object: { id: 'sub_1' } },
        }),
      ),
    ).rejects.toThrow();
    expect(checkout.deliverTrialNotice).not.toHaveBeenCalled();
    expect(checkout.cancelTrialConflict).not.toHaveBeenCalled();
  });
});
