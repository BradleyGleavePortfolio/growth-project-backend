import type { ConnectAccount } from '@prisma/client';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import {
  BRIEF_MAX_NARRATIVE_CHARS,
  briefPaymentLines,
  buildFallbackNarrative,
  validateClaudeNarrative,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import {
  isConnectAccountReadyForCheckout,
  isConnectAccountReadyForSale,
  readinessRow,
} from '../src/connect/connect-readiness';
import type { ConnectService } from '../src/connect/connect.service';
import { isConnectAccountReadyForCheckout as publicReady } from '../src/storefront/storefront.service';
import { makeBriefContext, makeHeadCoachContext } from './_fixtures/coach-brief-mocks';
import { partialDouble } from './support/typed-double';

// Independent Sol review probes for backend#1202. Synthetic inputs only.
describe('LS-1202B independent readiness acceptance', () => {
  const rows = Array.from({ length: 32 }, (_, bits) => ({
    bits,
    row: partialDouble<ConnectAccount>({
      charges_enabled: !!(bits & 1),
      payouts_enabled: !!(bits & 2),
      details_submitted: !!(bits & 4),
      disabled_reason: bits & 8 ? 'requirements.past_due' : null,
      deauthorized_at: bits & 16 ? new Date(1) : null,
    }),
  }));

  it('the public compatibility export is the shared predicate, not a divergent copy', () => {
    expect(publicReady).toBe(isConnectAccountReadyForCheckout);
    expect(isConnectAccountReadyForCheckout(null)).toBe(false);
    expect(isConnectAccountReadyForCheckout(undefined)).toBe(false);
  });

  it.each(rows)('all readiness axes and the deauthorization guard: mask $bits', async ({ bits, row }) => {
    const expected = (bits & 15) === 7;
    expect(publicReady(row)).toBe(expected);
    expect(isConnectAccountReadyForSale(row)).toBe(expected && !(bits & 16));
    const refresh = jest.fn(async (saved: ConnectAccount) => saved);
    const connect = partialDouble<ConnectService>({ refreshNotReady: refresh });
    expect(await readinessRow(row, connect)).toBe(row);
    expect(refresh).toHaveBeenCalledTimes(expected ? 0 : 1);
    // Legacy hand-built callers without ConnectService retain the closed saved answer.
    expect(await readinessRow(row)).toBe(row);
  });
});

describe('LS-1202B independent held charge detail acceptance', () => {
  it.each(['past_due', 'payment_failed', 'unpaid'])(
    '%s held debt has an explicit cause, is not settled, contributes no fabricated net, and is not mutated',
    async (status) => {
      const purchase = {
        id: 'synthetic-held',
        coach_user_id: 'synthetic-coach',
        client_user_id: 'synthetic-client',
        status,
        amount_cents: 14900,
        currency: 'usd',
        billing_type: 'recurring',
        source: null,
        created_at: new Date('2026-10-30T09:00:00Z'),
        client: { id: 'synthetic-client', name: 'Test client' },
        package: { id: 'synthetic-package', name: 'Monthly coaching' },
        dunning: { status: 'active', last_failure_reason: 'coach_account_not_ready' },
        splits: [],
        refunds: [],
        disputes: [],
      };
      const before = structuredClone(purchase);
      const find = jest.fn(async () => purchase);
      const prisma = {
        clientPurchase: { findFirst: find },
        user: { findMany: jest.fn(async () => []) },
        splitLedgerEntry: { findMany: jest.fn(async () => []) },
      };
      const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
      const detail = await service.getChargeBreakdown('synthetic-coach', purchase.id);
      expect(find.mock.calls).toHaveLength(1);
      expect(detail.charge).toMatchObject({
        state: 'pending',
        waiting_on: 'coach_account',
        amount_cents: 14900,
        currency: 'usd',
        moved_away_at: null,
      });
      expect(detail.breakdown).toMatchObject({
        price_cents: 14900,
        net_cents: 0,
        processing_cents: 0,
        platform_fee_cents: 0,
        settled: false,
      });
      expect(purchase).toEqual(before);
    },
  );
});

describe('LS-1202B independent fallback and insertion acceptance', () => {
  const cases = Array.from({ length: 16 }, (_, bits) => ({
    bits,
    counts: {
      dunning_in_progress: bits & 1 ? 1 : 0,
      dunning_locked: bits & 2 ? 2 : 0,
      dunning_on_hold: bits & 4 ? 3 : 0,
      coach_account_waiting: bits & 8 ? 4 : 0,
    },
  }));

  it.each(cases)('solo and head fallback preserve every applicable payment fact: mask $bits', ({ counts }) => {
    for (const context of [makeBriefContext(counts), makeHeadCoachContext(counts)]) {
      const before = structuredClone(context);
      const fallback = buildFallbackNarrative(context);
      const required = briefPaymentLines(context);
      if (counts.coach_account_waiting) {
        required.push(coachAccountWaitingLine(counts.coach_account_waiting));
      }
      expect(fallback.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
      expect(validateClaudeNarrative(fallback, 'Sarah', required)).toBeNull();
      for (const line of required) expect(fallback).toContain(line);
      // Applying the insertion again is stable and never duplicates the waiting notice.
      expect(withCoachAccountWaiting(fallback, context)).toBe(fallback);
      expect(context).toEqual(before);
    }
  });
});
