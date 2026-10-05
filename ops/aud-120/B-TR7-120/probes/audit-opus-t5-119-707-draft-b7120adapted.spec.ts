// AUD-OPUS-T5-119 (Claude Opus 5.5 lens) — probes for #707 (T5 payable invoice domain) at ffed434e.
// Real TrialConflictService + real StripeConnectApiService over an intercepted fetch; in-memory CAS table.
// DRAFT RACE (B-707-1, this lens's own proof): D1 is EXPECTED RED at ffed434e (a DELETE goes out after a payment);
// D2 is GREEN and records the consequence in the most likely webhook ordering (cancelled, zero alerts).
import * as Sentry from '@sentry/node';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { TrialConflictService } from '../src/packages/trials/trial-conflict.service';
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


describe('AUD-OPUS-T5-119 #707 draft race (B-707-1)', () => {
  const draftWorld = async (state: { paidCents: number }) => {
    let remotePaid = false;
    return world({
      sub: async () => sub('past_due'),
      open: page([{ id: 'in_open' }]),
      uncollectible: page([]),
      // The draft renewal in_draft is in neither payable page, and not paid when the paid list is read.
      paid: async () => page(remotePaid ? [TRIAL_INVOICE, { id: 'in_draft', amount_paid: 4900, total: 4900 }] : [TRIAL_INVOICE]),
      void: (id) => async () => {
        // Stripe auto-finalizes the renewal draft and charges it while the worker voids in_open.
        remotePaid = true;
        state.paidCents += 4900;
        return voided(id);
      },
    });
  };

  it('D1 (expected red): a renewal draft finalized and paid after the reads must not be followed by a DELETE', async () => {
    const state = { paidCents: 0 };
    const w = await draftWorld(state);
    await w.service.settle('pur-1', NOW);
    expect(state.paidCents).toBe(4900);
    expect(w.deletes()).toBe(0);
  });

  it('D2 (green, consequence): the worker records cancelled and no billed or failing alert exists', async () => {
    const state = { paidCents: 0 };
    const w = await draftWorld(state);
    expect(await w.service.settle('pur-1', NOW)).toBe('cancelled');
    expect(state.paidCents).toBe(4900);
    expect(w.deletes()).toBe(1);
    expect(w.calls.filter((c) => c.includes('status=draft'))).toEqual([]);
    expect(w.row()).toMatchObject({ status: 'cancelled', last_error: null });
    expect(await w.service.alertSuperseded()).toBe(0);
    expect(jest.mocked(Sentry.captureMessage)).not.toHaveBeenCalled();
  });
});
