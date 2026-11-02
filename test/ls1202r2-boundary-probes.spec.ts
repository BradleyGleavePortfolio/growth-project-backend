import 'reflect-metadata';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import {
  isConnectAccountReadyForCheckout,
  isConnectAccountReadyForSale,
} from '../src/connect/connect-readiness';
import { isConnectAccountReadyForCheckout as compatiblePredicate } from '../src/storefront/storefront.service';
import {
  briefPaymentLines,
  buildFallbackNarrative,
  BRIEF_MAX_NARRATIVE_CHARS,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import { makeBriefContext, makeHeadCoachContext } from './_fixtures/coach-brief-mocks';

// Independent review probes. Apply the real selected relation's predicate,
// rather than returning an unfiltered fixture array as a Prisma response.
function matches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([key, expected]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((x) => matches(value, x));
    if (key === 'OR') return Array.isArray(expected) && expected.some((x) => matches(value, x));
    if (key === 'NOT') return !(Array.isArray(expected) ? expected : [expected]).some((x) => matches(value, x));
    if (key === 'in') return Array.isArray(expected) && expected.includes(value);
    if (key === 'notIn') return Array.isArray(expected) && !expected.includes(value);
    if (key === 'not') return !matches(value, expected);
    if (key === 'gt') return typeof value === 'number' && typeof expected === 'number' && value > expected;
    if (key === 'some') return Array.isArray(value) && value.some((x) => matches(x, expected));
    if (key === 'none') return Array.isArray(value) && !value.some((x) => matches(x, expected));
    return value !== null && typeof value === 'object' && matches((value as Record<string, unknown>)[key], expected);
  });
}

const COACH = 'review-coach';
const PURCHASE = 'review-plan';
interface Entry {
  id: string;
  kind: string;
  status: string;
  amount_cents: number;
  reversed_cents: number;
  payee_user_id: string | null;
  purchase_id: string;
  currency: string;
}
const entry = (kind: string, status: string): Entry => ({
  id: `${kind}-${status}`, kind, status, amount_cents: 14900,
  reversed_cents: status === 'reversed' ? 14900 : 0,
  payee_user_id: kind === 'destination' ? COACH : null,
  purchase_id: PURCHASE, currency: 'usd',
});
const EVIDENCE: Array<[string, Entry[], boolean]> = [
  ['no entries', [], false],
  ['pending destination', [entry('destination', 'pending')], false],
  ['failed destination', [entry('destination', 'failed')], false],
  ['posted application fee only', [entry('application_fee', 'posted')], false],
  ['posted processing fee only', [entry('stripe_fee', 'posted')], false],
  ['posted head share only', [entry('head_coach', 'posted')], false],
  ['posted destination', [entry('destination', 'posted')], true],
  ['reversed destination', [entry('destination', 'reversed')], true],
  ['mixed entries', [entry('destination', 'pending'), entry('destination', 'posted')], true],
];
interface Query {
  where: unknown;
  take?: number;
  select?: { splits: { where: unknown; take: number } };
}
function service(status: string, entries: Entry[], refund = 0, dispute: string | null = null) {
  const row = {
    id: PURCHASE, coach_user_id: COACH, client_user_id: 'review-client', source: null,
    status, billing_type: 'recurring', amount_cents: 14900, currency: 'usd',
    created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-11-01T10:00:00Z'),
    client: { id: 'review-client', name: 'Test client' },
    package: { id: 'review-package', name: 'Coaching', interval: 'month', interval_count: 1 },
    dunning: { status: 'active', last_failure_reason: 'coach_account_not_ready' },
    splits: entries,
    refunds: refund > 0 ? [{ status: 'succeeded', amount_cents: refund }] : [],
    disputes: dispute ? [{ status: dispute, amount_cents: 14900 }] : [],
  };
  const selected = (query: Query) => ({
    ...row,
    splits: entries.filter((x) => matches(x, query.select?.splits.where)).slice(0, query.select?.splits.take),
  });
  const prisma = {
    clientPurchase: {
      findFirst: jest.fn(async (query: Query) => matches(row, query.where) ? selected(query) : null),
      findMany: jest.fn(async (query: Query) => matches(row, query.where) ? [selected(query)] : []),
    },
    splitLedgerEntry: { findMany: jest.fn(async (query: Query) => entries.filter((x) => matches(x, query.where))) },
    user: { findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    notification: { findMany: jest.fn(async () => []) },
  };
  const svc: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
  return svc;
}

describe('LS-1202R2 independent boundary probes', () => {
  it.each(Array.from({ length: 32 }, (_, mask) => [mask]))('readiness mask %i shares one definition', (mask) => {
    const account = {
      charges_enabled: !!(mask & 1), payouts_enabled: !!(mask & 2),
      details_submitted: !!(mask & 4), disabled_reason: mask & 8 ? 'requirements_due' : null,
      deauthorized_at: mask & 16 ? new Date() : null,
    };
    expect(compatiblePredicate).toBe(isConnectAccountReadyForCheckout);
    expect(isConnectAccountReadyForCheckout(account)).toBe((mask & 15) === 7);
    const saleReady: boolean = Reflect.apply(isConnectAccountReadyForSale, undefined, [account]);
    expect(saleReady).toBe(mask === 7);
  });

  it.each(['past_due', 'unpaid', 'payment_failed'].flatMap((status) =>
    EVIDENCE.map(([label, entries, settled]) => [status, label, entries, settled] as const),
  ))('%s / %s: selected relation, filter, state and detail agree', async (status, _label, entries, settled) => {
    const svc = service(status, entries);
    const all = await svc.listCharges(COACH, { status: 'all', limit: 20 });
    const failed = await svc.listCharges(COACH, { status: 'failed', limit: 20 });
    const detail = await svc.getChargeBreakdown(COACH, PURCHASE);
    const state = settled ? 'failed' : 'pending';
    expect(all.charges[0]).toMatchObject({ state, amount_cents: 14900 });
    expect(detail.charge.state).toBe(state);
    expect(detail.breakdown.settled).toBe(settled);
    expect(failed.charges.length).toBe(settled ? 1 : 0);
    const paid = await svc.listCharges(COACH, { status: 'paid', limit: 20 });
    expect(paid.charges).toEqual([]);
    if (!settled) {
      expect(detail.breakdown.net_cents).toBe(0);
      expect(detail.charge).toMatchObject({ waiting_on: 'coach_account' });
    } else {
      expect(detail.charge).toMatchObject({ waiting_on: null });
    }
  });

  it.each([
    [14900, null, 'refunded'],
    [1000, null, 'partially_refunded'],
    [0, 'needs_response', 'disputed'],
    [0, 'lost', 'charged_back'],
  ] as const)('refund %s / dispute %s keeps %s priority', async (refund, dispute, state) => {
    const svc = service('past_due', [entry('destination', 'reversed')], refund, dispute);
    const detail = await svc.getChargeBreakdown(COACH, PURCHASE);
    expect(detail.charge.state).toBe(state);
    expect(detail.breakdown.settled).toBe(true);
  });

  it('another coach cannot read a held charge detail', async () => {
    await expect(service('past_due', []).getChargeBreakdown('another-coach', PURCHASE))
      .rejects.toMatchObject({ status: 404 });
  });

  it.each(Array.from({ length: 16 }, (_, mask) => [mask]))('fallback mask %i retains every applicable payment line', (mask) => {
    const values = {
      dunning_in_progress: mask & 1 ? 3 : 0,
      dunning_locked: mask & 2 ? 2 : 0,
      dunning_on_hold: mask & 4 ? 4 : 0,
      coach_account_waiting: mask & 8 ? 5 : 0,
    };
    for (const ctx of [makeBriefContext(values), makeHeadCoachContext({
      ...values, dunning_amount_cents: 44700, dunning_locked_amount_cents: 29800,
    })]) {
      const fallback = buildFallbackNarrative(ctx);
      for (const line of briefPaymentLines(ctx)) expect(fallback).toContain(line);
      if (values.coach_account_waiting) expect(fallback).toContain(coachAccountWaitingLine(5));
      expect(fallback.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
      expect(withCoachAccountWaiting(fallback, ctx)).toBe(fallback);
    }
  });
});
