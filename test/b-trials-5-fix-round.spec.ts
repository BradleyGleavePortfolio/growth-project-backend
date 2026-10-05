// B-TR5-119 (agent 119) — trials T4: the regressions for fix round 11 of
// T3 #673 (tests only; the fix lives in that piece).
//
// Every test below except the controls fails on T3 904b9642 and passes after:
//   Sol B-673-1 (narrowed) / Opus C-673-6  a complete paid-invoice page
//                captured before the first regular payment succeeded arrived
//                after it (the active webhook delayed), so the worker DELETEd
//                a plan that had just paid 4,900 minor units. Now a
//                never-billed past_due/unpaid cancel reads the open invoices
//                before the paid list, voids every open invoice (each
//                confirmed void, all inside the lease budget) and re-checks
//                ownership before the DELETE; a payment that won makes its
//                void fail, and a failed, unconfirmed or unknown settlement
//                sends no DELETE (retried; the next read supersedes a paid
//                plan).
//   Sol C-673-7  a negative or NaN amount_paid, or a missing total, proved
//                that nothing was charged.
// Real TrialConflictService (+ real CheckoutWebhookHandlerService for Sol's
// probe) + real StripeConnectApiService over an intercepted fetch.
import * as Sentry from '@sentry/node';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import {
  TrialConflictService,
  trialPaidHistory,
} from '../src/packages/trials/trial-conflict.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeTrialConflictTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const TRIAL_INVOICE = { id: 'in_trial', amount_paid: 0, total: 0, currency: 'usd' };
const PAID_INVOICE = { id: 'in_renewal', amount_paid: 4900, total: 4900, currency: 'usd' };
const OPEN_LIST = 'GET /invoices?subscription=sub_1&status=open&limit=100';
const PAID_LIST = 'GET /invoices?subscription=sub_1&status=paid&limit=100';
// B-TR6-119 — the uncollectible list (Sol B-673-1); routed to a complete empty page by default.
const UNC_LIST = 'GET /invoices?subscription=sub_1&status=uncollectible&limit=100';
// B-TR7-120 — the draft list (B-707-1); routed to a complete empty page.
const DRAFT_LIST = 'GET /invoices?subscription=sub_1&status=draft&limit=100';

type C = ConstructorParameters<typeof TrialConflictService>;
type Res = { status?: number; body: unknown };
type Reply = Res | (() => Promise<Res>);

let secret: string | undefined;
beforeEach(() => {
  secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_BTR5SYNTHETIC';
  jest.mocked(Sentry.captureMessage).mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = secret;
});

const sub = (status: string): Res => ({
  body: { id: 'sub_1', status, latest_invoice: 'in_renewal', trial_end: epoch(NOW) - 86400 },
});
const page = (data: unknown[], hasMore = false): Res => ({ body: { data, has_more: hasMore } });
const voided = (id: string): Res => ({ body: { id, object: 'invoice', status: 'void' } });
const notOpen: Res = {
  status: 400,
  body: { error: { type: 'invalid_request_error', code: 'invoice_not_open' } },
};

async function world(r: {
  sub: Reply;
  open?: Reply;
  uncollectible?: Reply;
  paid?: Reply;
  void?: (id: string) => Reply;
}) {
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
  const reply = async (x: Reply) => {
    const { status = 200, body } = typeof x === 'function' ? await x() : x;
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
    const voidId = /^\/invoices\/([^/?]+)\/void$/.exec(path)?.[1];
    if (method === 'POST' && voidId) return reply((r.void ?? voided)(decodeURIComponent(voidId)));
    if (path.startsWith('/invoices?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      const x =
        status === 'open'
          ? r.open
          : status === 'paid'
            ? r.paid
            : status === 'uncollectible'
              ? (r.uncollectible ?? page([]))
              : status === 'draft'
                ? page([])
                : undefined;
      return reply(x ?? { status: 500, body: { error: { type: 'api_error' } } });
    }
    return reply(r.sub);
  });
  const db = stub<C[0]>({ packageTrialConflict: table });
  const service = new TrialConflictService(db, new StripeConnectApiService());
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  return {
    table,
    calls,
    db,
    service,
    deletes: () => count('DELETE'),
    voids: () => count('POST /invoices/'),
    row: () => table.rows[0],
  };
}
type World = Awaited<ReturnType<typeof world>>;

describe('Sol AUD-SOL-T23D-119 probe (exact inputs) — payment succeeds while history preparation is in flight', () => {
  it.each(['past_due', 'unpaid'])(
    '%s: do not DELETE a plan whose first regular invoice just paid while the active webhook is delayed',
    async (status) => {
      const table = makeTrialConflictTable();
      await table.createMany({
        data: [
          {
            id: 'conflict-payment',
            purchase_id: 'purchase-payment',
            stripe_subscription_id: 'sub-payment',
            next_attempt_at: NOW,
          },
        ],
      });
      const purchase: Record<string, unknown> = {
        id: 'purchase-payment',
        client_user_id: 'client-payment',
        coach_user_id: 'coach-payment',
        package_id: 'package-payment',
        stripe_subscription_id: 'sub-payment',
        billing_type: 'recurring',
        status: 'trialing',
        entitlement_active: false,
        trial_days: 7,
        trial_ends_at: new Date(NOW.getTime() - 86400000),
        amount_cents: 4900,
        currency: 'usd',
        created_at: NOW,
      };
      const rawDb = {
        packageTrialConflict: table,
        packageTrialUsage: makeTrialUsageTable(),
        clientPurchase: {
          findUnique: jest.fn(async () => ({ ...purchase })),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(purchase, data);
            return { ...purchase };
          }),
        },
        coachPackage: {
          findUnique: jest.fn(async () => ({
            id: 'package-payment',
            duration_periods: null,
          })),
        },
        $queryRaw: jest.fn(async () => []),
      };
      const db = stub<C[0]>(rawDb);
      const stripe = new StripeConnectApiService();
      const service = new TrialConflictService(db, stripe);
      const usage = new TrialUsageService(db);
      const handler = new CheckoutWebhookHandlerService(
        db,
        stripe,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        usage,
        undefined,
        service,
      );
      const tx = stub<Parameters<CheckoutWebhookHandlerService['handle']>[1]>(rawDb);
      const calls: string[] = [];
      let paidCents = 0;
      let accessBeforeDeleted: unknown;
      let paidRemote = false;
      const activeEvent = async () =>
        handler.handle(
          {
            id: 'evt-payment-active',
            type: 'customer.subscription.updated',
            data: {
              object: {
                id: 'sub-payment',
                status: 'active',
                trial_end: Math.floor(NOW.getTime() / 1000) - 86400,
                current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
              },
            },
          },
          tx,
        );
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const method = init?.method ?? 'GET';
        const path = String(url).replace(/^https:\/\/api\.stripe\.com\/v1/, '');
        calls.push(`${method} ${path}`);
        let body: unknown;
        if (path.startsWith('/invoices?')) {
          const captured = {
            data: [{ id: 'in-trial', amount_paid: 0, total: 0 }],
            has_more: false,
          };
          paidCents = 4900;
          paidRemote = true;
          body = captured;
        } else if (method === 'POST' && path.endsWith('/void')) {
          return new Response(
            JSON.stringify({
              error: { type: 'invalid_request_error', code: 'invoice_not_open' },
            }),
            { status: 400 },
          );
        } else if (method === 'DELETE') {
          await activeEvent();
          accessBeforeDeleted = purchase.entitlement_active;
          await handler.handle(
            {
              id: 'evt-payment-deleted',
              type: 'customer.subscription.deleted',
              data: { object: { id: 'sub-payment' } },
            },
            tx,
          );
          body = { id: 'sub-payment', status: 'canceled' };
        } else {
          body = {
            id: 'sub-payment',
            status: paidRemote ? 'active' : status,
            latest_invoice: 'in-first-open',
            trial_end: Math.floor(NOW.getTime() / 1000) - 86400,
          };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const outcome = await service.settle('purchase-payment', NOW);
      expect(paidCents).toBe(4900);
      expect(calls.some((c) => c.startsWith('GET /invoices?'))).toBe(true);
      const deleted = calls.filter((c) => c.startsWith('DELETE'));
      if (deleted.length) {
        expect(accessBeforeDeleted).toBe(true);
        expect(purchase.entitlement_active).toBe(false);
      }
      expect({
        deleted,
        outcome,
        conflict: table.rows[0].status,
        entitlement: purchase.entitlement_active,
      }).toMatchObject({ deleted: [] });
      // B-TR5-119 — and the plan stays owed for the next read (no DELETE sent).
      expect({ outcome, conflict: table.rows[0].status }).toEqual({
        outcome: 'retry',
        conflict: 'owed',
      });
      // The next attempt reads the paid plan: superseded, never cancelled.
      table.rows[0].next_attempt_at = NOW;
      await activeEvent();
      expect(table.rows[0].status).toBe('superseded');
      expect(purchase.entitlement_active).toBe(true);
    },
  );
});

describe('B-673-1 (round 11) — a never-billed past_due/unpaid cancel voids every open invoice first', () => {
  it.each(['past_due', 'unpaid'])(
    '%s never billed: open list, paid list, confirmed void, one DELETE, in that order',
    async (status) => {
      const w = await world({
        sub: sub(status),
        open: page([{ id: 'in_renewal' }]),
        paid: page([TRIAL_INVOICE]),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
      expect(w.calls).toEqual([
        'GET /subscriptions/sub_1',
        DRAFT_LIST,
        OPEN_LIST,
        UNC_LIST,
        PAID_LIST,
        'POST /invoices/in_renewal/void',
        // B-TR7-120 — the recheck before the DELETE (in_renewal is void: not new).
        DRAFT_LIST,
        OPEN_LIST,
        UNC_LIST,
        PAID_LIST,
        'DELETE /subscriptions/sub_1',
      ]);
      expect(w.row()).toMatchObject({ status: 'cancelled', last_error: null, lease_token: null });
    },
  );

  it.each(['past_due', 'unpaid'])(
    '%s: the payment wins the void (invoice_not_open): no DELETE, retried; the next read supersedes the paid plan once',
    async (status) => {
      let remote = status;
      const w = await world({
        sub: async () => sub(remote),
        open: page([{ id: 'in_renewal' }]),
        paid: async () =>
          page(remote === 'active' ? [TRIAL_INVOICE, PAID_INVOICE] : [TRIAL_INVOICE]),
        void: () => async () => {
          remote = 'active';
          return notOpen;
        },
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('retry');
      expect(w.deletes()).toBe(0);
      expect(w.row()).toMatchObject({
        status: 'owed',
        last_error: 'invoice_not_voided',
        lease_token: null,
      });
      w.row().next_attempt_at = NOW;
      expect(await w.service.settle('pur-1', new Date(NOW.getTime() + 600_000))).toBe('superseded');
      expect(w.deletes()).toBe(0);
      expect(await w.service.alertSuperseded()).toBe(1);
      expect(await w.service.alertSuperseded()).toBe(0);
    },
  );

  it('the open list is read before the paid list: a payment between the two reads shows as paid', async () => {
    let paidNow = false;
    const w = await world({
      sub: sub('past_due'),
      open: async () => {
        paidNow = true; // the first regular invoice pays right after the open read
        return page([{ id: 'in_renewal' }]);
      },
      paid: async () => page(paidNow ? [TRIAL_INVOICE, PAID_INVOICE] : [TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('superseded');
    expect(w.deletes()).toBe(0);
    expect(w.voids()).toBe(0);
  });

  it.each<[string, Res]>([
    ['paid', { body: { id: 'in_renewal', status: 'paid' } }],
    ['still open', { body: { id: 'in_renewal', status: 'open' } }],
    ['uncollectible', { body: { id: 'in_renewal', status: 'uncollectible' } }],
    ['a body without status', { body: { id: 'in_renewal' } }],
    ['a failed void (503)', { status: 503, body: { error: { type: 'api_error' } } }],
    [
      'a 404 on the void (never read as already cancelled)',
      { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } },
    ],
  ])('a void answered %s is not a confirmed void: no DELETE, stays owed', async (_n, res) => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_renewal' }]),
      paid: page([TRIAL_INVOICE]),
      void: () => res,
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toBe(1);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', last_error: 'invoice_not_voided' });
  });

  it.each<[string, Res]>([
    ['an incomplete page (has_more)', page([{ id: 'in_renewal' }], true)],
    ['an empty page (a past_due plan always owes an invoice)', page([])],
    ['a malformed list (no data array)', { body: { object: 'list' } }],
    ['an invoice without a string id', page([{ id: 42 }])],
    ['a failed list (503)', { status: 503, body: { error: { type: 'api_error' } } }],
    [
      'a 404 on the list (never read as already cancelled)',
      { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } },
    ],
  ])('open invoices unknown (%s): no void, no DELETE, stays owed', async (_n, open) => {
    const w = await world({ sub: sub('unpaid'), open, paid: page([TRIAL_INVOICE]) });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toBe(0);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({
      status: 'owed',
      last_error: 'invoices_unknown',
      lease_token: null,
    });
  });

  // B-TR6-119 — the lease is renewed (compare-and-set) before each void and
  // before the DELETE, so two open invoices settle (round 11 refused them).
  it('lease renewed per void: two open invoices are both confirmed void, then one DELETE', async () => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_a' }, { id: 'in_b' }]),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls.slice(-7)).toEqual([
      'POST /invoices/in_a/void',
      'POST /invoices/in_b/void',
      DRAFT_LIST,
      OPEN_LIST,
      UNC_LIST,
      PAID_LIST,
      'DELETE /subscriptions/sub_1',
    ]);
  });

  it('three unsettled attempts alert support once (cancel still failing); never a DELETE', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_renewal' }]),
      paid: page([TRIAL_INVOICE]),
      void: () => notOpen,
    });
    for (let i = 0; i < 4; i += 1) {
      w.row().next_attempt_at = NOW;
      expect(await w.service.settle('pur-1', new Date(NOW.getTime() + i * 3_600_000))).toBe(
        'retry',
      );
    }
    expect(w.deletes()).toBe(0);
    const codes = jest
      .mocked(Sentry.captureMessage)
      .mock.calls.map((c) => (c[1] as { tags?: { code?: string } } | undefined)?.tags?.code);
    expect(codes).toEqual(['TRIAL_CONFLICT_CANCEL_FAILING']);
  });

  it('control: a trialing plan far from its end reads no invoices, voids nothing, cancels once', async () => {
    const w = await world({
      sub: { body: { id: 'sub_1', status: 'trialing', trial_end: epoch(NOW) + 86400 } },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls).toEqual(['GET /subscriptions/sub_1', 'DELETE /subscriptions/sub_1']);
  });
});

describe('B-673-1 (round 11) — a change committed during every added await vetoes the DELETE', () => {
  const cases: Array<[string, (w: World) => Promise<void> | void, string]> = [
    [
      'a supersession (the void-driven active webhook)',
      async (w) => {
        await w.service.supersede(w.db, 'pur-1', NOW);
      },
      'superseded',
    ],
    [
      'a subscription-deleted webhook',
      async (w) => {
        await w.service.markCancelled(w.db, 'pur-1', NOW);
      },
      'cancelled',
    ],
    [
      'another worker taking the lease',
      (w) => {
        w.row().lease_token = 'other-worker';
        w.row().lease_until = new Date(NOW.getTime() + 120_000);
      },
      'owed',
    ],
  ];

  it.each(cases)('%s during the void: stale, no DELETE', async (_n, change, after) => {
    let w!: World;
    w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_renewal' }]),
      paid: page([TRIAL_INVOICE]),
      void: (id) => async () => {
        await change(w);
        return voided(id);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row().status).toBe(after);
    if (after === 'owed') expect(w.row().lease_token).toBe('other-worker');
  });

  it.each(cases)(
    '%s during the open-invoice read: stale, no void, no DELETE',
    async (_n, change, after) => {
      let w!: World;
      w = await world({
        sub: sub('unpaid'),
        open: async () => {
          await change(w);
          return page([{ id: 'in_renewal' }]);
        },
        paid: page([TRIAL_INVOICE]),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('stale');
      expect(w.voids()).toBe(0);
      expect(w.deletes()).toBe(0);
      expect(w.row().status).toBe(after);
    },
  );
});

describe('C-673-7 (round 11) — malformed amounts never prove that nothing was charged', () => {
  it.each([
    { amount_paid: -1, total: 0 },
    { amount_paid: 0 },
    { amount_paid: Number.NaN, total: 0 },
    { amount_paid: 0, total: -100 },
    { amount_paid: '0', total: 0 },
  ])('%p reads unknown', (invoice) => {
    expect(trialPaidHistory({ data: [invoice], has_more: false })).toBe('unknown');
  });

  it('controls: a $0 complete page is none, an incomplete one unknown, any charge charged', () => {
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: 0 }], has_more: false })).toBe(
      'none',
    );
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: 0 }], has_more: true })).toBe(
      'unknown',
    );
    expect(trialPaidHistory({ data: [{ amount_paid: 4900, total: 4900 }], has_more: true })).toBe(
      'charged',
    );
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: 4900 }], has_more: false })).toBe(
      'charged',
    );
    expect(trialPaidHistory({ data: [{ amount_paid: 500 }], has_more: false })).toBe('charged');
  });
});
