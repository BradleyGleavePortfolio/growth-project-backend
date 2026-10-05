// AUD-OPUS-T3E-119 (Claude Opus 5.5 lens) — probes for #673 FIX ROUND 11 (dcf095b8).
// Real TrialConflictService + real StripeConnectApiService over an intercepted fetch.
// Q1-Q10 are expected GREEN (Q1/Q7 pin the builder's ruled Cs C-673-8 / C-673-9 as documented behaviour).
import * as Sentry from '@sentry/node';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import {
  TrialConflictService,
  trialPaidHistory,
} from '../src/packages/trials/trial-conflict.service';
import { makeTrialConflictTable, stub } from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const TRIAL_INVOICE = { id: 'in_trial', amount_paid: 0, total: 0 };
const PAID_INVOICE = { id: 'in_renewal', amount_paid: 4900, total: 4900 };

type C = ConstructorParameters<typeof TrialConflictService>;
type Res = { status?: number; body: unknown };
type Reply = Res | (() => Promise<Res>);

let secret: string | undefined;
let skewMs = 0;
beforeEach(() => {
  secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_OPUST3ESYNTHETIC';
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
  body: { id: 'sub_1', status, latest_invoice: 'in_renewal', trial_end: epoch(NOW) - 86400 },
});
const page = (data: unknown[], hasMore = false): Res => ({ body: { data, has_more: hasMore } });
const voided = (id: string): Res => ({ body: { id, object: 'invoice', status: 'void' } });

async function world(r: {
  sub: Reply;
  open?: Reply;
  paid?: Reply;
  void?: (id: string) => Reply;
  del?: Reply;
}) {
  const table = makeTrialConflictTable();
  await table.createMany({
    data: [{ id: 'conflict-1', purchase_id: 'pur-1', stripe_subscription_id: 'sub_1', next_attempt_at: NOW }],
  });
  const calls: string[] = [];
  const bodies: string[] = [];
  const reply = async (x: Reply) => {
    const { status = 200, body } = typeof x === 'function' ? await x() : x;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = String(url).replace(/^https:\/\/api\.stripe\.com\/v1/, '');
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') return reply(r.del ?? { body: { id: 'sub_1', status: 'canceled' } });
    const voidId = /^\/invoices\/([^/?]+)\/void$/.exec(path)?.[1];
    if (method === 'POST' && voidId) {
      bodies.push(String(init?.body ?? ''));
      return reply((r.void ?? voided)(decodeURIComponent(voidId)));
    }
    if (path.startsWith('/invoices?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      // B-TR7-120 adaptation (only change): the new draft list answers a complete empty page.
      if (status === 'draft') return reply(page([]));
      // B-TR6-119 adaptation (only change): the new uncollectible list answers a complete empty page.
      if (status === 'uncollectible') return reply(page([]));
      const x = status === 'open' ? r.open : status === 'paid' ? r.paid : undefined;
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
    bodies,
    db,
    service,
    deletes: () => count('DELETE'),
    voids: () => count('POST /invoices/'),
    row: () => table.rows[0],
  };
}

describe('AUD-OPUS-T3E-119 #673 round 11 probes', () => {
  it('Q1 (C-673-8 pinned): void confirmed, DELETE 503 -> retry; next read active -> superseded + one billed alert, never a second void', async () => {
    let remote = 'past_due';
    const w = await world({
      sub: async () => sub(remote),
      open: page([{ id: 'in_renewal' }]),
      paid: page([TRIAL_INVOICE]),
      void: (id) => async () => {
        remote = 'active'; // Stripe walks a voided past_due plan back to active
        return voided(id);
      },
      del: { status: 503, body: { error: { type: 'api_error' } } },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toBe(1);
    expect(w.deletes()).toBe(1);
    expect(w.row()).toMatchObject({ status: 'owed', lease_token: null });
    w.row().next_attempt_at = NOW;
    expect(await w.service.settle('pur-1', new Date(NOW.getTime() + 600_000))).toBe('superseded');
    expect(w.voids()).toBe(1);
    expect(w.deletes()).toBe(1);
    expect(await w.service.alertSuperseded()).toBe(1);
  });

  it('Q2: reads that ate 25 s leave no room for void + DELETE (one invoice): lease_exhausted, no void, no DELETE', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_renewal' }]),
      paid: async () => {
        skewMs = 25_000;
        return page([TRIAL_INVOICE]);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toBe(0);
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', last_error: 'lease_exhausted' });
  });

  it('Q2b control: reads that took 15 s still fit (15 + 40 < 60): void then DELETE', async () => {
    const w = await world({
      sub: sub('unpaid'),
      open: page([{ id: 'in_renewal' }]),
      paid: async () => {
        skewMs = 15_000;
        return page([TRIAL_INVOICE]);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.voids()).toBe(1);
    expect(w.deletes()).toBe(1);
  });

  it('Q3: a null entry in the open page is not a list of ids: invoices_unknown, no void', async () => {
    const w = await world({ sub: sub('past_due'), open: page([null]), paid: page([TRIAL_INVOICE]) });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toBe(0);
    expect(w.deletes()).toBe(0);
    expect(w.row().last_error).toBe('invoices_unknown');
  });

  it('Q4: paid list fails while the open list is fine: history_unknown, no void, no DELETE', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_renewal' }]),
      paid: { status: 503, body: { error: { type: 'api_error' } } },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.voids()).toBe(0);
    expect(w.deletes()).toBe(0);
    expect(w.row().last_error).toBe('history_unknown');
  });

  it('Q5: the void is POST /invoices/<encoded id>/void with an empty form, one per open invoice id', async () => {
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_a/b' }]),
      paid: page([TRIAL_INVOICE]),
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(w.calls).toContain('POST /invoices/in_a%2Fb/void');
    expect(w.bodies).toEqual(['']);
  });

  it('Q6: replay after a cancel is a no-op (not_owed, zero Stripe calls)', async () => {
    const w = await world({ sub: sub('past_due'), open: page([{ id: 'in_renewal' }]), paid: page([TRIAL_INVOICE]) });
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    const n = w.calls.length;
    expect(await w.service.settle('pur-1', new Date(NOW.getTime() + 600_000))).toBe('not_owed');
    expect(w.calls.length).toBe(n);
  });

  it('Q7 (C-673-9 pinned): unpaid plan whose only invoice is uncollectible (open list empty) never auto-settles; fails closed', async () => {
    const w = await world({ sub: sub('unpaid'), open: page([]), paid: page([TRIAL_INVOICE]) });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.calls.filter((c) => c.includes('status=uncollectible'))).toEqual([]);
    expect(w.deletes()).toBe(0);
  });

  it('Q8: C-673-7 edges', () => {
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: null }], has_more: false })).toBe('unknown');
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: '4900' }], has_more: false })).toBe('unknown');
    expect(trialPaidHistory({ data: [{ amount_paid: Infinity, total: 0 }], has_more: false })).toBe('charged');
    expect(trialPaidHistory({ data: [null], has_more: false })).toBe('unknown');
    expect(trialPaidHistory({ data: [], has_more: false })).toBe('none');
  });

  it('Q9: two workers: the second settle during the first one\'s void is busy; one void, one DELETE', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = () => res();
    });
    let entered!: () => void;
    const inVoid = new Promise<void>((res) => {
      entered = () => res();
    });
    const w = await world({
      sub: sub('past_due'),
      open: page([{ id: 'in_renewal' }]),
      paid: page([TRIAL_INVOICE]),
      void: (id) => async () => {
        entered();
        await gate;
        return voided(id);
      },
    });
    const first = w.service.settle('pur-1', NOW);
    await inVoid;
    expect(await w.service.settle('pur-1', NOW)).toBe('busy');
    release();
    expect(await first).toBe('cancelled');
    expect(w.voids()).toBe(1);
    expect(w.deletes()).toBe(1);
  });

  it('Q10: payment lands after the paid read (void answers 400 invoice already paid) then a 404 DELETE path is never reached', async () => {
    let remote = 'past_due';
    const w = await world({
      sub: async () => sub(remote),
      open: page([{ id: 'in_renewal' }]),
      paid: async () => page(remote === 'active' ? [TRIAL_INVOICE, PAID_INVOICE] : [TRIAL_INVOICE]),
      void: () => async () => {
        remote = 'active';
        return { status: 400, body: { error: { type: 'invalid_request_error', message: 'invoice is already paid' } } };
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.deletes()).toBe(0);
    const tags = jest.mocked(Sentry.captureMessage).mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
    expect(tags.join('')).not.toMatch(/already paid/);
  });
});
