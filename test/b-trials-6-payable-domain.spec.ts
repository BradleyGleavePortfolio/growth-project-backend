// B-TR6-119 (agent 119) — trials T5: the payable invoice domain of a
// never-billed past_due/unpaid trial-conflict cancel (Sol B-673-1, narrowed at
// #673 dcf095b8, comment 5985038558).
//
// Before: only status=open invoices were voided. An older uncollectible
// invoice is still payable (Stripe: uncollectible -> paid | void); it could
// pay 4,900 minor units after the paid list was captured while the open one
// was voided, and the worker DELETEd the paid plan (paid access lost).
// Now: complete open AND uncollectible pages are read before the paid list,
// every member is voided (each confirmed void) before the DELETE, the lease
// is renewed by compare-and-set before each void and before the DELETE, and
// any unknown list, unconfirmed void or ownership change sends no DELETE.
//
// Every test below except the controls fails on #706 3d95f96e and passes
// after. Real TrialConflictService (+ the real CheckoutWebhookHandlerService
// for Sol's probe) + the real StripeConnectApiService over an intercepted fetch.
import * as Sentry from '@sentry/node';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { TrialConflictService } from '../src/packages/trials/trial-conflict.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeTrialConflictTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const TRIAL_INVOICE = { id: 'in_trial', amount_paid: 0, total: 0 };
const OLD_PAID = { id: 'in_old', amount_paid: 4900, total: 4900 };
const OPEN_LIST = 'GET /invoices?subscription=sub_1&status=open&limit=100';
const UNC_LIST = 'GET /invoices?subscription=sub_1&status=uncollectible&limit=100';
const PAID_LIST = 'GET /invoices?subscription=sub_1&status=paid&limit=100';
// B-TR7-120 — the draft list (B-707-1); a complete empty page here.
const DRAFT_LIST = 'GET /invoices?subscription=sub_1&status=draft&limit=100';

type C = ConstructorParameters<typeof TrialConflictService>;
type Res = { status?: number; body: unknown };
type Reply = Res | (() => Promise<Res>);

let secret: string | undefined;
let skewMs = 0;
beforeEach(() => {
  secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_BTR6SYNTHETIC';
  jest.mocked(Sentry.captureMessage).mockClear();
  skewMs = 0;
  const realNow = Date.now.bind(Date);
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = secret;
});

const sub = (status: string): Res => ({
  body: { id: 'sub_1', status, latest_invoice: 'in_open', trial_end: epoch(NOW) - 86400 },
});
const page = (data: unknown[], hasMore = false): Res => ({ body: { data, has_more: hasMore } });
const voided = (id: string): Res => ({ body: { id, object: 'invoice', status: 'void' } });
const notOpen: Res = {
  status: 400,
  body: { error: { type: 'invalid_request_error', code: 'invoice_not_open' } },
};
const apiError: Res = { status: 500, body: { error: { type: 'api_error' } } };

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
          : status === 'uncollectible'
            ? r.uncollectible
            : status === 'paid'
              ? r.paid
              : status === 'draft'
                ? page([])
                : undefined;
      return reply(x ?? apiError);
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
    voids: () => calls.filter((c) => c.startsWith('POST /invoices/')),
    row: () => table.rows[0],
  };
}
type World = Awaited<ReturnType<typeof world>>;

describe('Sol AUD-SOL-T3E-119 probe (exact inputs) — a different payable invoice pays after the snapshot', () => {
  it.each([
    ['past_due', 'open'],
    ['unpaid', 'open'],
    ['past_due', 'uncollectible'],
    ['unpaid', 'uncollectible'],
  ])(
    '%s / %s: preserve a paid plan while the active webhook is delayed',
    async (status, payingStatus) => {
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
          findUnique: jest.fn(async () => ({ id: 'package-payment', duration_periods: null })),
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
      const voidedIds: string[] = [];
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
          const queryStatus = new URLSearchParams(path.split('?')[1]).get('status');
          if (queryStatus === 'open') {
            body = { data: [{ id: 'in-new-open', status: 'open' }], has_more: false };
          } else if (queryStatus === 'uncollectible') {
            body = {
              data:
                payingStatus === 'uncollectible'
                  ? [{ id: 'in-old-uncollectible', status: 'uncollectible' }]
                  : [],
              has_more: false,
            };
          } else if (queryStatus === 'draft') {
            body = { data: [], has_more: false }; // B-TR7-120: no draft here
          } else if (queryStatus === 'paid') {
            // Prepared before the first positive payment, which succeeds on
            // the still-payable invoice before delivery.
            body = { data: [{ id: 'in-trial', amount_paid: 0, total: 0 }], has_more: false };
            paidCents = 4900;
            paidRemote = true;
          } else {
            throw new Error(`unexpected invoice status filter ${queryStatus}`);
          }
        } else if (method === 'POST' && path.endsWith('/void')) {
          const invoiceId = path.split('/')[2];
          const paymentWonThisInvoice =
            payingStatus === 'open' || invoiceId === 'in-old-uncollectible';
          if (paymentWonThisInvoice) {
            return new Response(
              JSON.stringify({
                error: { type: 'invalid_request_error', code: 'invoice_not_open' },
              }),
              { status: 400 },
            );
          }
          voidedIds.push(invoiceId);
          body = { id: invoiceId, status: 'void' };
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
            latest_invoice: 'in-new-open',
            trial_end: Math.floor(NOW.getTime() / 1000) - 86400,
          };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const outcome = await service.settle('purchase-payment', NOW);
      expect(paidCents).toBe(4900);
      expect(calls.filter((c) => c.startsWith('GET /invoices?'))).toEqual(
        expect.arrayContaining([
          'GET /invoices?subscription=sub-payment&status=open&limit=100',
          'GET /invoices?subscription=sub-payment&status=paid&limit=100',
        ]),
      );
      const deleted = calls.filter((c) => c.startsWith('DELETE'));
      expect({ deleted, outcome, conflict: table.rows[0].status }).toMatchObject({
        deleted: [],
        outcome: 'retry',
        conflict: 'owed',
      });
      expect(accessBeforeDeleted).toBeUndefined();
      // The delayed active webhook then lands: paid access stays.
      await activeEvent();
      expect(purchase.entitlement_active).toBe(true);
    },
  );
});

describe('B-673-1 (T5) — the payable domain is open AND uncollectible, read before the paid list', () => {
  it.each(['past_due', 'unpaid'])(
    '%s never billed: draft, open, uncollectible, paid lists, both confirmed void, recheck, one DELETE',
    async (status) => {
      const w = await world({
        sub: sub(status),
        open: page([{ id: 'in_open' }]),
        uncollectible: page([{ id: 'in_unc' }]),
        paid: page([TRIAL_INVOICE]),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
      expect(w.calls).toEqual([
        'GET /subscriptions/sub_1',
        DRAFT_LIST,
        OPEN_LIST,
        UNC_LIST,
        PAID_LIST,
        'POST /invoices/in_open/void',
        'POST /invoices/in_unc/void',
        DRAFT_LIST,
        OPEN_LIST,
        UNC_LIST,
        PAID_LIST,
        'DELETE /subscriptions/sub_1',
      ]);
      expect(w.row()).toMatchObject({ status: 'cancelled', last_error: null, lease_token: null });
    },
  );

  it('unpaid whose only payable invoice is uncollectible: voided, then one DELETE', async () => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([]),
      uncollectible: page([{ id: 'in_unc' }]),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.voids()).toEqual(['POST /invoices/in_unc/void']);
    expect(w.deletes()).toBe(1);
  });

  it('a payment on the uncollectible invoice between its read and the paid read shows as paid: superseded, no void', async () => {
    let paidNow = false;
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_open' }]),
      uncollectible: async () => {
        paidNow = true;
        return page([{ id: 'in_old' }]);
      },
      paid: async () => page(paidNow ? [TRIAL_INVOICE, OLD_PAID] : [TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('superseded');
    expect(w.voids()).toEqual([]);
    expect(w.deletes()).toBe(0);
    expect(await w.service.alertSuperseded()).toBe(1);
  });

  it.each<[string, Reply]>([
    ['500', apiError],
    ['404', { status: 404, body: { error: { type: 'invalid_request_error' } } }],
    ['has_more', page([{ id: 'in_unc' }], true)],
    ['has_more missing', { body: { data: [{ id: 'in_unc' }] } }],
    ['data not a list', { body: { data: null, has_more: false } }],
    ['null entry', page([null])],
    ['numeric id', page([{ id: 7 }])],
    ['empty id', page([{ id: '' }])],
  ])(
    'uncollectible list unknown (%s): no void, no DELETE, stays owed',
    async (_n, uncollectible) => {
      const w = await world({
        sub: sub('past_due'),
        open: page([{ id: 'in_open' }]),
        uncollectible,
        paid: page([TRIAL_INVOICE]),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('retry');
      expect(w.calls).toContain(UNC_LIST);
      expect(w.voids()).toEqual([]);
      expect(w.deletes()).toBe(0);
      expect(w.row()).toMatchObject({
        status: 'owed',
        last_error: 'invoices_unknown',
        lease_token: null,
      });
    },
  );

  it.each<[string, Res]>([
    ['payment won (invoice_not_open)', notOpen],
    ['200 but paid', { body: { id: 'in_unc', status: 'paid' } }],
    ['200 but uncollectible', { body: { id: 'in_unc', status: 'uncollectible' } }],
    ['500', apiError],
  ])(
    'the uncollectible void is not confirmed (%s): no DELETE, retried',
    async (_n, unconfirmed) => {
      const w = await world({
        sub: sub('unpaid'),
        open: page([{ id: 'in_open' }]),
        uncollectible: page([{ id: 'in_unc' }]),
        paid: page([TRIAL_INVOICE]),
        void: (id) => (id === 'in_unc' ? unconfirmed : voided(id)),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('retry');
      expect(w.deletes()).toBe(0);
      expect(w.row()).toMatchObject({
        status: 'owed',
        last_error: 'invoice_not_voided',
        lease_token: null,
      });
    },
  );

  it('more than 10 payable invoices is not a never-billed trial: no void, no DELETE, retried', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `in_${i}` }));
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page(many.slice(1)),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toEqual([]);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', last_error: 'invoices_too_many' });
  });
});

describe('B-673-1 (T5) — the lease is renewed by compare-and-set before each void and the DELETE', () => {
  it('three payable invoices after 35 s of reads all settle; a second worker mid-sequence is busy', async () => {
    let w!: World;
    const second: string[] = [];
    w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_a' }]),
      uncollectible: page([{ id: 'in_b' }, { id: 'in_c' }]),
      paid: async () => {
        skewMs = 35_000;
        return page([TRIAL_INVOICE]);
      },
      void: (id) => async () => {
        skewMs += 15_000;
        if (id === 'in_c')
          second.push(await w.service.settle('pur-1', new Date(NOW.getTime() + 75_000)));
        return voided(id);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.voids()).toEqual([
      'POST /invoices/in_a/void',
      'POST /invoices/in_b/void',
      'POST /invoices/in_c/void',
    ]);
    expect(w.deletes()).toBe(1);
    expect(second).toEqual(['busy']);
  });

  it('a renewal whose round trip outlives the next call budget: lease_exhausted, no further void, no DELETE', async () => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([{ id: 'in_unc' }]),
      paid: page([TRIAL_INVOICE]),
    });
    const cas = w.table.updateMany.bind(w.table);
    let renewals = 0;
    jest.spyOn(w.table, 'updateMany').mockImplementation(async (args) => {
      const keys = Object.keys((args as { data: Record<string, unknown> }).data);
      if (keys.length === 1 && keys[0] === 'lease_until' && ++renewals === 2) skewMs = 45_000;
      return cas(args);
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toEqual(['POST /invoices/in_open/void']);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({
      status: 'owed',
      last_error: 'lease_exhausted',
      lease_token: null,
    });
  });

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

  it.each(cases)(
    '%s during the uncollectible void: stale, no DELETE',
    async (_n, change, after) => {
      let w!: World;
      w = await world({
        sub: sub('past_due'),
        open: page([{ id: 'in_open' }]),
        uncollectible: page([{ id: 'in_unc' }]),
        paid: page([TRIAL_INVOICE]),
        void: (id) => async () => {
          if (id === 'in_unc') await change(w);
          return voided(id);
        },
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('stale');
      expect(w.voids()).toEqual(['POST /invoices/in_open/void', 'POST /invoices/in_unc/void']);
      expect(w.deletes()).toBe(0);
      expect(w.row().status).toBe(after);
      if (after === 'owed') expect(w.row().lease_token).toBe('other-worker');
    },
  );

  it.each(cases)(
    '%s during the uncollectible read: stale, no void, no DELETE',
    async (_n, change, after) => {
      let w!: World;
      w = await world({
        sub: sub('unpaid'),
        open: page([{ id: 'in_open' }]),
        uncollectible: async () => {
          await change(w);
          return page([{ id: 'in_unc' }]);
        },
        paid: page([TRIAL_INVOICE]),
      });
      expect(await w.service.settle('pur-1', NOW)).toBe('stale');
      expect(w.voids()).toEqual([]);
      expect(w.deletes()).toBe(0);
      expect(w.row().status).toBe(after);
    },
  );
});

describe('controls (green before and after)', () => {
  it('an id on both pages is voided once', async () => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_x' }]),
      uncollectible: page([{ id: 'in_x' }]),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.voids()).toEqual(['POST /invoices/in_x/void']);
  });

  it('a payment on the open invoice wins its void: no DELETE, the next read supersedes', async () => {
    let remote = 'past_due';
    const w = await world({
      sub: async () => sub(remote),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([]),
      paid: async () => page(remote === 'active' ? [TRIAL_INVOICE, OLD_PAID] : [TRIAL_INVOICE]),
      void: () => async () => {
        remote = 'active';
        return notOpen;
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.deletes()).toBe(0);
    w.row().next_attempt_at = NOW;
    expect(await w.service.settle('pur-1', new Date(NOW.getTime() + 600_000))).toBe('superseded');
    expect(w.deletes()).toBe(0);
  });

  it('a trialing plan far from its end reads no invoices and cancels once', async () => {
    const w = await world({
      sub: { body: { id: 'sub_1', status: 'trialing', trial_end: epoch(NOW) + 86400 } },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls).toEqual(['GET /subscriptions/sub_1', 'DELETE /subscriptions/sub_1']);
  });
});
