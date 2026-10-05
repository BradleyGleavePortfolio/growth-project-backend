// AUD-OPUS-T23-118 (Claude Opus 5.5 lens, agent 118) — probes on backend
// #673 @ df76889fb862095170498dccb23f35db3d116690. Audit-only: never merge.
// "probe" = asserts the safe behaviour, EXPECTED RED at this head;
// "control" = expected green. The world() helper is copied from the PR's
// own test/b-trials-notice-and-webhook.spec.ts so the real handler, the real
// TrialUsageService and the real TrialNoticeService run on the same fakes.
//   C-673-2  an older (retried) customer.subscription.updated rewrites an
//            extended trial end back and records a notice for the old date;
//   C-673-3  outside this diff: GET /coach/connect/metrics counts a started,
//            never-billed trial in MRR and its cancel in clients_churned_30d;
//   controls C-671-4 composed (invoice.paid and lost race never write
//            trial_ends_at); B-672-3 composed (trial_will_end before the
//            subscription update: retired, then reopened and sent once).
import { CoachConnectService } from '../src/coach-connect/coach-connect.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
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

const DAY = 864e5;
/** Stripe second precision, relative to the real clock the handler reads. */
const at = (ms: number) => new Date(epoch(new Date(Date.now() + ms)) * 1000);

/** The reconciler query (status trialing, access, end inside the window) over the in-memory rows. */
function withPurchaseList(w: ReturnType<typeof world>) {
  Object.assign(w.prisma.clientPurchase, {
    findMany: jest.fn(async ({ where }: { where: { AND?: Array<Record<string, unknown>> } }) => {
      const base = (where.AND?.[0] ?? {}) as {
        trial_ends_at?: { gt: Date; lte: Date };
      };
      return w.purchases.filter((p) => {
        const end = p.trial_ends_at as Date | null;
        return (
          p.status === 'trialing' &&
          p.entitlement_active === true &&
          !!end &&
          (!base.trial_ends_at ||
            (end.getTime() > base.trial_ends_at.gt.getTime() &&
              end.getTime() <= base.trial_ends_at.lte.getTime()))
        );
      });
    }),
  });
}

describe('C-673-2 probe — an older subscription event rewrites an extended trial end', () => {
  it('probe (expected red): a retried pre-extension update keeps the extended end and records no notice', async () => {
    const w = world();
    const extended = at(9 * DAY);
    const original = at(2 * DAY);
    Object.assign(w.purchases[0], { entitlement_active: true, trial_ends_at: extended });
    // The pre-extension event (created earlier) arrives last: a Stripe retry.
    const stale = {
      ...event('customer.subscription.updated', trialSub({ trial_end: epoch(original), current_period_end: epoch(original) }), 'evt_old'),
      created: epoch(new Date(Date.now() - DAY)),
    };
    const res = await w.handler.handle(stale, w.tx);
    expect(w.purchases[0].trial_ends_at).toEqual(extended);
    expect(res.deferredTrialNoticeId ?? null).toBeNull();
    expect(w.notices.rows).toHaveLength(0);
  });
});

describe('C-673-3 probe (outside this diff) — coach metrics count a never-billed trial', () => {
  function metrics(w: ReturnType<typeof world>) {
    const match = (p: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && 'gte' in (v as object)) {
          const d = p[k] as Date | null | undefined;
          return !!d && d.getTime() >= ((v as { gte: Date }).gte as Date).getTime();
        }
        if (v === null) return p[k] === null || p[k] === undefined;
        return p[k] === v;
      });
    const prisma = {
      clientPurchase: {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          w.purchases
            .filter((p) => match(p, where))
            .map((p) => ({ amount_cents: p.amount_cents, package: { interval: 'month' } })),
        ),
        count: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            w.purchases.filter((p) => match(p, where)).length,
        ),
      },
      user: { count: jest.fn(async () => 1) },
      teamSubCoachAssignment: { findMany: jest.fn(async () => []) },
    };
    const zero = { as_seller: { posted_cents: 0, refunds_cents: 0 }, as_head_coach: { posted_cents: 0 } };
    type P = ConstructorParameters<typeof CoachConnectService>;
    return new CoachConnectService(
      stub<P[0]>(prisma),
      stub<P[1]>({}),
      stub<P[2]>({}),
      stub<P[3]>({ ready: true }),
      stub<P[4]>({}),
      stub<P[5]>({ getCoachEarnings: jest.fn(async () => zero) }),
    ).getMetrics('coach-1');
  }

  it('probe (expected red): a started trial (nothing billed) adds no MRR', async () => {
    const w = world();
    Object.assign(w.purchases[0], { entitlement_active: false, trial_ends_at: null });
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchases[0]).toMatchObject({ status: 'trialing', entitlement_active: true });
    expect((await metrics(w)).mrr).toBe(0);
  });

  it('probe (expected red): a never-billed trial cancelled during the trial is not churn', async () => {
    const w = world();
    Object.assign(w.purchases[0], { entitlement_active: false, trial_ends_at: null });
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    await w.handler.handle(event('customer.subscription.deleted', { id: 'sub_1' }, 'evt_2'), w.tx);
    expect(w.purchases[0].status).toBe('canceled');
    expect((await metrics(w)).clients_churned_30d).toBe(0);
  });
});

describe('controls — C-671-4 and B-672-3 composed through the real handler', () => {
  it('control C-671-4: a $0 trial invoice without a card, then the delete, never writes a trial end', async () => {
    const w = world();
    Object.assign(w.purchases[0], { entitlement_active: false, trial_ends_at: null });
    await w.handler.handle(
      event('invoice.paid', { id: 'in_1', subscription: 'sub_1', amount_paid: 0 }),
      w.tx,
      {
        invoiceSubscription: stub<
          NonNullable<Parameters<CheckoutWebhookHandlerService['handle']>[2]>['invoiceSubscription']
        >(trialSub({ default_payment_method: null })),
      },
    );
    expect(w.purchases[0]).toMatchObject({ entitlement_active: false, trial_ends_at: null });
    expect(purchaseTrialView(w.purchases[0]).state).toBe('setup_incomplete');
    await w.handler.handle(event('customer.subscription.deleted', { id: 'sub_1' }, 'evt_2'), w.tx);
    expect(w.purchases[0]).toMatchObject({ status: 'canceled', trial_ends_at: null });
    expect(purchaseTrialView(w.purchases[0]).state).toBe('none');
  });

  it('control C-671-4: the lost race (card saved, trial already used) never writes a trial end', async () => {
    const w = world();
    Object.assign(w.purchases[0], { entitlement_active: false, trial_ends_at: null });
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
    await w.handler.handle(event('customer.subscription.updated', trialSub()), w.tx);
    expect(w.purchases[0]).toMatchObject({ entitlement_active: false, trial_ends_at: null });
    await w.handler.handle(
      event('customer.subscription.updated', trialSub({ status: 'canceled' }), 'evt_2'),
      w.tx,
    );
    expect(w.purchases[0]).toMatchObject({ status: 'canceled', trial_ends_at: null });
    expect(purchaseTrialView(w.purchases[0]).state).toBe('none');
  });

  it('control B-672-3: trial_will_end for a shortened trial before its update is retired, then sent once', async () => {
    const w = world();
    withPurchaseList(w);
    const before = at(6 * DAY);
    const after = at(2 * DAY);
    Object.assign(w.purchases[0], { entitlement_active: true, trial_ends_at: before });
    const sub = trialSub({ trial_end: epoch(after), current_period_end: epoch(after) });
    const r1 = await w.handler.handle(event('customer.subscription.trial_will_end', sub), w.tx);
    expect(r1.deferredTrialNoticeId).toEqual(expect.any(String));
    await w.handler.deliverTrialNotice(r1.deferredTrialNoticeId as string);
    expect(w.notifications.pushToUser).not.toHaveBeenCalled();
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'skipped', last_error: 'skip:trial_superseded' });
    const r2 = await w.handler.handle(event('customer.subscription.updated', sub, 'evt_2'), w.tx);
    expect(w.purchases[0].trial_ends_at).toEqual(after);
    if (r2.deferredTrialNoticeId) await w.handler.deliverTrialNotice(r2.deferredTrialNoticeId);
    await w.noticeSvc.reconcileDue();
    await w.noticeSvc.reconcileDue();
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.notices.rows).toHaveLength(1);
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'delivered', email_status: 'sent' });
  });
});
