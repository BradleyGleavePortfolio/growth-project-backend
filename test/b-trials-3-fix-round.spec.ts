// B-TRIALS-3 (agent 115) — fix round for GPT-6.1 Sol REQUEST CHANGES on #656
// @ 079e9e39 (B-656-1..5) and the card-removed-mid-trial backlog item.
//
// Every block failed before this round (on 079e9e39):
//   B-656-1  a lost one-trial race left no durable trace: a failed post-commit
//            cancel was forgotten (no PackageTrialConflict table, no sweep).
//   B-656-2  the attempt counter was not an exclusive claim: a staggered second
//            caller sent again and a stale outcome overwrote 'delivered'.
//   B-656-3  a trial_will_end event that arrived before the card was saved was
//            dropped, and nothing recorded the notice once the trial started.
//   B-656-4  the push ignored a global mute.
//   B-656-5  a trial whose card was removed still read will_charge:true and got
//            no notice.
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeSubscriptionObject,
} from '../src/connect/stripe-connect-api.service';
import {
  TRIAL_CONFLICT_ALERT_AFTER,
  TRIAL_CONFLICT_CANCEL_TIMEOUT_MS,
  TrialConflictService,
  trialConflictBackoffMs,
} from '../src/packages/trials/trial-conflict.service';
import { trialEndingCopy, willChargeCard } from '../src/packages/trials/trial-copy';
import { assertValidTrial } from '../src/packages/trials/trial-rules';
import {
  TRIAL_NOTICE_LEAD_MS,
  TRIAL_NOTICE_ABORT_GRACE_MS,
  TRIAL_NOTICE_LEASE_MS,
  TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS,
  TrialNoticeService,
} from '../src/packages/trials/trial-notice.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { purchaseTrialView } from '../src/packages/trials/trial-view';
import {
  makeTable,
  makeTrialConflictTable,
  makeTrialNoticeTable,
  makeTrialUsageTable,
  stub,
} from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const TRIAL_END = new Date('2026-10-12T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const CHARGE =
  'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.';
const NO_CARD =
  'Your free trial ends on Oct 12. No card is saved, so nothing will be charged and your plan ends then.';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
    card_on_file: true as boolean | null,
    trial_days: 7,
    trial_ends_at: TRIAL_END as Date | null,
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

const event = (type: string, object: Record<string, unknown>, id = 'evt_1') => ({
  id,
  type,
  data: { object },
});

function world(
  opts: {
    muted?: boolean;
    pushCode?: string;
    customerDefault?: string | null;
    purchase?: Record<string, unknown>;
  } = {},
) {
  const notices = makeTrialNoticeTable();
  const usage = makeTrialUsageTable();
  const conflicts = makeTrialConflictTable();
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push(purchaseRow(opts.purchase));
  const withRelations = (row: Record<string, unknown>) => ({
    ...row,
    package: { name: 'GP Monthly', interval: 'month', interval_count: 1 },
    coach: { name: 'Bradley Coach' },
    client: { email: 'client@example.test', name: 'Ana Client' },
  });
  const prisma: Record<string, unknown> = {
    packageTrialNotice: notices,
    packageTrialUsage: usage,
    packageTrialConflict: conflicts,
    notificationPreferences: {
      // B-TR2-117 — the client's own (stamped) zone: the date reads bare (C-672-7).
      findUnique: jest.fn(async () => ({
        timezone: 'America/Los_Angeles',
        timezone_updated_at: NOW,
      })),
    },
    connectCustomer: {
      findUnique: jest.fn(async () =>
        opts.customerDefault ? { default_payment_method_id: opts.customerDefault } : null,
      ),
    },
    coachPackage: {
      findUnique: jest.fn(async () => ({ id: 'pkg-1', duration_periods: null, trial_days: 7 })),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => {
        const row = purchases.rows.find(
          (p) =>
            (where.id && p.id === where.id) ||
            (where.stripe_subscription_id &&
              p.stripe_subscription_id === where.stripe_subscription_id),
        );
        return row ? withRelations(row) : null;
      }),
      findMany: purchases.findMany,
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = purchases.rows.find((p) => p.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(async (cb: (tx: unknown) => unknown): Promise<unknown> =>
    cb(prisma),
  );
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>, _tx?: unknown) => ({
      id: 'n-1',
      ...input,
    })),
    getPreferences: jest.fn(async () => ({ muted: !!opts.muted })),
    pushToUser: jest.fn(
      async (..._args: unknown[]): Promise<{ delivered: boolean; code: string }> =>
        opts.pushCode
          ? { delivered: false, code: opts.pushCode }
          : { delivered: true, code: 'delivered' },
    ),
  };
  const email = {
    send: jest.fn(async (input: { idempotencyKey: string }): Promise<Record<string, unknown>> => ({
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
  const cancelSubscription = jest.fn(
    async (_id: string): Promise<{ id: string; status: string }> => ({
      id: 'sub_1',
      status: 'canceled',
    }),
  );
  const stripe = stub<StripeConnectApiService>({
    cancelSubscription,
    // B-TR3-118 (B-673-1) — the worker reads Stripe's state first: still trialing.
    retrieveSubscription: jest.fn(async (id: string) => ({
      id,
      status: 'trialing',
      trial_end: epoch(new Date(Date.now() + 30 * 864e5)),
    })),
    // B-TR4-119 (B-673-1) — the only paid invoice is the $0 trial one: never billed.
    listSubscriptionPaidInvoices: jest.fn(async () => ({
      data: [{ id: 'in_trial', amount_paid: 0, total: 0 }],
      has_more: false,
    })),
    listOpenInvoices: jest.fn(async () => ({ data: [{ id: 'in_open' }], has_more: false })),
    listUncollectibleInvoices: jest.fn(async () => ({ data: [], has_more: false })),
    listDraftInvoices: jest.fn(async () => ({ data: [], has_more: false })),
    voidInvoice: jest.fn(async (id: string) => ({ id, status: 'void' })),
  });
  const conflictSvc = new TrialConflictService(
    stub<ConstructorParameters<typeof TrialConflictService>[0]>(prisma),
    stripe,
  );
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
    conflictSvc,
  );
  const tx = stub<Parameters<CheckoutWebhookHandlerService['handle']>[1]>(prisma);
  const purchase = () => purchases.rows[0];
  return {
    prisma,
    notices,
    usage,
    conflicts,
    purchases,
    purchase,
    notifications,
    email,
    noticeSvc,
    usageSvc,
    conflictSvc,
    handler,
    cancelSubscription,
    stripe,
    tx,
  };
}

type World = ReturnType<typeof world>;
type NoticeDeps = ConstructorParameters<typeof TrialNoticeService>;
/** B-TR2-117 — another replica: one process never starts a second send of a channel (B-672-4). */
const replica = (w: World) =>
  new TrialNoticeService(
    stub<NoticeDeps[0]>(w.prisma),
    stub<NoticeDeps[1]>(w.notifications),
    stub<NoticeDeps[2]>(w.email),
  );

/** Another purchase already holds this client's trial with coach-1. */
function trialAlreadyStartedElsewhere(w: World) {
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
}

async function recordNotice(w: World, sub = trialSub()) {
  const id = await w.noticeSvc.recordTrialWillEnd(
    stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[0]>(w.prisma),
    {
      purchase: stub<Parameters<TrialNoticeService['recordTrialWillEnd']>[1]['purchase']>(
        w.purchase(),
      ),
      sub,
      eventId: 'evt_1',
      now: NOW,
    },
  );
  if (!id) throw new Error('expected a notice');
  return id;
}

beforeEach(() => {
  jest.mocked(Sentry.captureMessage).mockClear();
});

describe('B-656-1 — a second trial owes a durable cancellation', () => {
  it('the lost race writes an owed PackageTrialConflict row on the webhook tx and denies access', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    const res = await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchase().entitlement_active).toBe(false);
    expect(res.trialConflictSubscriptionId).toBe('sub_1');
    expect(w.conflicts.rows).toHaveLength(1);
    expect(w.conflicts.rows[0]).toMatchObject({
      purchase_id: 'pur-1',
      stripe_subscription_id: 'sub_1',
      status: 'owed',
    });
    expect(w.cancelSubscription).not.toHaveBeenCalled(); // never inside the tx
  });

  it('a transient cancel failure stays owed with backoff; redelivery is a no-op but the sweep settles it', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    w.cancelSubscription.mockRejectedValueOnce(
      new StripeConnectApiError('api down', 503, null, 'api_error'),
    );
    await w.handler.cancelTrialConflict('sub_1');
    expect(w.cancelSubscription).toHaveBeenCalledTimes(1);
    const row = w.conflicts.rows[0];
    expect(row).toMatchObject({
      status: 'owed',
      attempts: 1,
      last_error: 'http_503',
      lease_token: null,
    });
    expect((row.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());

    // Too early for the backoff: nothing is retried.
    expect(await w.conflictSvc.sweep(new Date())).toBe(0);
    // After the backoff the sweep cancels it once.
    const later = new Date(Date.now() + trialConflictBackoffMs(1) + 1000);
    expect(await w.conflictSvc.sweep(later)).toBe(1);
    expect(w.cancelSubscription).toHaveBeenCalledTimes(2);
    expect(w.conflicts.rows[0]).toMatchObject({ status: 'cancelled' });
    expect(await w.conflictSvc.sweep(new Date(later.getTime() + 864e5))).toBe(0);
    expect(w.cancelSubscription).toHaveBeenCalledTimes(2);
  });

  it('process stop after commit: the post-commit settle never ran, the sweep cancels it', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(await w.conflictSvc.sweep(new Date(Date.now() + 1000))).toBe(1);
    expect(w.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(w.conflicts.rows[0].status).toBe('cancelled');
  });

  it('a later trialing event with a card never grants access and re-arms the cancel', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    const again = await w.handler.handle(
      event('customer.subscription.updated', trialSub({ cancel_at_period_end: false }), 'evt_2'),
      w.tx,
    );
    expect(w.purchase().entitlement_active).toBe(false);
    expect(again.trialConflictSubscriptionId).toBe('sub_1');
    // invoice.paid for the $0 trial invoice: still no access.
    await w.handler.handle(
      event('invoice.paid', { id: 'in_0', subscription: 'sub_1', amount_paid: 0 }, 'evt_3'),
      w.tx,
      {
        invoiceSubscription:
          stub<
            NonNullable<
              Parameters<CheckoutWebhookHandlerService['handle']>[2]
            >['invoiceSubscription']
          >(trialSub()),
      },
    );
    expect(w.purchase().entitlement_active).toBe(false);
    expect(w.conflicts.rows).toHaveLength(1);
  });

  it('two settles at once make one Stripe call (lease)', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    const gate = deferred<{ id: string; status: string }>();
    w.cancelSubscription.mockImplementationOnce(() => gate.promise);
    const a = w.conflictSvc.settle('pur-1');
    for (let i = 0; i < 20 && w.cancelSubscription.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(w.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(await w.conflictSvc.settle('pur-1')).toBe('busy');
    gate.resolve({ id: 'sub_1', status: 'canceled' });
    expect(await a).toBe('cancelled');
    expect(w.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('Stripe says the subscription is already gone: settled as cancelled', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    w.cancelSubscription.mockRejectedValueOnce(
      new StripeConnectApiError(
        'No such subscription',
        404,
        'resource_missing',
        'invalid_request_error',
      ),
    );
    expect(await w.conflictSvc.settle('pur-1')).toBe('cancelled');
    expect(w.conflicts.rows[0]).toMatchObject({
      status: 'cancelled',
      last_error: 'already_cancelled',
    });
  });

  it('a hung Stripe call is bounded by the timeout and retried later', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const w = world({ purchase: { entitlement_active: false } });
      trialAlreadyStartedElsewhere(w);
      await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
      w.cancelSubscription.mockImplementationOnce(
        () => new Promise<{ id: string; status: string }>(() => undefined),
      );
      const p = w.conflictSvc.settle('pur-1', NOW);
      for (let i = 0; i < 20 && w.cancelSubscription.mock.calls.length === 0; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      jest.advanceTimersByTime(TRIAL_CONFLICT_CANCEL_TIMEOUT_MS + 1);
      expect(await p).toBe('retry');
      expect(w.conflicts.rows[0]).toMatchObject({
        status: 'owed',
        last_error: 'timeout',
        lease_token: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it(`after ${TRIAL_CONFLICT_ALERT_AFTER} failures support gets one alert with ids only`, async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    w.cancelSubscription.mockRejectedValue(
      new StripeConnectApiError('down', 500, null, 'api_error'),
    );
    let t = Date.now();
    for (let i = 0; i < TRIAL_CONFLICT_ALERT_AFTER + 2; i += 1) {
      t += 2 * 60 * 60 * 1000;
      await w.conflictSvc.settle('pur-1', new Date(t));
    }
    const calls = jest.mocked(Sentry.captureMessage).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      level: 'error',
      tags: { code: 'TRIAL_CONFLICT_CANCEL_FAILING', purchase_id: 'pur-1' },
    });
    expect(w.conflicts.rows[0].status).toBe('owed'); // still retried
  });

  it('billing started before any cancel succeeded: superseded, the paying client gets access, support alerted once', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    await w.handler.handle(
      event(
        'customer.subscription.updated',
        trialSub({ status: 'active', trial_end: epoch(NOW) }),
        'evt_9',
      ),
      w.tx,
    );
    expect(w.conflicts.rows[0].status).toBe('superseded');
    expect(w.purchase().entitlement_active).toBe(true);
    await w.conflictSvc.sweep(new Date());
    await w.conflictSvc.sweep(new Date());
    const calls = jest.mocked(Sentry.captureMessage).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      tags: { code: 'TRIAL_CONFLICT_SUPERSEDED', purchase_id: 'pur-1' },
    });
  });

  it('customer.subscription.deleted settles an owed conflict as cancelled', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    await w.handler.handle(event('customer.subscription.deleted', { id: 'sub_1' }, 'evt_d'), w.tx);
    expect(w.conflicts.rows[0].status).toBe('cancelled');
    expect(await w.conflictSvc.sweep(new Date(Date.now() + 864e5))).toBe(0);
    expect(w.cancelSubscription).not.toHaveBeenCalled();
  });

  it('the purchase list says not_eligible (never "will charge") for a lost race', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    const findMany = jest.fn(async () => [w.purchase()]);
    type Ctor = ConstructorParameters<typeof CheckoutService>;
    const svc = new CheckoutService(
      stub<Ctor[0]>({ ...w.prisma, clientPurchase: { findMany } }),
      stub<Ctor[1]>({}),
      stub<Ctor[2]>({}),
      stub<Ctor[3]>({}),
      stub<Ctor[4]>({}),
      stub<Ctor[5]>({}),
    );
    const out = await svc.listForClient('client-1');
    expect(out.items[0].trial).toMatchObject({ state: 'not_eligible', will_charge: false });
  });
});

describe('B-656-2 — exclusive, fenced, bounded channel delivery', () => {
  it('staggered entry: a second caller while the first push is in flight sends nothing', async () => {
    const w = world();
    const id = await recordNotice(w);
    const gate = deferred<{ delivered: boolean; code: string }>();
    w.notifications.pushToUser.mockImplementationOnce(() => gate.promise);
    const a = w.noticeSvc.deliver(id, NOW);
    for (let i = 0; i < 20 && w.notifications.pushToUser.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    // B enters from the durable row (attempts already 1, status pending).
    await w.noticeSvc.deliver(id, new Date(NOW.getTime() + 1000));
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    gate.resolve({ delivered: false, code: 'transport-error' });
    await a;
    expect(w.notices.rows[0]).toMatchObject({
      push_status: 'pending',
      push_attempts: 1,
      push_lease_token: null,
    });
  });

  it('a stale holder (lease expired, another caller delivered) can never overwrite delivered', async () => {
    const w = world();
    const id = await recordNotice(w);
    const gate = deferred<{ delivered: boolean; code: string }>();
    w.notifications.pushToUser.mockImplementationOnce(() => gate.promise);
    const a = w.noticeSvc.deliver(id, NOW);
    for (let i = 0; i < 20 && w.notifications.pushToUser.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    await replica(w).deliver(id, new Date(NOW.getTime() + TRIAL_NOTICE_LEASE_MS + 1000));
    expect(w.notices.rows[0].push_status).toBe('delivered');
    gate.resolve({ delivered: false, code: 'transport-error' });
    await a;
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'delivered', push_lease_token: null });
    await w.noticeSvc.sweep(new Date(NOW.getTime() + 60 * 60 * 1000));
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(2); // at-least-once, never a third
  });

  it('email: a stale failure cannot overwrite sent; a retry after a definite failure uses a new key', async () => {
    const w = world();
    const id = await recordNotice(w);
    const gate = deferred<Record<string, unknown>>();
    w.email.send.mockImplementationOnce(() => gate.promise);
    const a = w.noticeSvc.deliver(id, NOW);
    for (let i = 0; i < 30 && w.email.send.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    await replica(w).deliver(id, new Date(NOW.getTime() + TRIAL_NOTICE_LEASE_MS + 1000));
    expect(w.notices.rows[0].email_status).toBe('sent');
    gate.resolve({ status: 'failed', error: 'x' });
    await a;
    expect(w.notices.rows[0].email_status).toBe('sent');
    const keys = w.email.send.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([
      `trial-ending:pur-1:${TRIAL_END.getTime()}`,
      `trial-ending:pur-1:${TRIAL_END.getTime()}:a2`,
    ]);
  });

  it('a hung push that ignores its abort: delivery returns, the row stays pending, the lease is held', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const w = world();
      const id = await recordNotice(w);
      w.notifications.pushToUser.mockImplementationOnce(
        () => new Promise<{ delivered: boolean; code: string }>(() => undefined),
      );
      const p = w.noticeSvc.deliver(id, NOW);
      for (let i = 0; i < 20 && w.notifications.pushToUser.mock.calls.length === 0; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      await jest.advanceTimersByTimeAsync(
        TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS + TRIAL_NOTICE_ABORT_GRACE_MS + 1,
      );
      await p;
      // B-TR2-117 (B-672-4) — the push may still reach the device: no retry
      // may start until it ends, so its lease is kept (renewed) meanwhile.
      expect(w.notices.rows[0]).toMatchObject({
        push_status: 'pending',
        last_error: expect.stringMatching(/^(push:timeout|email:)/),
        push_lease_token: expect.any(String),
      });
      expect(TRIAL_NOTICE_TRANSPORT_TIMEOUT_MS).toBeLessThan(TRIAL_NOTICE_LEASE_MS);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('B-656-3 — a trial_will_end event before the card is saved is not lost', () => {
  it('one-day trial: event during setup records nothing, the card save records and delivers the notice', async () => {
    const oneDayEnd = new Date(Date.now() + 864e5);
    const w = world({
      purchase: {
        entitlement_active: false,
        trial_ends_at: null,
        trial_days: 1,
        card_on_file: null,
      },
    });
    const sub = trialSub({
      trial_start: epoch(new Date()),
      trial_end: epoch(oneDayEnd),
      default_payment_method: null,
    });
    const early = await w.handler.handle(event('customer.subscription.trial_will_end', sub), w.tx);
    expect(early.claimed).toBe(true);
    expect(early.deferredTrialNoticeId).toBeUndefined();
    expect(w.notices.rows).toHaveLength(0);

    const saved = await w.handler.handle(
      event(
        'customer.subscription.updated',
        { ...sub, default_payment_method: 'pm_card_visa' },
        'evt_2',
      ),
      w.tx,
    );
    expect(w.purchase().entitlement_active).toBe(true);
    expect(saved.deferredTrialNoticeId).toEqual(expect.any(String));
    expect(w.notices.rows[0]).toMatchObject({ source: 'trial_start', stripe_event_id: 'evt_2' });
    await w.handler.deliverTrialNotice(saved.deferredTrialNoticeId as string);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
  });

  it('a trial that starts outside the warning window gets no notice at start', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    const far = trialSub({ trial_end: epoch(new Date(Date.now() + 10 * 864e5)) });
    const res = await w.handler.handle(event('customer.subscription.updated', far), w.tx);
    expect(w.purchase().entitlement_active).toBe(true);
    expect(res.deferredTrialNoticeId).toBeUndefined();
    expect(w.notices.rows).toHaveLength(0);
  });

  it('the reconciler records and delivers a due notice no event produced, exactly once', async () => {
    const w = world({ purchase: { trial_ends_at: TRIAL_END } });
    expect(await w.noticeSvc.reconcileDue(NOW)).toBe(1);
    expect(w.notices.rows[0]).toMatchObject({ source: 'sweep', stripe_event_id: null });
    expect(w.notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(await w.noticeSvc.reconcileDue(new Date(NOW.getTime() + 600_000))).toBe(0);
    expect(w.notices.rows).toHaveLength(1);
  });

  it('the reconciler skips a trial without access and a trial ending later than the window', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    expect(await w.noticeSvc.reconcileDue(NOW)).toBe(0);
    w.purchase().entitlement_active = true;
    w.purchase().trial_ends_at = new Date(NOW.getTime() + TRIAL_NOTICE_LEAD_MS + 60_000);
    expect(await w.noticeSvc.reconcileDue(NOW)).toBe(0);
    expect(w.notices.rows).toHaveLength(0);
  });
});

describe('B-656-4 — the push honours the client notification preferences', () => {
  it('global mute: push suppressed (no send), preferences read at delivery, billing email still sent', async () => {
    const w = world({ muted: true });
    const id = await recordNotice(w);
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.getPreferences).toHaveBeenCalledWith('client-1');
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'suppressed', email_status: 'sent' });
    expect(await w.noticeSvc.sweep(new Date(NOW.getTime() + 600_000))).toBe(0);
  });

  it('muted after the notice was recorded still suppresses', async () => {
    const w = world();
    const id = await recordNotice(w);
    w.notifications.getPreferences.mockResolvedValueOnce({ muted: true });
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0].push_status).toBe('suppressed');
  });

  it('token revoked after the notice was recorded: no_token, not retried', async () => {
    const w = world({ pushCode: 'no-token' });
    const id = await recordNotice(w);
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notices.rows[0].push_status).toBe('no_token');
    expect(await w.noticeSvc.sweep(new Date(NOW.getTime() + 600_000))).toBe(0);
  });
});

describe('B-656-5 — card removed mid-trial: access kept, the truth told', () => {
  it('activation -> card removal: access stays, card_on_file=false, will_charge=false (no_card)', async () => {
    const w = world({ purchase: { entitlement_active: false, card_on_file: null } });
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchase()).toMatchObject({ entitlement_active: true, card_on_file: true });
    await w.handler.handle(
      event('customer.subscription.updated', trialSub({ default_payment_method: null }), 'evt_2'),
      w.tx,
    );
    expect(w.purchase()).toMatchObject({ entitlement_active: true, card_on_file: false });
    const view = purchaseTrialView(
      stub<Parameters<typeof purchaseTrialView>[0]>(w.purchase()),
      NOW,
    );
    expect(view).toMatchObject({
      state: 'trialing',
      will_charge: false,
      no_charge_reason: 'no_card',
    });
  });

  it('a customer default card still charges: will_charge stays true', () => {
    const row = stub<Parameters<typeof purchaseTrialView>[0]>(purchaseRow({ card_on_file: false }));
    expect(purchaseTrialView(row, NOW, { customerDefaultCard: true })).toMatchObject({
      will_charge: true,
      no_charge_reason: null,
    });
    expect(willChargeCard(null, false)).toBe(true); // unknown never claims "no charge"
    expect(willChargeCard(false, false)).toBe(false);
  });

  it('trial_will_end after the card was removed: the notice is sent and says nothing will be charged', async () => {
    // Stripe's second precision: the purchase mirrors the event's trial_end.
    const end = new Date(epoch(new Date(Date.now() + 2 * 864e5)) * 1000);
    const w = world({ purchase: { card_on_file: false, trial_ends_at: end } });
    const res = await w.handler.handle(
      event(
        'customer.subscription.trial_will_end',
        trialSub({ trial_end: epoch(end), default_payment_method: null }),
      ),
      w.tx,
    );
    expect(res.deferredTrialNoticeId).toEqual(expect.any(String));
    const expected = trialEndingCopy({
      trialEndsAt: new Date(epoch(end) * 1000),
      amountCents: 4900,
      currency: 'usd',
      timeZone: 'America/Los_Angeles',
      cancelAtPeriodEnd: false,
      cardOnFile: false,
    }).body;
    expect(expected).toMatch(/No card is saved, so nothing will be charged/);
    const [input] = w.notifications.createNotification.mock.calls[0];
    expect(input).toMatchObject({
      body: expected,
      payload: expect.objectContaining({ will_charge: false, card_on_file: false }),
    });
    await w.noticeSvc.deliver(res.deferredTrialNoticeId as string);
    expect(w.notifications.pushToUser.mock.calls[0][2]).toBe(expected);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({
      data: expect.objectContaining({ will_charge: false, no_card: true }),
    });
  });

  it('delivery re-reads the card: recorded with a card, removed before delivery, sends the no-card copy', async () => {
    const w = world();
    const id = await recordNotice(w);
    expect(w.notifications.createNotification.mock.calls[0][0]).toMatchObject({ body: CHARGE });
    w.purchase().card_on_file = false;
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser.mock.calls[0][2]).toBe(NO_CARD);
  });

  it('the no-card copy follows the voice rules', () => {
    const { title, body } = trialEndingCopy({
      trialEndsAt: TRIAL_END,
      amountCents: 4900,
      currency: 'usd',
      timeZone: 'America/Los_Angeles',
      cancelAtPeriodEnd: false,
      cardOnFile: false,
    });
    expect(body).toBe(NO_CARD);
    for (const text of [title, body]) {
      expect(text).not.toMatch(/!/);
      expect(text).not.toMatch(/\b(we|us|our)\b/i);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('C-338-2 (Opus, mobile #338) — refusal copy names a fix the editor offers', () => {
  it('no trial refusal tells the coach to "set the trial to 0 days" (the editor offers None)', () => {
    const shapes = [
      { trial_days: 7, amount_cents: 0, billing_type: 'recurring' },
      { trial_days: 7, amount_cents: 4900, billing_type: 'one_time' },
      { trial_days: 7, amount_cents: 4900, billing_type: 'recurring', recurring_amount_cents: 900 },
    ];
    for (const shape of shapes) {
      let message = '';
      try {
        assertValidTrial(stub<Parameters<typeof assertValidTrial>[0]>(shape));
      } catch (err) {
        const body = (err as { getResponse?: () => unknown }).getResponse?.();
        message = String((body as { message?: unknown } | undefined)?.message ?? '');
      }
      expect(message).toMatch(/remove the trial|or the trial/i);
      expect(message).not.toMatch(/0 days/);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 5 — GPT-6.1 Sol REQUEST CHANGES @ b9939d02 (B-656-3/5 narrowed,
// B-656-6, B-656-7). Each block failed on b9939d02.
// ---------------------------------------------------------------------------

/** Started trials due inside the window; the first `noticed` already have a notice. */
function seedDue(
  w: World,
  n: number,
  opts: { noticed: number; sameEnd?: boolean; reverse?: boolean },
) {
  w.purchase().status = 'canceled'; // keep pur-1 out of the due set
  const base = NOW.getTime() + 864e5;
  const rows = Array.from({ length: n }, (_, i) => {
    const id = `p-${String(i).padStart(4, '0')}`;
    const end = new Date(opts.sameEnd ? base : base + i * 60_000);
    return purchaseRow({ id, stripe_subscription_id: `sub_${id}`, trial_ends_at: end });
  });
  for (const row of opts.reverse ? [...rows].reverse() : rows) w.purchases.rows.push(row);
  for (const row of rows.slice(0, opts.noticed)) {
    w.notices.rows.push({
      id: `n-${row.id}`,
      purchase_id: row.id,
      client_user_id: 'client-1',
      trial_ends_at: new Date((row.trial_ends_at as Date).getTime()),
      amount_cents: 4900,
      currency: 'usd',
      source: 'trial_will_end',
      stripe_event_id: 'evt_x',
      push_status: 'delivered',
      push_attempts: 1,
      push_lease_token: null,
      push_lease_until: null,
      email_status: 'sent',
      email_attempts: 1,
      email_lease_token: null,
      email_lease_until: null,
      last_error: null,
    });
  }
  return rows;
}

const noticesFor = (w: World, id: string) => w.notices.rows.filter((n) => n.purchase_id === id);

describe('B-656-3 (round 5) — the reconciler pages past already-noticed trials', () => {
  it('a full first page of noticed trials does not hide the 20 due trials behind it', async () => {
    const w = world();
    const rows = seedDue(w, 120, { noticed: 100 });
    expect(await w.noticeSvc.reconcileDue(NOW)).toBe(20);
    for (const row of rows) expect(noticesFor(w, row.id)).toHaveLength(1);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(20);
    expect(await w.noticeSvc.reconcileDue(new Date(NOW.getTime() + 600_000))).toBe(0);
  });

  it('equal trial ends (ties) page by id, whatever the insert order', async () => {
    const w = world();
    const rows = seedDue(w, 150, { noticed: 100, sameEnd: true, reverse: true });
    expect(await w.noticeSvc.reconcileDue(NOW)).toBe(50);
    for (const row of rows) expect(noticesFor(w, row.id)).toHaveLength(1);
  });

  it('two sweeps at once record each missing notice once and push it once', async () => {
    const w = world();
    const rows = seedDue(w, 30, { noticed: 0 });
    const [a, b] = await Promise.all([
      w.noticeSvc.reconcileDue(NOW),
      w.noticeSvc.reconcileDue(NOW),
    ]);
    expect(a + b).toBe(30);
    for (const row of rows) expect(noticesFor(w, row.id)).toHaveLength(1);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(30);
  });
});

describe('B-656-5 (round 5) — an unknown card is never reported as "no card"', () => {
  it('the customer-default read fails at delivery: nothing is sent; the next delivery tells the truth', async () => {
    const w = world({ customerDefault: 'pm_default', purchase: { card_on_file: false } });
    const id = await recordNotice(w, trialSub({ default_payment_method: null }));
    expect(w.notifications.createNotification.mock.calls[0][0]).toMatchObject({ body: CHARGE });
    const lookup = w.prisma.connectCustomer as { findUnique: jest.Mock };
    lookup.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({
      push_status: 'pending',
      push_attempts: 0,
      email_status: 'pending',
      email_attempts: 0,
    });
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser.mock.calls[0][2]).toBe(CHARGE);
  });

  it('the read fails while recording: no notice with a wrong promise; the reconciler records it once the read works', async () => {
    const end = new Date(Date.now() + 2 * 864e5);
    const w = world({
      customerDefault: 'pm_default',
      purchase: { card_on_file: false, trial_ends_at: end },
    });
    const lookup = w.prisma.connectCustomer as { findUnique: jest.Mock };
    lookup.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    const res = await w.handler.handle(
      event(
        'customer.subscription.trial_will_end',
        trialSub({ trial_end: epoch(end), default_payment_method: null }),
      ),
      w.tx,
    );
    expect(res.deferredTrialNoticeId).toBeUndefined();
    expect(w.notices.rows).toHaveLength(0);
    expect(await w.noticeSvc.reconcileDue(new Date())).toBe(1);
    expect(w.notifications.createNotification.mock.calls[0][0].body).toMatch(
      /Your card will be charged \$49 then/,
    );
  });

  it('confirmed present and confirmed absent still read as before', () => {
    expect(willChargeCard(true, false)).toBe(true);
    expect(willChargeCard(false, true)).toBe(true);
    expect(willChargeCard(false, false)).toBe(false);
  });
});

describe('B-656-6 — a cancel-failing alert never suppresses the billed alert', () => {
  async function failThrice(w: World) {
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    w.cancelSubscription.mockRejectedValue(
      new StripeConnectApiError('down', 500, null, 'api_error'),
    );
    let t = Date.now();
    for (let i = 0; i < TRIAL_CONFLICT_ALERT_AFTER; i += 1) {
      t += 2 * 60 * 60 * 1000;
      await w.conflictSvc.settle('pur-1', new Date(t));
    }
  }
  const codes = () =>
    jest
      .mocked(Sentry.captureMessage)
      .mock.calls.map((c) => (c[1] as { tags?: { code?: string } } | undefined)?.tags?.code);

  it('failing alert, then billing starts: the billed alert still fires once', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    await failThrice(w);
    expect(codes()).toEqual(['TRIAL_CONFLICT_CANCEL_FAILING']);
    await w.handler.handle(
      event(
        'customer.subscription.updated',
        trialSub({ status: 'active', trial_end: epoch(NOW) }),
        'evt_9',
      ),
      w.tx,
    );
    expect(w.conflicts.rows[0].status).toBe('superseded');
    await w.conflictSvc.sweep(new Date());
    await w.conflictSvc.sweep(new Date());
    expect(codes()).toEqual(['TRIAL_CONFLICT_CANCEL_FAILING', 'TRIAL_CONFLICT_SUPERSEDED']);
  });

  it('two alert sweeps at once send the billed alert once', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    await failThrice(w);
    await w.handler.handle(
      event(
        'customer.subscription.updated',
        trialSub({ status: 'active', trial_end: epoch(NOW) }),
        'evt_9',
      ),
      w.tx,
    );
    const [a, b] = await Promise.all([
      w.conflictSvc.alertSuperseded(),
      w.conflictSvc.alertSuperseded(),
    ]);
    expect(a + b).toBe(1);
    expect(codes().filter((c) => c === 'TRIAL_CONFLICT_SUPERSEDED')).toHaveLength(1);
  });
});

describe('B-656-7 — trial workers log closed codes only', () => {
  const CANARY = 'AUDIT_FREE_TEXT_NAME_contact_at_example_invalid';
  const canary = () => Object.assign(new Error('contact@example.invalid'), { name: CANARY });
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    for (const level of ['error', 'warn', 'log', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());
  const leaked = () =>
    [...lines, JSON.stringify(jest.mocked(Sentry.captureMessage).mock.calls)].filter((l) =>
      /contact_at_example|contact@example/.test(l),
    );

  it('cancel failures (arbitrary Error.name, Stripe code) and the alert path', async () => {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    w.cancelSubscription.mockRejectedValueOnce(canary());
    await w.conflictSvc.settle('pur-1', new Date(Date.now() + 1000));
    expect(w.conflicts.rows[0].last_error).toBe('unclassified');
    w.cancelSubscription.mockRejectedValue(
      new StripeConnectApiError(
        'contact@example.invalid',
        503,
        'contact_at_example_invalid',
        'api_error',
      ),
    );
    let t = Date.now();
    for (let i = 0; i < 3; i += 1) {
      t += 2 * 60 * 60 * 1000;
      await w.conflictSvc.settle('pur-1', new Date(t));
    }
    expect(w.conflicts.rows[0].last_error).toBe('http_503');
    // the alert transport itself throws an arbitrary error
    jest.mocked(Sentry.captureMessage).mockImplementationOnce(() => {
      throw canary();
    });
    w.conflicts.rows[0].status = 'superseded';
    await w.conflictSvc.alertSuperseded();
    // the handler's settle lookup fails
    (w.prisma.packageTrialConflict as { findMany: unknown }).findMany = jest.fn(async () => {
      throw canary();
    });
    await w.handler.cancelTrialConflict('sub_1');
    expect(lines.length).toBeGreaterThan(0);
    expect(leaked()).toEqual([]);
  });

  it('notice reconcile, delivery, card lookup, push code and email failures', async () => {
    const w = world();
    const id = await recordNotice(w);
    w.notifications.pushToUser.mockResolvedValueOnce({ delivered: false, code: CANARY });
    w.email.send.mockRejectedValueOnce(canary());
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notices.rows[0].last_error).toBe('email:unclassified');
    w.notices.rows[0].push_lease_token = null;
    expect(w.notices.rows[0].push_status).toBe('pending');
    w.notifications.getPreferences.mockRejectedValueOnce(canary());
    await w.noticeSvc.deliver(id, NOW);
    const lookup = w.prisma.connectCustomer as { findUnique: jest.Mock };
    lookup.findUnique.mockRejectedValueOnce(canary());
    w.purchase().card_on_file = false;
    await w.noticeSvc.deliver(id, NOW);
    seedDue(w, 1, { noticed: 0 });
    (w.prisma as { $transaction: unknown }).$transaction = jest.fn(async () => {
      throw canary();
    });
    await w.noticeSvc.reconcileDue(NOW);
    expect(lines.length).toBeGreaterThan(2);
    expect(leaked()).toEqual([]);
  });

  it('push transport codes are closed', async () => {
    const w = world({ pushCode: CANARY });
    const id = await recordNotice(w);
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notices.rows[0].last_error).toBe('push:unclassified');
  });
});

// B-TR3-118 (agent 118) — fix round 9. Every test below fails on T3 df76889f
// (T2 c5e7ed8e) and passes after: Sol B-672-3 (the copy was built before the
// claim), Sol B-673-1 (an owed retry cancelled without reading Stripe) and
// Sol C-673-2 (the lease came from the sweep's start time).
describe('B-672-3 (round 9) — a change committed during preparation is never sent on the old copy', () => {
  const EXTENDED = new Date('2026-10-14T17:00:00Z');
  const duringPrefs = (w: World, change: () => void) =>
    w.notifications.getPreferences.mockImplementationOnce(async () => {
      change();
      return { muted: false };
    });

  it('an extension retires the old notice: nothing sent, the attempt given back', async () => {
    const w = world();
    const id = await recordNotice(w);
    duringPrefs(w, () => (w.purchase().trial_ends_at = EXTENDED));
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({
      push_status: 'skipped',
      email_status: 'skipped',
      push_attempts: 0,
      push_lease_token: null,
      last_error: 'skip:trial_superseded',
    });
  });

  it.each([
    ['converted early (paid)', (w: World) => (w.purchase().status = 'active'), 'skip:trial_ended'],
    ['canceled', (w: World) => (w.purchase().status = 'canceled'), 'skip:purchase_canceled'],
    [
      'deleted (account deletion)',
      (w: World) => w.purchases.rows.splice(0),
      'skip:purchase_missing',
    ],
  ])('%s: nothing is sent', async (_name, change, code) => {
    const w = world();
    const id = await recordNotice(w);
    duringPrefs(w, () => change(w));
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.notices.rows[0].last_error).toBe(code);
  });

  it('cancel at period end: the push and the email never say the card will be charged', async () => {
    const w = world();
    const id = await recordNotice(w);
    duringPrefs(w, () => (w.purchase().cancel_at_period_end = true));
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser.mock.calls[0][2]).toContain('will not be charged');
    expect(w.email.send.mock.calls[0][0]).toMatchObject({ data: { will_charge: false } });
  });

  it('the card removed: the push sends the no-card copy', async () => {
    const w = world();
    const id = await recordNotice(w);
    duringPrefs(w, () => (w.purchase().card_on_file = false));
    await w.noticeSvc.deliver(id, NOW);
    expect(w.notifications.pushToUser.mock.calls[0][2]).toBe(NO_CARD);
  });

  it('email: an extension committed during the email claim is not mailed on the old date', async () => {
    const w = world({ muted: true });
    const id = await recordNotice(w);
    const claim = w.notices.updateMany;
    w.notices.updateMany = async (args: Parameters<typeof claim>[0]) => {
      if (typeof args.data.email_lease_token === 'string') w.purchase().trial_ends_at = EXTENDED;
      return claim(args);
    };
    await w.noticeSvc.deliver(id, NOW);
    expect(w.email.send).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ email_status: 'skipped', email_attempts: 0 });
  });
});

describe('B-673-1 (round 9) — an owed retry reads Stripe before it cancels', () => {
  const codes = () =>
    jest
      .mocked(Sentry.captureMessage)
      .mock.calls.map((c) => (c[1] as { tags?: { code?: string } } | undefined)?.tags?.code);
  async function owed(remote?: Record<string, unknown>) {
    const w = world({ purchase: { entitlement_active: false } });
    trialAlreadyStartedElsewhere(w);
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    const sub = stub<StripeSubscriptionObject>(trialSub(remote));
    if (remote) jest.mocked(w.stripe.retrieveSubscription).mockResolvedValue(sub);
    return w;
  }
  const active = trialSub({ status: 'active', trial_end: epoch(NOW) });

  it('billed with its active webhook missing: no cancel, superseded, one billed alert; the late event grants access', async () => {
    const w = await owed({ status: 'active', trial_end: epoch(NOW) });
    expect(await w.conflictSvc.settle('pur-1')).toBe('superseded');
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    expect(w.conflicts.rows[0]).toMatchObject({
      status: 'superseded',
      last_error: 'billing_started',
      lease_token: null,
    });
    await w.conflictSvc.sweep();
    await w.handler.handle(event('customer.subscription.updated', active, 'evt_9'), w.tx);
    await w.conflictSvc.sweep();
    expect(w.purchase().entitlement_active).toBe(true);
    expect(codes()).toEqual(['TRIAL_CONFLICT_SUPERSEDED']);
  });

  it('an unknown Stripe state (read failed, or unrecognised) cancels nothing and stays owed', async () => {
    const w = await owed({ status: 'mystery' });
    jest
      .mocked(w.stripe.retrieveSubscription)
      .mockRejectedValueOnce(new StripeConnectApiError('down', 503, null, 'api_error'));
    expect(await w.conflictSvc.settle('pur-1')).toBe('retry');
    expect(w.conflicts.rows[0].last_error).toBe('http_503');
    expect(await w.conflictSvc.settle('pur-1')).toBe('retry');
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    expect(w.conflicts.rows[0]).toMatchObject({ status: 'owed', last_error: 'state_unknown' });
  });

  it.each([
    ['canceled', 'cancelled', 'already_cancelled', 0],
    ['past_due', 'cancelled', null, 1],
  ])('Stripe says %s: %s', async (status, outcome, code, deletes) => {
    const w = await owed({ status });
    expect(await w.conflictSvc.settle('pur-1')).toBe(outcome);
    expect(w.cancelSubscription).toHaveBeenCalledTimes(deletes);
    expect(w.conflicts.rows[0]).toMatchObject({ status: outcome, last_error: code });
  });

  it('the trial ends before a cancel can land, and the webhook supersedes meanwhile: no cancel, stale', async () => {
    const w = await owed();
    jest.mocked(w.stripe.retrieveSubscription).mockImplementationOnce(async () => {
      await w.handler.handle(event('customer.subscription.updated', active, 'evt_9'), w.tx);
      return stub<StripeSubscriptionObject>(trialSub());
    });
    expect(await w.conflictSvc.settle('pur-1', new Date(TRIAL_END.getTime() - 10_000))).toBe(
      'stale',
    );
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    expect(w.conflicts.rows[0].status).toBe('superseded');
    expect(w.purchase().entitlement_active).toBe(true);
  });

  it('C-673-2: a row reached late in a slow sweep holds a fresh lease; a replica stays out', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      jest.setSystemTime(NOW);
      const table = makeTrialConflictTable();
      for (let i = 0; i < 8; i += 1) {
        await table.createMany({
          data: [
            { purchase_id: `p-${i}`, stripe_subscription_id: `sub-${i}`, next_attempt_at: NOW },
          ],
        });
      }
      const held = deferred<{ id: string; status: string }>();
      let late = 0;
      const stripe = stub<StripeConnectApiService>({
        retrieveSubscription: jest.fn(async (id: string) => trialSub({ id })),
        // Seven nine-second cancels, each under both transport bounds.
        cancelSubscription: jest.fn(async (id: string) => {
          if (id !== 'sub-7') jest.setSystemTime(Date.now() + 9000);
          else if (++late === 1) return held.promise;
          return { id, status: 'canceled' };
        }),
      });
      const db = stub<ConstructorParameters<typeof TrialConflictService>[0]>({
        packageTrialConflict: table,
      });
      const sweep = new TrialConflictService(db, stripe).sweep(NOW);
      for (let i = 0; i < 200 && late === 0; i += 1) await new Promise((r) => setImmediate(r));
      jest.setSystemTime(Date.now() + 5000);
      expect(await new TrialConflictService(db, stripe).settle('p-7')).toBe('busy');
      held.resolve({ id: 'sub-7', status: 'canceled' });
      await sweep;
      expect(late).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
