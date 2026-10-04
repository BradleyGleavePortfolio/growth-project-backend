// B-TR4-119 (agent 119) — trials T4: the regressions for fix round 10 of
// T2 #672 and T3 #673 (tests only; the fixes live in those pieces).
//
// Every block below fails on T3 5fdb5f5c (T2 2690c07c) and passes after:
//   Sol B-672-3  the customer card was read before the purchase, so a card
//                removed (or added) during the final purchase read was sent on
//                the old copy ("Your card will be charged $49 then").
//   Sol B-673-1  past_due/unpaid were read as never billed: a plan that paid
//                its first regular invoice and then fell past_due was DELETEd.
//                Now only a complete paid-invoice page with no charge on it
//                allows the cancel; any charge supersedes (paid plan kept, one
//                billed alert); missing, partial or failed evidence retries.
//   Sol B-673-2  a supersession, cancellation or lease takeover committed
//                while the worker read Stripe did not veto the DELETE.
// Real TrialConflictService + real StripeConnectApiService over an
// intercepted fetch; real TrialNoticeService over constraint-aware fakes.
import * as Sentry from '@sentry/node';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { TrialConflictService } from '../src/packages/trials/trial-conflict.service';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { makeTable, makeTrialConflictTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const END = new Date('2026-10-12T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const TRIAL_INVOICE = { id: 'in_trial', amount_paid: 0, total: 0, currency: 'usd' };
const PAID_INVOICE = { id: 'in_first', amount_paid: 4900, total: 4900, currency: 'usd' };

type C = ConstructorParameters<typeof TrialConflictService>;
type Reply =
  { status?: number; body: unknown } | (() => Promise<{ status?: number; body: unknown }>);

let secret: string | undefined;
beforeEach(() => {
  secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_BTR4SYNTHETIC';
  jest.mocked(Sentry.captureMessage).mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = secret;
});

const sentryCodes = () =>
  jest
    .mocked(Sentry.captureMessage)
    .mock.calls.map((c) => (c[1] as { tags?: { code?: string } } | undefined)?.tags?.code);

async function conflictWorld(replies: { sub: Reply; invoices?: Reply }) {
  const table = makeTrialConflictTable();
  await table.createMany({
    data: [
      {
        id: 'conflict-1',
        purchase_id: 'pur-1',
        stripe_subscription_id: 'sub_1',
        next_attempt_at: NOW,
      },
    ],
  });
  const calls: string[] = [];
  const reply = async (r: Reply) => {
    const { status = 200, body } = typeof r === 'function' ? await r() : r;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = String(url).replace(/^https:\/\/api\.stripe\.com\/v1/, '');
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') return reply({ body: { id: 'sub_1', status: 'canceled' } });
    // B-TR5-119 — the open invoice a never-billed cancel voids first, and its void.
    if (method === 'POST') return reply({ body: { id: 'in_renewal', status: 'void' } });
    if (path.includes('status=open')) return reply(page([{ id: 'in_renewal' }]));
    if (path.startsWith('/invoices')) {
      return reply(replies.invoices ?? { status: 500, body: { error: { type: 'api_error' } } });
    }
    return reply(replies.sub);
  });
  const db = stub<C[0]>({ packageTrialConflict: table });
  const service = new TrialConflictService(db, new StripeConnectApiService());
  const deletes = () => calls.filter((c) => c.startsWith('DELETE')).length;
  return { table, calls, db, service, deletes, row: () => table.rows[0] };
}

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  body: {
    id: 'sub_1',
    status,
    latest_invoice: 'in_renewal',
    trial_end: epoch(NOW) - 40 * 86400,
    ...over,
  },
});
const page = (data: unknown[], hasMore = false) => ({ body: { data, has_more: hasMore } });

describe('B-673-1 (round 10) — past_due/unpaid cancel only on proof that nothing was ever charged', () => {
  it.each(['past_due', 'unpaid'])(
    '%s after a paid first invoice: no DELETE, superseded, exactly one billed alert',
    async (status) => {
      const w = await conflictWorld({
        sub: sub(status),
        invoices: page([TRIAL_INVOICE, PAID_INVOICE]),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('superseded');
      expect(w.deletes()).toBe(0);
      expect(w.row()).toMatchObject({
        status: 'superseded',
        last_error: 'billing_started',
        lease_token: null,
      });
      expect(await w.service.alertSuperseded()).toBe(1);
      expect(await w.service.alertSuperseded()).toBe(0);
      await w.service.sweep(NOW);
      expect(sentryCodes()).toEqual(['TRIAL_CONFLICT_SUPERSEDED']);
    },
  );

  it.each([
    [
      'a zero-decimal currency (JPY 500)',
      { id: 'in_jpy', amount_paid: 500, total: 500, currency: 'jpy' },
    ],
    [
      'customer credit balance (paid 0, total 4900)',
      { id: 'in_credit', amount_paid: 0, total: 4900 },
    ],
  ])('a charge in %s counts as billed', async (_name, invoice) => {
    const w = await conflictWorld({
      sub: sub('past_due'),
      invoices: page([TRIAL_INVOICE, invoice]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('superseded');
    expect(w.deletes()).toBe(0);
  });

  it('never billed (the first regular invoice failed): one DELETE, cancelled', async () => {
    const w = await conflictWorld({ sub: sub('past_due'), invoices: page([TRIAL_INVOICE]) });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.deletes()).toBe(1);
    expect(w.row()).toMatchObject({ status: 'cancelled', last_error: null });
  });

  it('reads one bounded page of paid invoices for this subscription', async () => {
    const w = await conflictWorld({ sub: sub('unpaid'), invoices: page([TRIAL_INVOICE]) });
    await w.service.settle('pur-1', NOW);
    const list = w.calls.find((c) => c.startsWith('GET /invoices') && c.includes('status=paid'));
    expect(list).toBeDefined();
    const q = new URLSearchParams(String(list).split('?')[1]);
    expect({
      subscription: q.get('subscription'),
      status: q.get('status'),
      limit: q.get('limit'),
    }).toEqual({ subscription: 'sub_1', status: 'paid', limit: '100' });
  });

  it.each<[string, Reply]>([
    ['an incomplete page (has_more) with no charge on it', page([TRIAL_INVOICE], true)],
    ['a malformed list (no data array)', { body: { object: 'list' } }],
    ['an invoice without amount_paid', page([TRIAL_INVOICE, { id: 'in_x', total: 0 }])],
    ['a failed list (503)', { status: 503, body: { error: { type: 'api_error' } } }],
    [
      'a 404 on the list (never read as already cancelled)',
      {
        status: 404,
        body: { error: { type: 'invalid_request_error', code: 'resource_missing' } },
      },
    ],
  ])('%s: no DELETE, stays owed, retried as history_unknown', async (_name, invoices) => {
    const w = await conflictWorld({ sub: sub('past_due'), invoices });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({
      status: 'owed',
      last_error: 'history_unknown',
      lease_token: null,
    });
  });

  it('three unknown-history attempts alert support once (cancel still failing); never a DELETE', async () => {
    const w = await conflictWorld({ sub: sub('unpaid'), invoices: page([], true) });
    for (let i = 0; i < 4; i += 1) {
      w.row().next_attempt_at = NOW;
      expect(await w.service.settle('pur-1', new Date(NOW.getTime() + i * 3_600_000))).toBe(
        'retry',
      );
    }
    expect(w.deletes()).toBe(0);
    expect(sentryCodes()).toEqual(['TRIAL_CONFLICT_CANCEL_FAILING']);
  });

  it('terminal: canceled reads no invoices and sends no DELETE', async () => {
    const w = await conflictWorld({ sub: sub('canceled') });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls).toEqual(['GET /subscriptions/sub_1']);
  });
});

describe('B-673-2 (round 10) — a change committed during the reads vetoes the DELETE', () => {
  const farTrial = { body: { id: 'sub_1', status: 'trialing', trial_end: epoch(NOW) + 86400 } };
  const during =
    (change: () => Promise<void> | void, r: Reply = farTrial): Reply =>
    async () => {
      await change();
      return typeof r === 'function' ? r() : r;
    };

  it('a supersession (early paid conversion) during the GET: stale, no DELETE', async () => {
    let w!: Awaited<ReturnType<typeof conflictWorld>>;
    // Committed before Stripe's (older, still trialing) response arrives.
    w = await conflictWorld({
      sub: during(async () => {
        await w.service.supersede(w.db, 'pur-1', NOW);
      }),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row().status).toBe('superseded');
  });

  it('a subscription-deleted webhook during the GET: stale, no DELETE, the row stays cancelled', async () => {
    let w!: Awaited<ReturnType<typeof conflictWorld>>;
    w = await conflictWorld({
      sub: during(async () => {
        await w.service.markCancelled(w.db, 'pur-1', NOW);
      }),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row().status).toBe('cancelled');
  });

  it('another worker took the lease during the GET: stale, no DELETE, its lease untouched', async () => {
    let w!: Awaited<ReturnType<typeof conflictWorld>>;
    w = await conflictWorld({
      sub: during(() => {
        w.row().lease_token = 'other-worker';
        w.row().lease_until = new Date(NOW.getTime() + 120_000);
      }),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', lease_token: 'other-worker' });
  });

  it('a supersession during the paid-invoice read of a never-billed past_due plan: stale, no DELETE', async () => {
    let w!: Awaited<ReturnType<typeof conflictWorld>>;
    w = await conflictWorld({
      sub: sub('past_due'),
      invoices: during(
        async () => {
          await w.service.supersede(w.db, 'pur-1', NOW);
        },
        page([TRIAL_INVOICE]),
      ),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row().status).toBe('superseded');
  });

  it('control: an unchanged trial far from its end cancels once', async () => {
    const w = await conflictWorld({ sub: farTrial });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls).toEqual(['GET /subscriptions/sub_1', 'DELETE /subscriptions/sub_1']);
  });
});

function noticeWorld(
  opts: { muted?: boolean; cardOnFile?: boolean; customerCard?: string | null } = {},
) {
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push({
    id: 'pur-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    status: 'trialing',
    entitlement_active: true,
    card_on_file: opts.cardOnFile ?? false,
    cancel_at_period_end: false,
    trial_ends_at: END,
  });
  const notices = makeTrialNoticeTable();
  let customerCard: string | null = opts.customerCard ?? null;
  const prisma: Record<string, unknown> = {
    packageTrialNotice: notices,
    clientPurchase: {
      findMany: purchases.findMany,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = purchases.rows.find((r) => r.id === where.id);
        return p
          ? {
              ...p,
              package: { name: 'Monthly', interval: 'month', interval_count: 1 },
              coach: { name: 'Coach' },
              client: { name: 'Client', email: 'client@example.test' },
            }
          : null;
      }),
    },
    connectCustomer: {
      findUnique: jest.fn(async () => ({ default_payment_method_id: customerCard })),
    },
    notificationPreferences: {
      findUnique: jest.fn(async () => ({ timezone: 'America/New_York', timezone_updated_at: NOW })),
    },
  };
  prisma.$transaction = jest.fn(
    async (cb: (tx: unknown) => unknown, _opts?: unknown): Promise<unknown> => cb(prisma),
  );
  const notifications = {
    createNotification: jest.fn(async (input: Record<string, unknown>) => ({
      id: 'inapp',
      ...input,
    })),
    getPreferences: jest.fn(async () => ({ muted: !!opts.muted })),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
  };
  const email = { send: jest.fn(async (_input: Record<string, unknown>) => ({ status: 'sent' })) };
  const service = new TrialNoticeService(
    stub<ConstructorParameters<typeof TrialNoticeService>[0]>(prisma),
    stub<ConstructorParameters<typeof TrialNoticeService>[1]>(notifications),
    stub<ConstructorParameters<typeof TrialNoticeService>[2]>(email),
  );
  const enqueue = async () => {
    await notices.createMany({
      data: [
        {
          id: 'notice-1',
          purchase_id: 'pur-1',
          client_user_id: 'client-1',
          trial_ends_at: END,
          amount_cents: 4900,
          currency: 'usd',
          created_at: new Date(NOW.getTime() - 600_000),
        },
      ],
      skipDuplicates: true,
    });
    return 'notice-1';
  };
  /** Commit `change` during the purchase read of the given channel's admission (its claim is held). */
  const duringAdmissionRead = (channel: 'push' | 'email', change: () => void) => {
    const purchaseRead = prisma.clientPurchase as { findUnique: jest.Mock };
    const original = purchaseRead.findUnique.getMockImplementation()!;
    purchaseRead.findUnique.mockImplementation(async (args: unknown) => {
      if (typeof notices.rows[0]?.[`${channel}_lease_token`] === 'string') change();
      return original(args);
    });
  };
  const setCustomerCard = (pm: string | null) => {
    customerCard = pm;
  };
  return {
    prisma,
    notices,
    notifications,
    email,
    service,
    enqueue,
    duringAdmissionRead,
    setCustomerCard,
  };
}

describe('B-672-3 (round 10) — the purchase and the customer card come from one admission snapshot', () => {
  it('push: the only customer card removed during the final purchase read sends the no-card copy', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer' });
    const id = await w.enqueue();
    w.duringAdmissionRead('push', () => w.setCustomerCard(null));
    await w.service.deliver(id, NOW);
    expect(w.notifications.pushToUser).toHaveBeenCalledTimes(1);
    const body = String(w.notifications.pushToUser.mock.calls[0][2]);
    expect(body).not.toContain('will be charged $49');
    expect(body).toContain('nothing will be charged');
  });

  it('email: the only customer card removed during the final purchase read mails will_charge false', async () => {
    const w = noticeWorld({ muted: true, customerCard: 'pm_customer' });
    const id = await w.enqueue();
    w.duringAdmissionRead('email', () => w.setCustomerCard(null));
    await w.service.deliver(id, NOW);
    expect(w.email.send).toHaveBeenCalledTimes(1);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({ data: { will_charge: false } });
  });

  it('push: a customer card added during the final purchase read is reported truthfully', async () => {
    const w = noticeWorld({ customerCard: null });
    const id = await w.enqueue();
    w.duringAdmissionRead('push', () => w.setCustomerCard('pm_new'));
    await w.service.deliver(id, NOW);
    expect(String(w.notifications.pushToUser.mock.calls[0][2])).toContain('will be charged $49');
  });

  it('email: a customer card added during the final purchase read mails will_charge true', async () => {
    const w = noticeWorld({ muted: true, customerCard: null });
    const id = await w.enqueue();
    w.duringAdmissionRead('email', () => w.setCustomerCard('pm_new'));
    await w.service.deliver(id, NOW);
    expect(w.email.send.mock.calls[0][0]).toMatchObject({ data: { will_charge: true } });
  });

  it('every admission reads both authorities inside one REPEATABLE READ transaction', async () => {
    const w = noticeWorld({ customerCard: 'pm_customer' });
    const id = await w.enqueue();
    await w.service.deliver(id, NOW);
    const tx = w.prisma.$transaction as jest.Mock;
    const snapshots = tx.mock.calls.filter(
      (c) => (c[1] as { isolationLevel?: string } | undefined)?.isolationLevel === 'RepeatableRead',
    );
    // push and email, each prepared before its claim and again at its admission.
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(w.notices.rows[0]).toMatchObject({ push_status: 'delivered', email_status: 'sent' });
  });
});
