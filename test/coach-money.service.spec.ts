// S-COACH (agent 111) — TGP Money read model.
//
// 1. foldTotals: legacy destination charge (processing paid by TGP),
//    #627-style four-slice charge (processing paid by the coach), refunds,
//    head-coach split and head-coach income, mixed.
// 2. parseWindow: stable 400 codes for bad windows.
// 3. getSummary: compare window, change_cents / change_pct, recurring numbers
//    (MRR with yearly / 12, paying clients distinct, churn excludes clients
//    still paying, new clients exclude returning ones), every query scoped to
//    the caller.
// 4. listCharges: filters map to the right where clause; no secrets selected;
//    coach-facing state; cursor pagination.
// 5. getChargeBreakdown: another coach's charge is a 404 with a stable code.
// 6. getAttention: failed payment with dunning attempt n of 4, next retry,
//    card-update link sent; open dispute; Stripe requirements due.
// 7. readRequirements / deriveConnectState.

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CHARGE_STATUS_FILTERS,
  CoachMoneyService,
  DISPUTED_WHERE,
  PAID_WHERE,
  REFUNDED_WHERE,
  allocateReversal,
  buildMoneyCsv,
  centsToDecimal,
  chargeCadence,
  changePct,
  csvText,
  defaultCurrency,
  foldTotals,
  foldWindowTotals,
  monthlyEquivalent,
  parseCurrency,
  parseWindow,
  payeeRecoveryReader,
  readRequirements,
  recurringCadenceOf,
  type ReversalEvent,
  type ReversedSliceRow,
} from '../src/coach-money/coach-money.service';
import { deriveConnectState } from '../src/coach-connect/coach-connect.service';

const COACH = 'coach-1';

function slice(
  kind: string,
  amount: number,
  opts: { payee?: string | null; reversed?: number; purchase?: string } = {},
) {
  return {
    kind,
    payee_user_id: opts.payee === undefined ? (kind === 'destination' ? COACH : null) : opts.payee,
    amount_cents: amount,
    reversed_cents: opts.reversed ?? 0,
    status: 'posted',
    purchase_id: opts.purchase ?? 'p1',
    currency: 'usd',
    stripe_charge_id: null,
    posted_at: new Date('2026-09-20T10:00:00Z'),
    reversed_at: null,
    created_at: new Date('2026-09-20T10:00:00Z'),
    client_name: 'Ana Ruiz',
    package_name: 'Monthly coaching',
    purchase: {
      client: { name: 'Ana Ruiz' },
      package: { name: 'Monthly coaching' },
      refunds: [],
      disputes: [],
    },
  };
}

describe('foldTotals', () => {
  it('legacy destination charge: coach net = price - 2%, processing paid by the platform', () => {
    const t = foldTotals(COACH, [slice('destination', 4802), slice('application_fee', 98)], []);
    expect(t).toMatchObject({
      gross_cents: 4900,
      processing_cents: 0,
      platform_fee_cents: 98,
      net_cents: 4802,
      charge_count: 1,
      processing_paid_by: 'platform',
    });
  });

  it('separate-charges settlement: price - actual Stripe fee - 2% = net, paid by the coach', () => {
    const t = foldTotals(
      COACH,
      [slice('destination', 4630), slice('application_fee', 98), slice('stripe_fee', 172)],
      [],
    );
    expect(t.gross_cents).toBe(4900);
    expect(t.processing_cents).toBe(172);
    expect(t.platform_fee_cents).toBe(98);
    expect(t.net_cents).toBe(4630);
    expect(t.gross_cents - t.processing_cents - t.platform_fee_cents).toBe(t.net_cents);
    expect(t.processing_paid_by).toBe('coach');
  });

  it('a reversal reduces net once and is reported as refunded', () => {
    const t = foldTotals(
      COACH,
      [
        slice('destination', 4630, { reversed: 1960 }),
        slice('application_fee', 98, { reversed: 40 }),
      ],
      [],
    );
    expect(t.net_cents).toBe(2670);
    expect(t.refunded_cents).toBe(1960);
    expect(t.platform_fee_cents).toBe(58);
  });

  it('head-coach split on the seller side and head-coach income on the payee side', () => {
    const seller = [
      slice('destination', 9300, { purchase: 'a' }),
      slice('application_fee', 200, { purchase: 'a' }),
      slice('head_coach_split', 500, { payee: 'head-1', purchase: 'a' }),
    ];
    const income = [slice('head_coach_split', 250, { payee: COACH, purchase: 'b' })];
    const t = foldTotals(COACH, seller, income);
    expect(t.head_coach_split_cents).toBe(500);
    expect(t.head_coach_income_cents).toBe(250);
    expect(t.net_cents).toBe(9550);
  });

  it('mixed legacy and settled charges report processing_paid_by mixed; no charges report none', () => {
    const t = foldTotals(
      COACH,
      [
        slice('destination', 4802, { purchase: 'legacy' }),
        slice('destination', 4630, { purchase: 'new' }),
        slice('stripe_fee', 172, { purchase: 'new' }),
      ],
      [],
    );
    expect(t.processing_paid_by).toBe('mixed');
    expect(foldTotals(COACH, [], []).processing_paid_by).toBe('none');
  });

  it('ignores a destination slice paid to someone else', () => {
    const t = foldTotals(COACH, [slice('destination', 1000, { payee: 'other' })], []);
    expect(t.net_cents).toBe(0);
    expect(t.charge_count).toBe(0);
  });
});

describe('changePct / parseWindow', () => {
  it('changePct is null when the previous period was 0 and rounds to one decimal', () => {
    expect(changePct(100, 0)).toBeNull();
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(1, 3)).toBe(-66.7);
  });

  it('rejects missing, reversed and over-long windows with stable codes', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        return ((e as BadRequestException).getResponse() as { code: string }).code;
      }
      return null;
    };
    expect(codeOf(() => parseWindow(undefined, '2026-10-01T00:00:00Z', 'window'))).toBe(
      'MONEY_WINDOW_INVALID',
    );
    expect(
      codeOf(() => parseWindow('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z', 'window')),
    ).toBe('MONEY_WINDOW_INVALID');
    expect(
      codeOf(() => parseWindow('2024-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'compare')),
    ).toBe('MONEY_COMPARE_WINDOW_INVALID');
    expect(
      parseWindow('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'window').from.toISOString(),
    ).toBe('2026-09-01T00:00:00.000Z');
  });
});

function buildPrisma() {
  return {
    splitLedgerEntry: { findMany: jest.fn(async (_args?: unknown): Promise<unknown[]> => []) },
    clientPurchase: {
      findMany: jest.fn(async (_args?: unknown): Promise<unknown[]> => []),
      findFirst: jest.fn(async (_args?: unknown): Promise<unknown> => null),
    },
    chargeDispute: { findMany: jest.fn(async (_args?: unknown): Promise<unknown[]> => []) },
    chargeRefund: { findMany: jest.fn(async (_args?: unknown): Promise<unknown[]> => []) },
    connectAccount: { findUnique: jest.fn(async (_args?: unknown): Promise<unknown> => null) },
  };
}

type P = ReturnType<typeof buildPrisma>;
function svc(p: P): CoachMoneyService {
  // Reflect.construct keeps the mock untyped without a banned cast.
  return Reflect.construct(CoachMoneyService, [p]);
}

function chargeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    created_at: new Date('2026-09-20T10:00:00Z'),
    client: { id: 'client-1', name: 'Ana Ruiz' },
    package: { id: 'pkg-1', name: 'Monthly coaching' },
    refunds: [],
    disputes: [],
    splits: [{ id: 's1' }],
    ...over,
  };
}

function pkgCadence(over: Record<string, unknown> = {}) {
  return {
    interval: 'month',
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    ...over,
  };
}

function mrrRow(over: Record<string, unknown> = {}) {
  return {
    client_user_id: 'c1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    package: pkgCadence(),
    ...over,
  };
}

describe('CoachMoneyService.getSummary', () => {
  it('returns totals, compare totals, change and recurring numbers, all scoped to the caller', async () => {
    const p = buildPrisma();
    p.splitLedgerEntry.findMany.mockImplementation(async (args: unknown) => {
      const a = args as {
        where: {
          kind?: string;
          reversed_cents?: unknown;
          OR: Array<{ posted_at?: { gte: Date } }>;
        };
      };
      if ((args as { distinct?: unknown }).distinct) return [{ currency: 'usd' }];
      if (a.where.kind === 'head_coach_split' || a.where.reversed_cents) return [];
      const from = a.where.OR[0].posted_at!.gte.toISOString();
      return from.startsWith('2026-09-02')
        ? [slice('destination', 4630), slice('application_fee', 98), slice('stripe_fee', 172)]
        : [slice('destination', 2000, { purchase: 'old' })];
    });
    const now = new Date('2026-10-02T12:00:00Z');
    p.clientPurchase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where: Record<string, unknown> };
      if ((a.where.status as { in?: string[] } | undefined)?.in?.includes('past_due')) return [];
      if (a.where.entitlement_active) {
        return [
          mrrRow({ client_user_id: 'c1', amount_cents: 4900 }),
          mrrRow({
            client_user_id: 'c1',
            amount_cents: 1200,
            billing_type: 'one_time',
            package: pkgCadence({ interval: null }),
          }),
          mrrRow({
            client_user_id: 'c2',
            amount_cents: 24000,
            package: pkgCadence({ interval: 'year' }),
          }),
        ];
      }
      if (a.where.canceled_at) return [{ client_user_id: 'c1' }, { client_user_id: 'c3' }];
      if ((a.where.created_at as { lt?: Date }).lt) return [{ client_user_id: 'c2' }];
      return [{ client_user_id: 'c1' }, { client_user_id: 'c2' }];
    });
    const out = await svc(p).getSummary(
      COACH,
      { from: new Date('2026-09-02T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') },
      { from: new Date('2026-08-03T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') },
      now,
    );
    expect(out.totals.net_cents).toBe(4630);
    expect(out.compare_totals?.net_cents).toBe(2000);
    expect(out.change_cents).toBe(2630);
    expect(out.change_pct).toBe(131.5);
    expect(out.held_from_next_sale_cents).toBeNull();
    expect(out.currency).toBe('usd');
    expect(out.currencies).toEqual(['usd']);
    expect(out.recurring).toEqual({
      mrr_cents: 4900 + 2000,
      paying_clients: 2,
      churned_30d: 1,
      new_clients_30d: 1,
      trial_clients: 0,
      trial_mrr_cents: 0,
    });
    for (const call of p.splitLedgerEntry.findMany.mock.calls) {
      const w = (call[0] as { where: Record<string, unknown> }).where;
      const scopedTo = (x: Record<string, unknown>) =>
        (x.purchase as { coach_user_id?: unknown } | undefined)?.coach_user_id === COACH ||
        x.payee_user_id === COACH;
      const scoped =
        scopedTo(w) ||
        (Array.isArray(w.OR) && (w.OR as Array<Record<string, unknown>>).every(scopedTo));
      expect(scoped).toBe(true);
    }
    for (const call of p.clientPurchase.findMany.mock.calls) {
      expect((call[0] as { where: { coach_user_id: string } }).where.coach_user_id).toBe(COACH);
    }
  });

  it('no compare window means null change fields', async () => {
    const p = buildPrisma();
    const out = await svc(p).getSummary(
      COACH,
      { from: new Date('2026-10-02T00:00:00Z'), to: new Date('2026-10-03T00:00:00Z') },
      null,
    );
    expect(out.compare).toBeNull();
    expect(out.change_cents).toBeNull();
    expect(out.change_pct).toBeNull();
    expect(out.totals.processing_paid_by).toBe('none');
  });
});

describe('CoachMoneyService.listCharges', () => {
  it('maps filters, selects no Stripe secrets and paginates', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockResolvedValue([
      chargeRow({ id: 'a' }),
      chargeRow({ id: 'b', status: 'payment_failed', splits: [] }),
      chargeRow({ id: 'c', refunds: [{ amount_cents: 4900 }] }),
    ]);
    const out = await svc(p).listCharges(COACH, { status: 'all', limit: 2 });
    expect(out.charges.map((c) => [c.id, c.state])).toEqual([
      ['a', 'paid'],
      ['b', 'failed'],
    ]);
    expect(out.next_cursor).toBe('b');
    const args = p.clientPurchase.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where.coach_user_id).toBe(COACH);
    expect(args.select).not.toHaveProperty('stripe_client_secret');
    expect(args.select).not.toHaveProperty('stripe_ephemeral_key');
    expect(out.charges[0].client).toEqual({ id: 'client-1', name: 'Ana Ruiz' });

    await svc(p).listCharges(COACH, { status: 'failed' });
    expect(
      (p.clientPurchase.findMany.mock.calls[1][0] as { where: { status: unknown } }).where.status,
    ).toEqual({
      in: ['past_due', 'payment_failed'],
    });
    await svc(p).listCharges(COACH, { status: 'refunded' });
    expect((p.clientPurchase.findMany.mock.calls[2][0] as { where: unknown }).where).toMatchObject(
      REFUNDED_WHERE,
    );
    await svc(p).listCharges(COACH, { status: 'paid' });
    expect((p.clientPurchase.findMany.mock.calls[3][0] as { where: unknown }).where).toMatchObject(
      PAID_WHERE,
    );
    await svc(p).listCharges(COACH, { status: 'disputed' });
    expect((p.clientPurchase.findMany.mock.calls[4][0] as { where: unknown }).where).toMatchObject(
      DISPUTED_WHERE,
    );
  });

  it('B-641-2: the paid filter excludes lost chargebacks and full refunds; refunded includes lost chargebacks', () => {
    const json = JSON.stringify(PAID_WHERE);
    expect(json).toContain('"notIn":["chargeback_lost","refunded"]');
    expect(json).toContain('"none":{"status":{"in":["lost"]}}');
    expect(JSON.stringify(REFUNDED_WHERE)).toContain('"status":"chargeback_lost"');
    expect(CHARGE_STATUS_FILTERS).toEqual(['all', 'paid', 'failed', 'refunded', 'disputed']);
  });

  it('B-641-2: lost chargeback is charged_back (never paid), won dispute is paid', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockResolvedValue([
      chargeRow({
        id: 'lost',
        status: 'chargeback_lost',
        disputes: [{ status: 'lost', amount_cents: 4900 }],
      }),
      chargeRow({ id: 'lost-status-only', status: 'chargeback_lost' }),
      chargeRow({ id: 'won', status: 'paid', disputes: [{ status: 'won', amount_cents: 4900 }] }),
    ]);
    const out = await svc(p).listCharges(COACH, { status: 'all' });
    expect(out.charges.map((c) => [c.id, c.state, c.charged_back_cents])).toEqual([
      ['lost', 'charged_back', 4900],
      ['lost-status-only', 'charged_back', 0],
      ['won', 'paid', 0],
    ]);
  });

  it('reports refunded, partially refunded, disputed and canceled states', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockResolvedValue([
      chargeRow({ id: 'r', refunds: [{ amount_cents: 4900 }] }),
      chargeRow({ id: 'pr', refunds: [{ amount_cents: 2000 }] }),
      chargeRow({ id: 'd', disputes: [{ status: 'needs_response', amount_cents: 4900 }] }),
      chargeRow({ id: 'x', status: 'expired', splits: [] }),
    ]);
    const out = await svc(p).listCharges(COACH, { status: 'all' });
    expect(out.charges.map((c) => c.state)).toEqual([
      'refunded',
      'partially_refunded',
      'disputed',
      'canceled',
    ]);
    expect(out.charges[1].refunded_cents).toBe(2000);
  });
});

describe('CoachMoneyService.getChargeBreakdown', () => {
  it('another coach’s charge is a 404 MONEY_CHARGE_NOT_FOUND', async () => {
    const p = buildPrisma();
    await expect(svc(p).getChargeBreakdown(COACH, 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const where = (
      p.clientPurchase.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }
    ).where;
    expect(where).toMatchObject({ id: 'foreign', coach_user_id: COACH });
  });

  it('settled charge: price - processing - TGP 2% = net', async () => {
    const p = buildPrisma();
    p.clientPurchase.findFirst.mockResolvedValue(chargeRow());
    p.splitLedgerEntry.findMany.mockResolvedValue([
      slice('destination', 4630),
      slice('application_fee', 98),
      slice('stripe_fee', 172),
    ]);
    const out = await svc(p).getChargeBreakdown(COACH, 'p1');
    const b = out.breakdown;
    expect(b).toMatchObject({
      price_cents: 4900,
      processing_cents: 172,
      platform_fee_cents: 98,
      net_cents: 4630,
      settled: true,
    });
    expect(b.price_cents - b.processing_cents - b.platform_fee_cents).toBe(b.net_cents);
  });

  it('a charge with no ledger yet is reported unsettled with the listed price', async () => {
    const p = buildPrisma();
    p.clientPurchase.findFirst.mockResolvedValue(chargeRow({ status: 'pending', splits: [] }));
    const out = await svc(p).getChargeBreakdown(COACH, 'p1');
    expect(out.breakdown).toMatchObject({
      price_cents: 4900,
      net_cents: 0,
      settled: false,
      processing_paid_by: 'none',
    });
  });
});

describe('CoachMoneyService.getAttention', () => {
  it('lists failed payments with dunning status, open disputes and Stripe requirements', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockResolvedValue([
      {
        id: 'p9',
        amount_cents: 4900,
        currency: 'usd',
        updated_at: new Date('2026-10-01T00:00:00Z'),
        last_error: 'Your card was declined.',
        client: { id: 'c9', name: 'Sam Lee' },
        package: { name: 'Monthly coaching' },
        dunning: {
          status: 'active',
          failure_count: 2,
          step_index: 1,
          next_attempt_at: new Date('2026-10-03T00:00:00Z'),
          locked_out_at: null,
          last_failed_amount_cents: 4900,
          last_failure_at: new Date('2026-10-01T00:00:00Z'),
          last_failure_reason: 'card_declined',
          attempts: [{ sent_at: new Date('2026-10-01T01:00:00Z') }],
        },
      },
    ]);
    p.chargeDispute.findMany.mockResolvedValue([
      {
        id: 'd1',
        purchase_id: 'p7',
        amount_cents: 4900,
        currency: 'usd',
        status: 'needs_response',
        reason: 'fraudulent',
        evidence_due_by: new Date('2026-10-10T00:00:00Z'),
        created_at: new Date('2026-09-30T00:00:00Z'),
        purchase: { client: { id: 'c7', name: '' } },
      },
    ]);
    p.connectAccount.findUnique.mockResolvedValue({
      requirements_due: {
        currently_due: ['external_account'],
        past_due: [],
        current_deadline: 1791000000,
      },
      disabled_reason: null,
    });
    const out = await svc(p).getAttention(COACH);
    // B-641-1: the link time is read from the sent DunningAttempt (the
    // production write), not from PaymentReminder (never sent).
    const sel = (
      p.clientPurchase.findMany.mock.calls[0][0] as {
        select: Record<string, { select?: Record<string, unknown> }>;
      }
    ).select;
    expect(sel).not.toHaveProperty('reminders');
    expect(sel.dunning.select?.attempts).toEqual({
      where: {
        status: 'sent',
        sent_at: { not: null },
        kind: { in: ['soft', 'urgent', 'final', 'cancelled'] },
      },
      orderBy: { sent_at: 'desc' },
      take: 1,
      select: { sent_at: true },
    });
    expect(out.count).toBe(3);
    const failed = out.items.find((i) => i.kind === 'failed_payment')!;
    expect(failed.client).toEqual({ id: 'c9', name: 'Sam Lee' });
    expect(failed.failed_payment).toMatchObject({
      attempt: 2,
      max_attempts: 4,
      next_retry_at: '2026-10-03T00:00:00.000Z',
      card_update_link_sent_at: '2026-10-01T01:00:00.000Z',
    });
    const dispute = out.items.find((i) => i.kind === 'dispute')!;
    expect(dispute.client).toEqual({ id: 'c7', name: 'Client' });
    expect(dispute.dispute?.evidence_due_by).toBe('2026-10-10T00:00:00.000Z');
    const reqItem = out.items.find((i) => i.kind === 'stripe_requirements')!;
    expect(reqItem.stripe_requirements?.currently_due).toEqual(['external_account']);
    expect(
      (p.chargeDispute.findMany.mock.calls[0][0] as { where: { purchase: unknown } }).where
        .purchase,
    ).toEqual({
      coach_user_id: COACH,
    });
  });

  it('nothing due means an empty list', async () => {
    const p = buildPrisma();
    p.connectAccount.findUnique.mockResolvedValue({
      requirements_due: {
        currently_due: [],
        past_due: [],
        eventually_due: ['individual.id_number'],
      },
      disabled_reason: null,
    });
    const out = await svc(p).getAttention(COACH);
    expect(out).toEqual({ count: 0, items: [] });
  });
});

function reversed(
  kind: string,
  amount: number,
  reversedCents: number,
  events: ReversalEvent[],
  over: Partial<ReversedSliceRow> = {},
): ReversedSliceRow {
  return {
    kind,
    payee_user_id: kind === 'destination' ? COACH : null,
    amount_cents: amount,
    reversed_cents: reversedCents,
    status: reversedCents >= amount ? 'reversed' : 'posted',
    purchase_id: 'p1',
    currency: 'usd',
    stripe_charge_id: 'ch_1',
    posted_at: new Date('2026-08-10T00:00:00Z'),
    reversed_at: null,
    created_at: new Date('2026-08-10T00:00:00Z'),
    client_name: 'Ana Ruiz',
    package_name: 'Monthly coaching',
    events,
    ...over,
  };
}

const ev = (kind: 'refund' | 'chargeback', at: string, amount: number, charge = 'ch_1') => ({
  kind,
  at: new Date(at),
  amount_cents: amount,
  stripe_charge_id: charge,
});

describe('C-641-1 — reversals land in the window they happened in', () => {
  const aug = { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') };
  const sep = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };
  const both = { from: aug.from, to: sep.to };

  it('splits one cumulative reversal across its events, summing exactly', () => {
    const s = reversed('destination', 4802, 4802, [
      ev('refund', '2026-09-20T00:00:00Z', 2900),
      ev('refund', '2026-08-20T00:00:00Z', 2000),
    ]);
    const parts = allocateReversal(s);
    expect(parts.map((x) => [x.at.toISOString().slice(0, 10), x.cents])).toEqual([
      ['2026-08-20', 1960],
      ['2026-09-20', 2842],
    ]);
    expect(parts.reduce((a, x) => a + x.cents, 0)).toBe(4802);
  });

  it('ignores events of another charge and falls back to reversed_at without events', () => {
    const other = reversed(
      'destination',
      4802,
      1000,
      [ev('refund', '2026-08-20T00:00:00Z', 1000, 'ch_other')],
      {
        reversed_at: null,
      },
    );
    expect(allocateReversal(other)).toEqual([
      { kind: 'reversal', at: other.posted_at, cents: 1000, event_amount_cents: null },
    ]);
    const legacy = reversed('destination', 4802, 4802, [], {
      reversed_at: new Date('2026-09-03T00:00:00Z'),
    });
    expect(allocateReversal(legacy)[0].at.toISOString()).toBe('2026-09-03T00:00:00.000Z');
  });

  it('a September refund of an August sale lowers September, not August; both windows equal foldTotals', () => {
    const saleDest = { ...slice('destination', 4802), posted_at: new Date('2026-08-10T00:00:00Z') };
    const saleFee = {
      ...slice('application_fee', 98),
      posted_at: new Date('2026-08-10T00:00:00Z'),
    };
    const revDest = reversed('destination', 4802, 4802, [
      ev('refund', '2026-09-15T00:00:00Z', 4900),
    ]);
    const revFee = reversed('application_fee', 98, 98, [
      ev('refund', '2026-09-15T00:00:00Z', 4900),
    ]);
    const augT = foldWindowTotals(COACH, aug, {
      salesSeller: [saleDest, saleFee],
      salesIncome: [],
      reversedSeller: [revDest, revFee],
      reversedIncome: [],
    });
    expect(augT).toMatchObject({ net_cents: 4802, refunded_cents: 0, platform_fee_cents: 98 });
    const sepT = foldWindowTotals(COACH, sep, {
      salesSeller: [],
      salesIncome: [],
      reversedSeller: [revDest, revFee],
      reversedIncome: [],
    });
    expect(sepT).toMatchObject({
      gross_cents: 0,
      net_cents: -4802,
      refunded_cents: 4802,
      platform_fee_cents: -98,
    });
    const bothT = foldWindowTotals(COACH, both, {
      salesSeller: [saleDest, saleFee],
      salesIncome: [],
      reversedSeller: [revDest, revFee],
      reversedIncome: [],
    });
    const allTime = foldTotals(
      COACH,
      [
        { ...saleDest, reversed_cents: 4802 },
        { ...saleFee, reversed_cents: 98 },
      ],
      [],
    );
    expect(bothT.net_cents).toBe(allTime.net_cents);
    expect(bothT.refunded_cents).toBe(allTime.refunded_cents);
    expect(bothT.platform_fee_cents).toBe(allTime.platform_fee_cents);
  });

  it('summary queries reversals by event time as well as by posting time', async () => {
    const p = buildPrisma();
    await svc(p).totalsFor(COACH, sep, 'usd');
    const wheres = p.splitLedgerEntry.findMany.mock.calls.map(
      (c) => (c[0] as { where: Record<string, unknown> }).where,
    );
    const reversal = wheres.filter((w) => w.reversed_cents);
    expect(reversal).toHaveLength(2);
    const json = JSON.stringify(reversal[0]);
    // B-641-6: a refund is windowed by when it succeeded (posted_at), with
    // created_at only for legacy succeeded rows that have no posted_at.
    expect(json).toContain('"refunds":{"some":{"status":"succeeded","OR":[{"posted_at"');
    expect(json).toContain('{"posted_at":null,"created_at"');
    expect(json).toContain('"disputes":{"some":{"status":{"in":["lost"]},"closed_at"');
  });
});

describe('C-641-3 — held from next sale (seam for backend #627)', () => {
  it('is null without the PayeeRecovery model and the open amount with it', async () => {
    const p = buildPrisma();
    expect(payeeRecoveryReader(p)).toBeNull();
    expect(await svc(p).heldFromNextSale(COACH, 'usd')).toBeNull();
    const findMany = jest.fn(async (_args?: unknown) => [
      { amount_cents: 300, collected_cents: 100 },
      { amount_cents: 1500, collected_cents: 0 },
      { amount_cents: 200, collected_cents: 250 },
    ]);
    const withModel = { ...p, payeeRecovery: { findMany } };
    expect(await svc(withModel).heldFromNextSale(COACH, 'usd')).toBe(1700);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { payee_user_id: COACH, status: 'open', currency: 'usd' },
      select: { amount_cents: true, collected_cents: true },
    });
    const summary = await svc(withModel).getSummary(
      COACH,
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') },
      null,
    );
    expect(summary.held_from_next_sale_cents).toBe(1700);
  });
});

describe('C-641-4 — tax CSV export', () => {
  const sep = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };

  it('formats cents without float maths and guards formula cells', () => {
    expect(centsToDecimal(4802)).toBe('48.02');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(centsToDecimal(0)).toBe('0.00');
    expect(csvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText('+1')).toBe("'+1");
    expect(csvText('Ruiz, Ana')).toBe('"Ruiz, Ana"');
  });

  it('one row per sale and per refund in the window; net_to_you sums to the summary net', () => {
    const saleDest = {
      ...slice('destination', 4630, { purchase: 'p2' }),
      stripe_charge_id: 'ch_2',
    };
    const saleFee = {
      ...slice('application_fee', 98, { purchase: 'p2' }),
      stripe_charge_id: 'ch_2',
    };
    const saleStripe = {
      ...slice('stripe_fee', 172, { purchase: 'p2' }),
      stripe_charge_id: 'ch_2',
    };
    const revDest = reversed('destination', 4802, 2401, [
      ev('refund', '2026-09-15T00:00:00Z', 2450),
    ]);
    const slices = {
      salesSeller: [saleDest, saleFee, saleStripe],
      salesIncome: [],
      reversedSeller: [revDest],
      reversedIncome: [],
    };
    const csv = buildMoneyCsv(COACH, sep, slices);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'date_utc,type,charge_id,stripe_charge_id,client,package,currency,client_paid,client_refunded,processing_fee,tgp_fee,head_coach_share,net_to_you',
    );
    expect(lines.slice(1)).toEqual([
      '2026-09-15T00:00:00.000Z,refund,p1,ch_1,Ana Ruiz,Monthly coaching,USD,,24.50,0.00,0.00,0.00,-24.01',
      '2026-09-20T10:00:00.000Z,sale,p2,ch_2,Ana Ruiz,Monthly coaching,USD,49.00,,1.72,0.98,0.00,46.30',
    ]);
    const net = lines
      .slice(1)
      .map((l) => Math.round(Number(l.split(',').pop()) * 100))
      .reduce((a, b) => a + b, 0);
    expect(net).toBe(foldWindowTotals(COACH, sep, slices).net_cents);
  });

  it('a too-large period is a 400 MONEY_EXPORT_TOO_LARGE', async () => {
    const p = buildPrisma();
    p.splitLedgerEntry.findMany.mockImplementation(async (args: unknown) => {
      const take = (args as { take?: number }).take ?? 0;
      return Array.from({ length: take }, () => slice('destination', 1));
    });
    await expect(svc(p).exportCsv(COACH, sep)).rejects.toMatchObject({
      response: { code: 'MONEY_EXPORT_TOO_LARGE' },
    });
  });
});

describe('readRequirements / deriveConnectState', () => {
  it('splits Stripe requirement buckets and converts the deadline', () => {
    const r = readRequirements({
      currently_due: ['external_account', 7],
      past_due: ['individual.verification.document'],
      eventually_due: ['individual.id_number'],
      pending_verification: ['individual.dob.day'],
      current_deadline: 1791000000,
    });
    expect(r.currently_due).toEqual(['external_account']);
    expect(r.past_due).toEqual(['individual.verification.document']);
    expect(r.eventually_due).toEqual(['individual.id_number']);
    expect(r.pending_verification).toEqual(['individual.dob.day']);
    expect(r.current_deadline).toBe(new Date(1791000000 * 1000).toISOString());
    expect(readRequirements(null).currently_due).toEqual([]);
  });

  it('derives the coach-facing state', () => {
    const base = {
      deauthorized: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      actionRequired: false,
      disabledReason: null as string | null,
    };
    expect(deriveConnectState(base)).toBe('details_needed');
    expect(deriveConnectState({ ...base, detailsSubmitted: true })).toBe('pending_verification');
    expect(
      deriveConnectState({
        ...base,
        detailsSubmitted: true,
        disabledReason: 'requirements.pending_verification',
      }),
    ).toBe('pending_verification');
    expect(deriveConnectState({ ...base, detailsSubmitted: true, actionRequired: true })).toBe(
      'restricted',
    );
    expect(
      deriveConnectState({ ...base, detailsSubmitted: true, disabledReason: 'rejected.fraud' }),
    ).toBe('restricted');
    expect(
      deriveConnectState({
        ...base,
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
    ).toBe('active');
    expect(
      deriveConnectState({
        ...base,
        deauthorized: true,
        chargesEnabled: true,
        payoutsEnabled: true,
      }),
    ).toBe('deauthorized');
  });
});

describe('CoachConnectService.refreshStatus', () => {
  // Imported lazily so the module graph above stays light.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CoachConnectService } = require('../src/coach-connect/coach-connect.service');

  function build(opts: { configured: boolean; syncMoves: boolean; syncThrows?: boolean }) {
    const t0 = new Date('2026-10-02T10:00:00Z');
    const t1 = new Date('2026-10-02T10:00:05Z');
    let row: Record<string, unknown> = {
      stripe_account_id: 'acct_1',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements_due: { currently_due: [], past_due: [], eventually_due: [] },
      disabled_reason: 'requirements.pending_verification',
      deauthorized_at: null,
      updated_at: t0,
    };
    const prisma = { connectAccount: { findUnique: jest.fn(async () => row) } };
    const connect = {
      syncFromStripe: jest.fn(async () => {
        if (opts.syncThrows) throw new Error('network');
        if (opts.syncMoves) {
          row = {
            ...row,
            charges_enabled: true,
            payouts_enabled: true,
            disabled_reason: null,
            updated_at: t1,
          };
        }
        return row;
      }),
    };
    const stripe = { isConfigured: () => opts.configured };
    const service = new CoachConnectService(prisma, connect, stripe, { ready: true }, {}, {});
    return { service, connect };
  }

  it('re-reads Stripe and reports the fresh state', async () => {
    const { service, connect } = build({ configured: true, syncMoves: true });
    const out = await service.refreshStatus('coach-1');
    expect(connect.syncFromStripe).toHaveBeenCalledWith('acct_1');
    expect(out).toMatchObject({ refreshed: true, state: 'active', configured: true });
  });

  it('reports refreshed:false with the mirrored state when Stripe did not answer', async () => {
    const unchanged = build({ configured: true, syncMoves: false });
    expect(await unchanged.service.refreshStatus('coach-1')).toMatchObject({
      refreshed: false,
      state: 'pending_verification',
    });
    const thrown = build({ configured: true, syncMoves: false, syncThrows: true });
    expect(await thrown.service.refreshStatus('coach-1')).toMatchObject({ refreshed: false });
    const off = build({ configured: false, syncMoves: true });
    expect(await off.service.refreshStatus('coach-1')).toMatchObject({ refreshed: false });
    expect(off.connect.syncFromStripe).not.toHaveBeenCalled();
  });
});

describe('ConnectOnboardingReturnController', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/connect/connect-onboarding-return.controller');

  function fakeRes() {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      body: '',
      contentType: '',
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
        return res;
      },
      type(t: string) {
        res.contentType = t;
        return res;
      },
      send(b: string) {
        res.body = b;
        return res;
      },
      headers,
    };
    return res;
  }

  it('return and refresh hand the coach back to the app with no data echoed', () => {
    const c = new mod.ConnectOnboardingReturnController();
    const r1 = fakeRes();
    c.onboardingReturn(r1);
    expect(r1.statusCode).toBe(302);
    expect(r1.headers.location).toBe('tgp://connect/onboarding/return');
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(r1.body).toContain('Open The Growth Project');
    expect(r1.body.replace('<!doctype html>', '')).not.toMatch(/!/);
    const r2 = fakeRes();
    c.onboardingRefresh(r2);
    expect(r2.headers.location).toBe('tgp://connect/onboarding/refresh');
  });

  it('both routes are @Public()', () => {
    const { IS_PUBLIC_KEY } = require('../src/common/decorators/public.decorator');
    const proto = mod.ConnectOnboardingReturnController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.onboardingReturn)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.onboardingRefresh)).toBe(true);
  });
});

// ── B-641-3 (Sol): currency-blind totals ───────────────────────────────

describe('B-641-3 — every money amount is in one named currency', () => {
  const window = { from: new Date('2026-09-02T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') };
  const now = new Date('2026-10-02T12:00:00Z');

  function mixedLedger(p: P, rows: Array<ReturnType<typeof slice>>) {
    p.splitLedgerEntry.findMany.mockImplementation(async (args: unknown) => {
      const a = args as {
        where: { kind?: string; reversed_cents?: unknown; currency?: string };
        distinct?: unknown;
      };
      if (a.distinct)
        return [...new Set(rows.map((r) => r.currency))].map((currency) => ({ currency }));
      if (a.where.kind === 'head_coach_split' || a.where.reversed_cents) return [];
      return rows.filter((r) => a.where.currency === undefined || r.currency === a.where.currency);
    });
  }
  const eur = (kind: string, amount: number) => ({
    ...slice(kind, amount, { purchase: 'pe' }),
    currency: 'eur',
  });

  it('USD 9,800 + EUR 9,800 is never summed: default is USD 9,800 and EUR is listed', async () => {
    const p = buildPrisma();
    mixedLedger(p, [slice('destination', 9800), eur('destination', 9800)]);
    const out = await svc(p).getSummary(COACH, window, null, now);
    expect(out.currency).toBe('usd');
    expect(out.currencies).toEqual(['eur', 'usd']);
    expect(out.totals.net_cents).toBe(9800);
    expect(out.totals.gross_cents).toBe(9800);
    for (const call of p.splitLedgerEntry.findMany.mock.calls) {
      const a = call[0] as { where: { currency?: string }; distinct?: unknown };
      if (!a.distinct) expect(a.where.currency).toBe('usd');
    }
  });

  it('?currency=eur returns the EUR totals, labelled eur', async () => {
    const p = buildPrisma();
    mixedLedger(p, [slice('destination', 9800), eur('destination', 4500)]);
    const out = await svc(p).getSummary(COACH, window, null, now, 'eur');
    expect(out.currency).toBe('eur');
    expect(out.totals.net_cents).toBe(4500);
  });

  it('a coach who only sells in GBP gets a GBP summary, not a USD label', async () => {
    const p = buildPrisma();
    mixedLedger(p, [{ ...slice('destination', 7000), currency: 'gbp' }]);
    const out = await svc(p).getSummary(COACH, window, null, now);
    expect(out.currency).toBe('gbp');
    expect(out.totals.net_cents).toBe(7000);
  });

  it('MRR only counts subscriptions in the summary currency', async () => {
    const p = buildPrisma();
    mixedLedger(p, [slice('destination', 100)]);
    p.clientPurchase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where: Record<string, unknown> };
      if (a.where.entitlement_active) {
        return [
          mrrRow({ client_user_id: 'c1', amount_cents: 4900 }),
          mrrRow({ client_user_id: 'c2', amount_cents: 9900, currency: 'eur' }),
        ];
      }
      return [];
    });
    const out = await svc(p).getSummary(COACH, window, null, now);
    expect(out.recurring.mrr_cents).toBe(4900);
    expect(out.recurring.paying_clients).toBe(2);
  });

  it('parseCurrency validates with a stable code; defaultCurrency is deterministic', () => {
    expect(parseCurrency(undefined)).toBeNull();
    expect(parseCurrency('EUR')).toBe('eur');
    try {
      parseCurrency('jpy');
      throw new Error('expected MONEY_CURRENCY_INVALID');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: 'MONEY_CURRENCY_INVALID',
      });
    }
    expect(defaultCurrency([])).toBe('usd');
    expect(defaultCurrency(['eur', 'usd'])).toBe('usd');
    expect(defaultCurrency(['gbp'])).toBe('gbp');
    expect(defaultCurrency(['gbp', 'eur'])).toBe('eur');
  });
});

// ── B-641-4 (Sol): MRR at the real billing cadence ─────────────────────

describe('B-641-4 — MRR uses the real cadence and interval count', () => {
  it('quarterly USD 120 is 4,000 cents a month (was 12,000)', () => {
    expect(monthlyEquivalent({ amount_cents: 12000, interval: 'month', interval_count: 3 })).toBe(
      4000,
    );
  });
  it('weekly USD 25 is 25 x 52 / 12 a month', () => {
    expect(
      Math.round(monthlyEquivalent({ amount_cents: 2500, interval: 'week', interval_count: 1 })),
    ).toBe(10833);
    expect(
      Math.round(monthlyEquivalent({ amount_cents: 5000, interval: 'week', interval_count: 2 })),
    ).toBe(10833);
  });
  it('every 2 years USD 2,400 is 10,000 cents a month; yearly USD 240 is 2,000', () => {
    expect(monthlyEquivalent({ amount_cents: 240000, interval: 'year', interval_count: 2 })).toBe(
      10000,
    );
    expect(monthlyEquivalent({ amount_cents: 24000, interval: 'year', interval_count: 1 })).toBe(
      2000,
    );
  });
  it('combo package: MRR is the recurring companion, not the one-time charge', () => {
    const c = recurringCadenceOf({
      amount_cents: 50000,
      package: pkgCadence({
        interval: null,
        recurring_amount_cents: 9000,
        recurring_interval: 'month',
        recurring_interval_count: 3,
      }),
    });
    expect(c).toEqual({ amount_cents: 9000, interval: 'month', interval_count: 3 });
    expect(monthlyEquivalent(c)).toBe(3000);
  });

  it('summary MRR: quarterly + weekly + 2-year + combo, rounded once; non-billing rows excluded', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where: Record<string, unknown> };
      if (!a.where.entitlement_active) return [];
      return [
        mrrRow({
          client_user_id: 'q',
          amount_cents: 12000,
          package: pkgCadence({ interval_count: 3 }),
        }),
        mrrRow({
          client_user_id: 'w',
          amount_cents: 2500,
          package: pkgCadence({ interval: 'week' }),
        }),
        mrrRow({
          client_user_id: 'y',
          amount_cents: 240000,
          package: pkgCadence({ interval: 'year', interval_count: 2 }),
        }),
        mrrRow({
          client_user_id: 'combo',
          amount_cents: 50000,
          package: pkgCadence({
            interval: null,
            recurring_amount_cents: 9000,
            recurring_interval: 'month',
          }),
        }),
        // Subscription that will not bill again (entitlement runs to period end).
        mrrRow({ client_user_id: 'z', amount_cents: 7000, status: 'canceled' }),
      ];
    });
    const out = await svc(p).getSummary(
      COACH,
      { from: new Date('2026-09-02T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z') },
      null,
      new Date('2026-10-02T12:00:00Z'),
    );
    // 4000 + 10833.33 + 10000 + 9000 = 33833.33 -> 33833
    expect(out.recurring.mrr_cents).toBe(33833);
  });
});

// Sol AUD-SOL-5 probes, ported (ops/evidence/AUD-SOL-5-112/aud-sol5-money.spec.ts):
// a ledger double that ignores the currency scope still must not produce a
// summed USD label, and the quarterly fixture is USD 40 MRR.
describe('AUD-SOL-5 probes (failing before at 563e3f80)', () => {
  const window = { from: new Date('2026-09-02Z'), to: new Date('2026-10-02Z') };
  const probeSlice = (currency: string, purchase: string) => ({
    ...slice('destination', 9800, { purchase }),
    currency,
  });
  it('B-641-3: mixed currencies are not added and labelled USD', async () => {
    const p = buildPrisma();
    p.splitLedgerEntry.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where: { kind?: string }; distinct?: unknown };
      if (a.distinct) return [{ currency: 'eur' }, { currency: 'usd' }];
      return a.where.kind === 'head_coach_split'
        ? []
        : [probeSlice('usd', 'p-usd'), probeSlice('eur', 'p-eur')];
    });
    const out = await svc(p).getSummary(COACH, window, null);
    expect(out.currency === 'usd' && out.totals.net_cents === 19600).toBe(false);
    expect(out).toMatchObject({ currency: 'usd', totals: { net_cents: 9800 } });
  });
  it('B-641-4: a USD 120 quarterly subscription is USD 40 MRR, not USD 120', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockImplementation(async (args: unknown) =>
      (args as { where: Record<string, unknown> }).where.entitlement_active
        ? [
            mrrRow({
              client_user_id: 'client',
              amount_cents: 12000,
              package: pkgCadence({ interval_count: 3 }),
            }),
          ]
        : [],
    );
    const out = await svc(p).getSummary(COACH, window, null);
    expect(out.recurring.mrr_cents).toBe(4000);
  });
});

describe('B-332-2 — every charge names the cadence it bills at (S-COACH-3)', () => {
  it.each([
    ['monthly', { interval: 'month', interval_count: 1 }, 'month', 1],
    ['every 3 months', { interval: 'month', interval_count: 3 }, 'month', 3],
    ['weekly', { interval: 'week', interval_count: 1 }, 'week', 1],
    ['yearly', { interval: 'year', interval_count: 1 }, 'year', 1],
    [
      'combo package bills at the companion interval',
      { interval: null, recurring_amount_cents: 2900, recurring_interval: 'week', recurring_interval_count: 2 },
      'week',
      2,
    ],
  ])('%s', async (_label, pkg, unit, count) => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockResolvedValueOnce([
      chargeRow({ package: { id: 'pkg-1', name: 'Coaching', ...pkgCadence(pkg) } }),
    ]);
    const out = await svc(p).listCharges(COACH, { status: 'all' });
    expect(out.charges[0]).toMatchObject({ billing_interval: unit, billing_interval_count: count });
  });

  it('one-time charges and unknown intervals carry null, never a guessed Monthly', () => {
    expect(chargeCadence('one_time', pkgCadence())).toEqual({
      billing_interval: null,
      billing_interval_count: null,
    });
    expect(chargeCadence('recurring', pkgCadence({ interval: 'fortnight' }))).toEqual({
      billing_interval: null,
      billing_interval_count: null,
    });
    expect(chargeCadence('recurring', null)).toEqual({
      billing_interval: null,
      billing_interval_count: null,
    });
  });

  it('the charge select reads the package cadence columns', async () => {
    const p = buildPrisma();
    await svc(p).listCharges(COACH, { status: 'all' });
    const sel = JSON.stringify(p.clientPurchase.findMany.mock.calls[0][0]);
    for (const col of ['interval', 'interval_count', 'recurring_interval', 'recurring_interval_count']) {
      expect(sel).toContain(`"${col}":true`);
    }
  });
});

describe('C-641-6 — the tax export can be limited to one currency (S-COACH-3)', () => {
  const sep = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };

  it('?currency= scopes every query to that currency', async () => {
    const p = buildPrisma();
    await svc(p).exportCsv(COACH, sep, 'gbp');
    const calls = p.splitLedgerEntry.findMany.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) expect(JSON.stringify(args)).toContain('"currency":"gbp"');
  });

  it('no currency keeps every currency (each row names its own)', async () => {
    const p = buildPrisma();
    await svc(p).exportCsv(COACH, sep);
    for (const [args] of p.splitLedgerEntry.findMany.mock.calls)
      expect(JSON.stringify(args)).not.toContain('"currency":"');
  });

  it('an unsupported currency is the specific MONEY_CURRENCY_INVALID', () => {
    expect(() => parseCurrency('xyz')).toThrow(BadRequestException);
  });
});
