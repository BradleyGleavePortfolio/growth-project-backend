// AUD-OPUS-T5-119 (Claude Opus 5.5 lens) — probes for #707 (T5 payable invoice domain) at ffed434e.
// Real TrialConflictService + real StripeConnectApiService over an intercepted fetch; in-memory CAS table.
// All expected GREEN. P1/P6/P8 pin follow-up Cs (C-707-3, C-707-4, C-707-1) as documented current behaviour.
import * as Sentry from '@sentry/node';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import {
  TRIAL_CONFLICT_MAX_VOIDS,
  TrialConflictService,
  payableInvoiceIds,
} from '../src/packages/trials/trial-conflict.service';
import { makeTrialConflictTable, stub } from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const TRIAL_INVOICE = { id: 'in_trial', amount_paid: 0, total: 0 };

type C = ConstructorParameters<typeof TrialConflictService>;
type Res = { status?: number; body: unknown };
type Reply = Res | (() => Promise<Res>);

let secret: string | undefined;
let skewMs = 0;
beforeEach(() => {
  secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_OPUST5SYNTHETIC';
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
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

async function world(r: {
  sub: Reply;
  open?: Reply;
  uncollectible?: Reply;
  paid?: Reply;
  void?: (id: string) => Reply;
}) {
  const table = makeTrialConflictTable();
  await table.createMany({
    data: [{ id: 'conflict-1', purchase_id: 'pur-1', stripe_subscription_id: 'sub_1', next_attempt_at: NOW }],
  });
  const calls: string[] = [];
  const reply = async (x: Reply) => {
    const { status = 200, body } = typeof x === 'function' ? await x() : x;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
      // B-TR7-120 adaptation (only change): the new draft list answers a complete empty page.
      if (status === 'draft') return reply(page([]));
      const x =
        status === 'open' ? r.open : status === 'uncollectible' ? r.uncollectible : status === 'paid' ? r.paid : undefined;
      return reply(x ?? { status: 500, body: { error: { type: 'api_error' } } });
    }
    return reply(r.sub);
  });
  const db = stub<C[0]>({ packageTrialConflict: table });
  const service = new TrialConflictService(db, new StripeConnectApiService());
  return {
    table,
    calls,
    db,
    service,
    deletes: () => calls.filter((c) => c.startsWith('DELETE')).length,
    voids: () => calls.filter((c) => c.startsWith('POST /invoices/')),
    row: () => table.rows[0],
  };
}
type World = Awaited<ReturnType<typeof world>>;

describe('AUD-OPUS-T5-119 #707 probes', () => {
  it('P1 (C-707-3 pinned): the void of the latest (open) invoice goes first; an active webhook superseding before the next void stops the sequence: stale, one void, no DELETE', async () => {
    let w!: World;
    w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([{ id: 'in_unc' }]),
      paid: page([TRIAL_INVOICE]),
      void: (id) => async () => {
        // The void of the latest invoice walks the plan to active; its webhook commits first.
        if (id === 'in_open') await w.service.supersede(w.db, 'pur-1');
        return voided(id);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.voids()).toEqual(['POST /invoices/in_open/void']);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'superseded', lease_token: null });
    expect(await w.service.alertSuperseded()).toBe(1);
  });

  it(`P2: exactly ${TRIAL_CONFLICT_MAX_VOIDS} payable invoices (6 open + 4 uncollectible) settle; ${TRIAL_CONFLICT_MAX_VOIDS + 1} do not`, async () => {
    const ok = await world({
      sub: sub('past_due'),
      open: page(ids('in_o', 6)),
      uncollectible: page(ids('in_u', 4)),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await ok.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(ok.voids()).toHaveLength(10);
    expect(ok.deletes()).toBe(1);
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => NOW.getTime());
    const over = await world({
      sub: sub('past_due'),
      open: page(ids('in_o', 6)),
      uncollectible: page(ids('in_u', 5)),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await over.service.settle('pur-1', NOW)).toBe('retry');
    expect(over.voids()).toEqual([]);
    expect(over.deletes()).toBe(0);
    expect(over.row()).toMatchObject({ status: 'owed', last_error: 'invoices_too_many', lease_token: null });
  });

  it('P3: ten voids of 15 s each (150 s, past the 60 s lease) settle because each step renews; a second worker at void 7 is busy; the lease held at the DELETE', async () => {
    let n = 0;
    let w!: World;
    const second: string[] = [];
    let leaseAtDelete: Date | null = null;
    w = await world({
      sub: sub('past_due'),
      open: page(ids('in_o', 5)),
      uncollectible: page(ids('in_u', 5)),
      paid: page([TRIAL_INVOICE]),
      void: (id) => async () => {
        n += 1;
        skewMs += 15_000;
        if (n === 7) second.push(await w.service.settle('pur-1', new Date(NOW.getTime() + skewMs)));
        return voided(id);
      },
    });
    const origDelete = w.service['stripe']!.cancelSubscription.bind(w.service['stripe']);
    jest.spyOn(w.service['stripe']!, 'cancelSubscription').mockImplementation(async (s: string) => {
      leaseAtDelete = w.row().lease_until as Date;
      return origDelete(s);
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.voids()).toHaveLength(10);
    expect(w.deletes()).toBe(1);
    expect(second).toEqual(['busy']);
    expect(leaseAtDelete).not.toBeNull();
    // The renewed lease at the DELETE covers the bounded 20 s call from the moment it starts.
    expect((leaseAtDelete as unknown as Date).getTime()).toBeGreaterThan(NOW.getTime() + skewMs + 20_000);
  });

  it('P4 (replaces T3E Q2): reads that ate 41 s still hit the admission gate: lease_exhausted, no void, no DELETE', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([]),
      paid: async () => {
        skewMs = 41_000;
        return page([TRIAL_INVOICE]);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toEqual([]);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', last_error: 'lease_exhausted' });
  });

  it.each<[string, Reply]>([
    ['uncollectible has_more true', page([{ id: 'in_u' }], true)],
    ['uncollectible id is a number', page([{ id: 42 }])],
    ['uncollectible id is empty', page([{ id: '' }])],
    ['uncollectible entry null', page([null])],
    ['uncollectible data missing', { body: { has_more: false } }],
    ['uncollectible 503', { status: 503, body: { error: { type: 'api_error' } } }],
  ])('P5: %s: invoices_unknown, no void, no DELETE', async (_name, unc) => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_open' }]),
      uncollectible: unc,
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toEqual([]);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', last_error: 'invoices_unknown' });
  });

  it('P5b: payableInvoiceIds unit edges', () => {
    const p = (data: unknown[], has_more: unknown = false) => ({ data, has_more }) as never;
    expect(payableInvoiceIds([p([{ id: 'a' }]), p([{ id: 'a' }, { id: 'b' }])])).toEqual(['a', 'b']);
    expect(payableInvoiceIds([p([]), p([])])).toEqual([]);
    expect(payableInvoiceIds([p([{ id: 'a' }]), null])).toBeNull();
    expect(payableInvoiceIds([p([{ id: 'a' }], 'false')])).toBeNull();
  });

  it('P6 (C-707-4 pinned): an uncollectible invoice Stripe refuses to void (partial payment) never DELETEs; three attempts alert once with a closed code', async () => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([]),
      uncollectible: page([{ id: 'in_unc' }]),
      paid: page([TRIAL_INVOICE]),
      void: () => ({
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'You cannot void an invoice with payments cus_SECRET' } },
      }),
    });
    for (let i = 0; i < 3; i += 1) {
      w.row().next_attempt_at = NOW;
      expect(await w.service.settle('pur-1', new Date(NOW.getTime() + i * 3_600_000))).toBe('retry');
    }
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', last_error: 'invoice_not_voided' });
    const sent = jest.mocked(Sentry.captureMessage).mock.calls;
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/cus_SECRET|in_unc|cannot void/);
    expect((sent[0][1] as { tags: Record<string, string> }).tags.last).toBe('invoice_not_voided');
  });

  it('P7: a void answered 200 with a non-void status is not a confirmed void: no DELETE', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([{ id: 'in_unc' }]),
      paid: page([TRIAL_INVOICE]),
      void: (id) => (id === 'in_unc' ? { body: { id, status: 'paid' } } : voided(id)),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toEqual(['POST /invoices/in_open/void', 'POST /invoices/in_unc/void']);
    expect(w.deletes()).toBe(0);
    expect(w.row().last_error).toBe('invoice_not_voided');
  });

  it('P8 (C-707-1 pinned): drafts are outside the read domain; read order is sub, open, uncollectible, paid', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([]),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls.filter((c) => c.includes('status=draft'))).toEqual([]);
    expect(w.calls.slice(0, 4)).toEqual([
      'GET /subscriptions/sub_1',
      'GET /invoices?subscription=sub_1&status=open&limit=100',
      'GET /invoices?subscription=sub_1&status=uncollectible&limit=100',
      'GET /invoices?subscription=sub_1&status=paid&limit=100',
    ]);
  });

  it('P9: the subscription was cancelled elsewhere during the last void: final renewal is stale, no DELETE, row cancelled', async () => {
    let w!: World;
    w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([{ id: 'in_unc' }]),
      paid: page([TRIAL_INVOICE]),
      void: (id) => async () => {
        if (id === 'in_unc') await w.service.markCancelled(w.db, 'pur-1');
        return voided(id);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row().status).toBe('cancelled');
  });

  it('P10: a trialing plan reads no invoice lists (the T5 lists are past_due/unpaid only)', async () => {
    const w = await world({
      sub: { body: { id: 'sub_1', status: 'trialing', trial_end: epoch(NOW) + 7 * 86400 } },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls).toEqual(['GET /subscriptions/sub_1', 'DELETE /subscriptions/sub_1']);
  });
});
