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
  CoachMoneyService,
  changePct,
  foldTotals,
  parseWindow,
  readRequirements,
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

describe('CoachMoneyService.getSummary', () => {
  it('returns totals, compare totals, change and recurring numbers, all scoped to the caller', async () => {
    const p = buildPrisma();
    p.splitLedgerEntry.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { where: { kind?: string; OR: Array<{ posted_at?: { gte: Date } }> } };
      if (a.where.kind === 'head_coach_split') return [];
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
          {
            client_user_id: 'c1',
            amount_cents: 4900,
            billing_type: 'recurring',
            package: { interval: 'month' },
          },
          {
            client_user_id: 'c1',
            amount_cents: 1200,
            billing_type: 'one_time',
            package: { interval: null },
          },
          {
            client_user_id: 'c2',
            amount_cents: 24000,
            billing_type: 'recurring',
            package: { interval: 'year' },
          },
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
    expect(out.recurring).toEqual({
      mrr_cents: 4900 + 2000,
      paying_clients: 2,
      churned_30d: 1,
      new_clients_30d: 1,
    });
    for (const call of p.splitLedgerEntry.findMany.mock.calls) {
      const w = (call[0] as { where: Record<string, unknown> }).where;
      const scoped =
        (w.purchase as { coach_user_id?: unknown })?.coach_user_id === COACH ||
        w.payee_user_id === COACH;
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
    expect(
      (p.clientPurchase.findMany.mock.calls[2][0] as { where: { refunds: unknown } }).where.refunds,
    ).toEqual({
      some: { status: 'succeeded' },
    });
    await svc(p).listCharges(COACH, { status: 'paid' });
    expect(
      (p.clientPurchase.findMany.mock.calls[3][0] as { where: { OR: unknown[] } }).where.OR,
    ).toHaveLength(2);
  });

  it('reports refunded, partially refunded, disputed and canceled states', async () => {
    const p = buildPrisma();
    p.clientPurchase.findMany.mockResolvedValue([
      chargeRow({ id: 'r', refunds: [{ amount_cents: 4900 }] }),
      chargeRow({ id: 'pr', refunds: [{ amount_cents: 2000 }] }),
      chargeRow({ id: 'd', disputes: [{ status: 'needs_response' }] }),
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
        },
        reminders: [{ sent_at: new Date('2026-10-01T01:00:00Z') }],
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
