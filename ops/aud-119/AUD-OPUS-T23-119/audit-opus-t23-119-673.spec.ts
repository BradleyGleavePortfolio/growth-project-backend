// AUD-OPUS-T23-119 (Claude Opus 5.5 lens, agent 119) — probes on backend
// #673 @ 5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d (FIX ROUND 9, Sol B-673-1).
// Audit-only: never merge. The world() harness is copied byte-for-byte from the
// PR's own test/b-trials-3-fix-round.spec.ts (real handler, usage, notice and
// conflict services on the same fakes).
//   controls (expected green): the read decides before any DELETE —
//     K1 a read that uses up the lease room cancels nothing (lease_exhausted);
//     K2 trialing with the trial ending in 30 s cancels nothing (trial_ending),
//        backoff from the fresh clock;
//     K3 paused (nothing billed) cancels once; K4 a 404 read settles cancelled
//        with no DELETE; K5 a replica during a slow read stays out (busy);
//     K6 a subscription.deleted webhook during the read wins (stale).
//   probe C-673-4 (expected red): an out-of-order delivery (active applied
//     first, then the older trialing event) leaves a paying client with no
//     access once the worker supersedes: nothing re-syncs the purchase.
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

async function owedWorld() {
  const w = world({ purchase: { entitlement_active: false } });
  trialAlreadyStartedElsewhere(w);
  await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
  expect(w.conflicts.rows[0]).toMatchObject({ status: 'owed' });
  return w;
}
const read = (w: World) => jest.mocked(w.stripe.retrieveSubscription);
const sub = (over: Record<string, unknown> = {}) => stub<StripeSubscriptionObject>(trialSub(over));

describe('K controls — the Stripe read decides before any DELETE (Sol B-673-1 closure)', () => {
  afterEach(() => jest.useRealTimers());

  it('K1 control: a read that uses up the lease room cancels nothing', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(NOW);
    const w = await owedWorld();
    read(w).mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 41_000); // 41 s + 20 s cancel deadline > 60 s lease
      return sub({ trial_end: epoch(TRIAL_END) });
    });
    expect(await w.conflictSvc.settle('pur-1', new Date())).toBe('retry');
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    expect(w.conflicts.rows[0]).toMatchObject({ status: 'owed', last_error: 'lease_exhausted', lease_token: null });
  });

  it('K2 control: trialing with the trial ending in 30 s cancels nothing; backoff from the fresh clock', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const at = new Date(TRIAL_END.getTime() - 40_000);
    jest.setSystemTime(at);
    const w = await owedWorld();
    read(w).mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 10_000);
      return sub();
    });
    expect(await w.conflictSvc.settle('pur-1', new Date())).toBe('retry');
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    const row = w.conflicts.rows[0];
    expect(row).toMatchObject({ status: 'owed', last_error: 'trial_ending' });
    expect((row.next_attempt_at as Date).getTime()).toBe(at.getTime() + 10_000 + trialConflictBackoffMs(1));
  });

  it('K3 control: paused (nothing billed) cancels exactly once', async () => {
    const w = await owedWorld();
    read(w).mockResolvedValue(sub({ status: 'paused' }));
    expect(await w.conflictSvc.settle('pur-1')).toBe('cancelled');
    expect(w.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(await w.conflictSvc.settle('pur-1')).toBe('not_owed');
    expect(w.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('K4 control: a 404 read settles cancelled with no DELETE', async () => {
    const w = await owedWorld();
    read(w).mockRejectedValueOnce(new StripeConnectApiError('No such subscription', 404, 'resource_missing', 'invalid_request_error'));
    expect(await w.conflictSvc.settle('pur-1')).toBe('cancelled');
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    expect(w.conflicts.rows[0].status).toBe('cancelled');
  });

  it('K5 control: a replica during a slow read stays out (busy), and only one DELETE is sent', async () => {
    const w = await owedWorld();
    const gate = deferred<StripeSubscriptionObject>();
    read(w).mockImplementationOnce(() => gate.promise);
    const first = w.conflictSvc.settle('pur-1');
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    const other = new TrialConflictService(
      stub<ConstructorParameters<typeof TrialConflictService>[0]>(w.prisma),
      w.stripe,
    );
    expect(await other.settle('pur-1')).toBe('busy');
    gate.resolve(sub({ trial_end: epoch(new Date(Date.now() + 5 * 864e5)) }));
    expect(await first).toBe('cancelled');
    expect(w.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('K6 control: a subscription.deleted webhook during the read wins (stale), no double settle', async () => {
    const w = await owedWorld();
    read(w).mockImplementationOnce(async () => {
      await w.handler.handle(event('customer.subscription.deleted', trialSub({ status: 'canceled' }), 'evt_del'), w.tx);
      return sub({ status: 'canceled' });
    });
    expect(await w.conflictSvc.settle('pur-1')).toBe('stale');
    expect(w.cancelSubscription).not.toHaveBeenCalled();
    expect(w.conflicts.rows[0].status).toBe('cancelled');
  });
});

describe('C-673-4 probe — a worker supersede after out-of-order events', () => {
  it('probe (expected red): active applied first, then the older trialing event: the paying client keeps access', async () => {
    const w = world({ purchase: { entitlement_active: false, status: 'incomplete' } });
    trialAlreadyStartedElsewhere(w);
    const active = trialSub({ status: 'active', trial_end: epoch(NOW) });
    await w.handler.handle(event('customer.subscription.updated', active, 'evt_new'), w.tx);
    const accessAfterActive = w.purchase().entitlement_active;
    // Stripe retries the older trialing event after the newer one was applied.
    await w.handler.handle(event('customer.subscription.updated', trialSub(), 'evt_old'), w.tx);
    read(w).mockResolvedValue(stub<StripeSubscriptionObject>(active));
    const outcome = await w.conflictSvc.settle('pur-1');
    expect({ accessAfterActive, outcome, deletes: w.cancelSubscription.mock.calls.length }).toEqual({
      accessAfterActive: true,
      outcome: 'superseded',
      deletes: 0,
    });
    // Stripe says active and paid: the purchase must grant access again.
    expect(w.purchase().entitlement_active).toBe(true);
  });
});
