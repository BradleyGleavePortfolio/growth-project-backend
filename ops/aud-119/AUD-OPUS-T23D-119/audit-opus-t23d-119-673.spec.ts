// AUD-OPUS-T23D-119 (Claude Opus 5.5 lens, agent 119) — probes on backend
// #673 @ 904b964250f4b7694b24f78fdef5a5f846957013 (FIX ROUND 10: Sol B-673-1
// paid-invoice history for past_due/unpaid; Sol B-673-2 re-check after the reads).
// Audit-only: never merge. Harness conflictWorld() copied from #706
// test/b-trials-4-fix-round.spec.ts (real TrialConflictService + real
// StripeConnectApiService over an intercepted fetch). All expected GREEN.
//   P1 a charged invoice on an INCOMPLETE page (has_more) still decides billed.
//   P2 pure decision: lease room, default history, unpaid/charged, trialing.
//   P3 the post-read ownership re-check itself throws: retry, no DELETE, lease released.
//   P4 trialPaidHistory fails closed on malformed amounts and pages.
//   P5 a webhook supersession during the invoice read of a CHARGED plan: stale,
//      no DELETE, exactly one billed alert.
//   P6 an `active` read never lists invoices (no extra Stripe call on the hot path).
import * as Sentry from '@sentry/node';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import {
  TRIAL_CONFLICT_CANCEL_TIMEOUT_MS,
  TrialConflictService,
  trialConflictAction,
  trialPaidHistory,
} from '../src/packages/trials/trial-conflict.service';
import { makeTrialConflictTable, stub } from './utils/trial-fakes';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/node'),
  captureMessage: jest.fn(),
}));

const NOW = new Date('2026-10-09T17:00:00Z');
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const TRIAL_INVOICE = { id: 'in_trial', amount_paid: 0, total: 0, currency: 'usd' };
const PAID_INVOICE = { id: 'in_first', amount_paid: 4900, total: 4900, currency: 'usd' };

type C = ConstructorParameters<typeof TrialConflictService>;
type Reply = { status?: number; body: unknown } | (() => Promise<{ status?: number; body: unknown }>);

let secret: string | undefined;
beforeEach(() => {
  secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_AUDOPUST23D';
  jest.mocked(Sentry.captureMessage).mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = secret;
});

const sentryCodes = () =>
  jest.mocked(Sentry.captureMessage).mock.calls.map((c) => (c[1] as { tags?: { code?: string } } | undefined)?.tags?.code);

async function conflictWorld(replies: { sub: Reply; invoices?: Reply }) {
  const table = makeTrialConflictTable();
  await table.createMany({
    data: [{ id: 'conflict-1', purchase_id: 'pur-1', stripe_subscription_id: 'sub_1', next_attempt_at: NOW }],
  });
  const calls: string[] = [];
  const reply = async (r: Reply) => {
    const { status = 200, body } = typeof r === 'function' ? await r() : r;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = String(url).replace(/^https:\/\/api\.stripe\.com\/v1/, '');
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') return reply({ body: { id: 'sub_1', status: 'canceled' } });
    if (path.startsWith('/invoices')) return reply(replies.invoices ?? { status: 500, body: { error: { type: 'api_error' } } });
    return reply(replies.sub);
  });
  const db = stub<C[0]>({ packageTrialConflict: table });
  const service = new TrialConflictService(db, new StripeConnectApiService());
  const deletes = () => calls.filter((c) => c.startsWith('DELETE')).length;
  return { table, calls, db, service, deletes, row: () => table.rows[0] };
}

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  body: { id: 'sub_1', status, latest_invoice: 'in_renewal', trial_end: epoch(NOW) - 40 * 86400, ...over },
});
const page = (data: unknown[], hasMore = false) => ({ body: { data, has_more: hasMore } });

describe('AUD-OPUS-T23D-119 #673 — round 10 deltas', () => {
  it('P1 a charge on an incomplete page (has_more) decides billed: superseded, no DELETE', async () => {
    const w = await conflictWorld({ sub: sub('past_due'), invoices: page([PAID_INVOICE], true) });
    expect(await w.service.settle('pur-1', NOW)).toBe('superseded');
    expect(w.deletes()).toBe(0);
  });

  it('P2 pure decision table', () => {
    const until = new Date(NOW.getTime() + 60_000);
    const late = new Date(until.getTime() - TRIAL_CONFLICT_CANCEL_TIMEOUT_MS);
    const pd = { status: 'past_due', trial_end: epoch(NOW) - 86400 };
    expect(trialConflictAction(pd, NOW, until, 'none')).toBe('cancel');
    expect(trialConflictAction(pd, late, until, 'none')).toBe('lease_exhausted');
    expect(trialConflictAction(pd, NOW, until)).toBe('history_unknown');
    expect(trialConflictAction(pd, NOW, until, 'unknown')).toBe('history_unknown');
    expect(trialConflictAction({ status: 'unpaid' }, NOW, until, 'charged')).toBe('billed');
    expect(trialConflictAction({ status: 'past_due' }, late, until, 'charged')).toBe('billed');
    expect(trialConflictAction({ status: 'active' }, NOW, until, 'none')).toBe('billed');
    expect(trialConflictAction({ status: 'Past_Due' }, NOW, until, 'none')).toBe('state_unknown');
    expect(trialConflictAction({ status: 'paused', trial_end: epoch(NOW) - 86400 }, NOW, until)).toBe('cancel');
  });

  it('P3 the post-read re-check throws: retry, no DELETE, lease released, still owed', async () => {
    const w = await conflictWorld({ sub: sub('past_due'), invoices: page([TRIAL_INVOICE]) });
    const t = w.table as unknown as { findFirst: (a: unknown) => Promise<unknown> };
    t.findFirst = async () => {
      throw new Error('connection reset');
    };
    expect(await w.service.settle('pur-1', NOW)).toBe('retry');
    expect(w.deletes()).toBe(0);
    expect(w.row()).toMatchObject({ status: 'owed', lease_token: null, lease_until: null });
  });

  it('P4 trialPaidHistory fails closed', () => {
    expect(trialPaidHistory({ data: [{ amount_paid: '4900', total: 4900 }], has_more: false })).toBe('unknown');
    expect(trialPaidHistory({ data: [null], has_more: false })).toBe('unknown');
    expect(trialPaidHistory({ data: [TRIAL_INVOICE] })).toBe('unknown');
    expect(trialPaidHistory({ data: [TRIAL_INVOICE], has_more: 'false' })).toBe('unknown');
    expect(trialPaidHistory(null)).toBe('unknown');
    expect(trialPaidHistory({ data: [], has_more: false })).toBe('none');
    expect(trialPaidHistory({ data: [TRIAL_INVOICE], has_more: false })).toBe('none');
    expect(trialPaidHistory({ data: [{ amount_paid: 0, total: 1 }], has_more: true })).toBe('charged');
    // a malformed entry before a charge: the charge still decides (keep the paid plan)
    expect(trialPaidHistory({ data: [{ id: 'x' }, PAID_INVOICE], has_more: false })).toBe('charged');
  });

  it('P5 supersession during the invoice read of a charged plan: stale, no DELETE, one billed alert', async () => {
    let w!: Awaited<ReturnType<typeof conflictWorld>>;
    w = await conflictWorld({
      sub: sub('unpaid'),
      invoices: async () => {
        await w.service.supersede(w.db, 'pur-1', NOW);
        return page([TRIAL_INVOICE, PAID_INVOICE]);
      },
    });
    expect(await w.service.settle('pur-1', NOW)).toBe('stale');
    expect(w.deletes()).toBe(0);
    expect(w.row().status).toBe('superseded');
    expect(await w.service.alertSuperseded()).toBe(1);
    expect(await w.service.alertSuperseded()).toBe(0);
    expect(sentryCodes()).toEqual(['TRIAL_CONFLICT_SUPERSEDED']);
  });

  it('P6 an active read never lists invoices', async () => {
    const w = await conflictWorld({ sub: sub('active') });
    expect(await w.service.settle('pur-1', NOW)).toBe('superseded');
    expect(w.calls).toEqual(['GET /subscriptions/sub_1']);
  });
});
