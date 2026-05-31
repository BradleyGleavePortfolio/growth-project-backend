import { NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminPaymentOpsController,
  CoachPaymentOpsController,
} from '../src/checkout/payment-ops.controller';
import { CursorPageQueryDto } from '../src/checkout/payment-ops.dto';
import { DunningService } from '../src/checkout/dunning.service';
import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';

function makePrismaStub() {
  const purchases: any[] = [];
  const splits: any[] = [];
  const transfers: any[] = [];
  const dunning: any[] = [];
  const reminders: any[] = [];
  const accounts: any[] = [];
  const packages: any[] = [];
  const feePolicies: any[] = [];
  return {
    _purchases: purchases,
    _splits: splits,
    _transfers: transfers,
    _dunning: dunning,
    _reminders: reminders,
    _accounts: accounts,
    _packages: packages,
    _feePolicies: feePolicies,
    clientPurchase: {
      findMany: jest.fn(async ({ where = {}, take, cursor, skip }: any) => {
        let matched = purchases.filter((p) =>
          Object.entries(where).every(([k, v]: any) => {
            if (k === 'OR' && Array.isArray(v)) {
              return v.some((clause: any) =>
                Object.entries(clause).every(([ck, cv]: any) => p[ck] === cv),
              );
            }
            return p[k] === v;
          }),
        );
        if (cursor && cursor.id) {
          const idx = matched.findIndex((p) => p.id === cursor.id);
          if (idx >= 0) matched = matched.slice(idx + (skip ?? 0));
        }
        if (typeof take === 'number') matched = matched.slice(0, take);
        return matched;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
      ),
      findFirst: jest.fn(async ({ where = {} }: any) =>
        purchases.find((p) =>
          Object.entries(where).every(([k, v]: any) => p[k] === v),
        ) ?? null,
      ),
      count: jest.fn(async ({ where = {} }: any) =>
        purchases.filter((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ).length,
      ),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where = {}, take, cursor, skip }: any) => {
        let matched = splits.filter((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        );
        // Honor cursor pagination so the bounds tests exercise the real
        // take+cursor path: drop everything up to and including the cursor
        // row, then slice to `take`.
        if (cursor && cursor.id) {
          const idx = matched.findIndex((s) => s.id === cursor.id);
          if (idx >= 0) matched = matched.slice(idx + (skip ?? 0));
        }
        if (typeof take === 'number') matched = matched.slice(0, take);
        return matched;
      }),
      groupBy: jest.fn(async ({ where = {} }: any) => {
        const matched = splits.filter((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        );
        const byStatus = new Map<string, { amount: number; reversed: number }>();
        for (const s of matched) {
          const acc = byStatus.get(s.status) ?? { amount: 0, reversed: 0 };
          acc.amount += s.amount_cents ?? 0;
          acc.reversed += s.reversed_cents ?? 0;
          byStatus.set(s.status, acc);
        }
        return Array.from(byStatus.entries()).map(([status, sums]) => ({
          status,
          _sum: { amount_cents: sums.amount, reversed_cents: sums.reversed },
        }));
      }),
    },
    connectTransfer: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        transfers.filter((t) =>
          Object.entries(where).every(([k, v]) => t[k] === v),
        ),
      ),
    },
    dunningState: {
      findUnique: jest.fn(async ({ where }: any) =>
        dunning.find((d) => d.purchase_id === where.purchase_id) ?? null,
      ),
      findMany: jest.fn(async ({ where = {} }: any) =>
        dunning.filter((d) =>
          Object.entries(where).every(([k, v]) => d[k] === v),
        ),
      ),
    },
    paymentReminder: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        reminders.filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        ),
      ),
    },
    connectAccount: {
      findUnique: jest.fn(async ({ where }: any) =>
        accounts.find((a) => a.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
    coachPackage: {
      findMany: jest.fn(async () => packages),
    },
    feePolicy: {
      findUnique: jest.fn(async ({ where }: any) =>
        feePolicies.find((p) => p.coach_id === where.coach_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = feePolicies.find((p) => p.coach_id === where.coach_id);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: 'fp-' + (feePolicies.length + 1), ...create };
        feePolicies.push(row);
        return { ...row };
      }),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async () => null),
    },
  };
}

function makeAdminController() {
  const prisma = makePrismaStub();
  const fee = new FeePolicyService(prisma as any);
  const ledger = new SplitLedgerService(prisma as any);
  // Light stubs for DunningService + PurchaseSplitHandlerService — these
  // tests only need their public sweeper entry points to exist.
  const dunning = {
    runSweeper: jest.fn(async () => ({ scanned: 1, canceled: 0, final_warned: 0 })),
  } as unknown as DunningService;
  const splits = {
    runTransferSweeper: jest.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 })),
  } as unknown as PurchaseSplitHandlerService;
  // Phase 6-7 stubs — tests in this file pre-date Phase 6-7. The new
  // services are exercised in their own spec files; here we just need
  // the constructor shapes to line up.
  const payoutReadiness = {
    getForCoach: jest.fn(),
    runStaleSweep: jest.fn(),
  } as any;
  const reconciliation = {
    reconcilePurchase: jest.fn(),
    listDrift: jest.fn(),
    runSweep: jest.fn(),
  } as any;
  const refundDispute = {
    listRefunds: jest.fn(),
    listDisputes: jest.fn(),
    createAdminRefund: jest.fn(),
  } as any;
  const analytics = {
    getEnterpriseRollup: jest.fn(),
    getCoachEarnings: jest.fn(),
  } as any;
  const stripeConnect = {
    retrieveBalance: jest.fn(),
    listPayouts: jest.fn(),
    listBalanceTransactions: jest.fn(),
  } as any;
  const ctrl = new AdminPaymentOpsController(
    prisma as any,
    fee,
    ledger,
    dunning,
    splits,
    payoutReadiness,
    reconciliation,
    refundDispute,
    analytics,
    stripeConnect,
  );
  return { ctrl, prisma, fee, dunning, splits, payoutReadiness, reconciliation, refundDispute, analytics, stripeConnect };
}

function makeCoachController() {
  const prisma = makePrismaStub();
  const fee = new FeePolicyService(prisma as any);
  const ledger = new SplitLedgerService(prisma as any);
  const payoutReadiness = { getForCoach: jest.fn() } as any;
  const analytics = { getCoachEarnings: jest.fn() } as any;
  const ctrl = new CoachPaymentOpsController(
    prisma as any,
    fee,
    ledger,
    payoutReadiness,
    analytics,
  );
  return { ctrl, prisma, payoutReadiness, analytics };
}

describe('AdminPaymentOpsController', () => {
  it('lists purchases with optional status filter', async () => {
    const { ctrl, prisma } = makeAdminController();
    prisma._purchases.push(
      { id: 'p1', status: 'paid', created_at: new Date() },
      { id: 'p2', status: 'past_due', created_at: new Date() },
    );
    const all = await ctrl.listPurchases();
    expect(all.purchases).toHaveLength(2);
    const filtered = await ctrl.listPurchases('past_due');
    expect(filtered.purchases).toHaveLength(1);
    expect(filtered.purchases[0].id).toBe('p2');
  });

  it('returns 404 for an unknown purchase', async () => {
    const { ctrl } = makeAdminController();
    await expect(ctrl.getPurchase('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the full payment picture for a known purchase', async () => {
    const { ctrl, prisma } = makeAdminController();
    prisma._purchases.push({
      id: 'p1',
      coach_user_id: 'coach-1',
      client_user_id: 'cli-1',
      amount_cents: 10_000,
      currency: 'usd',
      status: 'paid',
    });
    prisma._splits.push(
      { id: 'le1', purchase_id: 'p1', kind: 'application_fee', amount_cents: 200, status: 'posted' },
      { id: 'le2', purchase_id: 'p1', kind: 'destination', amount_cents: 9_800, status: 'posted' },
    );
    prisma._transfers.push({ id: 't1', purchase_id: 'p1', status: 'succeeded' });
    prisma._reminders.push({ id: 'r1', purchase_id: 'p1', kind: 'payment_failed' });
    const result = await ctrl.getPurchase('p1');
    expect(result.purchase.id).toBe('p1');
    expect(result.split_ledger).toHaveLength(2);
    expect(result.transfers).toHaveLength(1);
    expect(result.reminders).toHaveLength(1);
    expect(result.fee_policy.platform_application_fee_bps).toBe(200);
  });

  it('lists active dunning rows under /failed', async () => {
    const { ctrl, prisma } = makeAdminController();
    prisma._dunning.push(
      { id: 'd1', status: 'active', last_failure_at: new Date() },
      { id: 'd2', status: 'resolved', last_failure_at: new Date() },
    );
    const out = await ctrl.listFailedPayments();
    expect(out.failed_payments).toHaveLength(1);
    expect(out.failed_payments[0].id).toBe('d1');
  });

  it('lists transfers filtered by status', async () => {
    const { ctrl, prisma } = makeAdminController();
    prisma._transfers.push(
      { id: 't1', status: 'succeeded' },
      { id: 't2', status: 'pending' },
    );
    const out = await ctrl.listTransfers('pending');
    expect(out.transfers).toHaveLength(1);
    expect(out.transfers[0].id).toBe('t2');
  });

  it('lists ledger filtered by kind + payee', async () => {
    const { ctrl, prisma } = makeAdminController();
    prisma._splits.push(
      { id: 'l1', kind: 'destination', payee_user_id: 'coach-1', status: 'posted' },
      { id: 'l2', kind: 'application_fee', payee_user_id: null, status: 'posted' },
    );
    const out = await ctrl.listLedger('destination', undefined, 'coach-1');
    expect(out.ledger).toHaveLength(1);
    expect(out.ledger[0].id).toBe('l1');
  });

  it('updates a coach fee-policy override', async () => {
    const { ctrl } = makeAdminController();
    const row = await ctrl.updateCoachFeePolicy('coach-1', {
      platform_application_fee_bps: 100,
      head_coach_split_bps: 300,
      notes: 'enterprise',
    });
    expect(row.platform_application_fee_bps).toBe(100);
  });

  it('reports coach connect-readiness for the payment-ready widget', async () => {
    const { ctrl, prisma } = makeAdminController();
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_x',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._packages.push({ id: 'pk1', coach_id: 'coach-1' });
    prisma._purchases.push({ id: 'p1', coach_user_id: 'coach-1' });
    const out = await ctrl.getCoachConnect('coach-1');
    expect(out.payment_ready).toBe(true);
    expect(out.packages).toHaveLength(1);
    expect(out.lifetime_purchase_count).toBe(1);
  });

  it('runs the dunning + transfer sweepers on demand', async () => {
    const { ctrl, dunning, splits } = makeAdminController();
    await ctrl.runDunningSweeper();
    await ctrl.runTransferSweeper();
    expect((dunning.runSweeper as jest.Mock)).toHaveBeenCalled();
    expect((splits.runTransferSweeper as jest.Mock)).toHaveBeenCalled();
  });

  // --- Phase 6-7 wiring ---

  it('getCoachPayoutReadiness delegates to PayoutReadinessService', async () => {
    const { ctrl, payoutReadiness } = makeAdminController();
    payoutReadiness.getForCoach.mockResolvedValue({ readiness_status: 'ready' });
    const out = await ctrl.getCoachPayoutReadiness('coach-1', 'true');
    expect(payoutReadiness.getForCoach).toHaveBeenCalledWith('coach-1', {
      forceRefresh: true,
    });
    expect(out.readiness_status).toBe('ready');
  });

  it('getCoachBalance returns 404 when ConnectAccount is missing', async () => {
    const { ctrl } = makeAdminController();
    const { NotFoundException } = await import('@nestjs/common');
    await expect(ctrl.getCoachBalance('ghost-coach')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getCoachBalance returns stripe balance + payouts when account exists', async () => {
    const { ctrl, prisma, stripeConnect } = makeAdminController();
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_x',
    });
    stripeConnect.retrieveBalance.mockResolvedValue({
      available: [{ amount: 10_000, currency: 'usd' }],
      pending: [],
    });
    stripeConnect.listPayouts.mockResolvedValue({
      data: [{ id: 'po_1', amount: 500, status: 'paid' }],
    });
    const out = await ctrl.getCoachBalance('coach-1');
    expect(out.stripe_account_id).toBe('acct_x');
    expect(out.payouts).toHaveLength(1);
  });

  it('getReconciliation delegates to ReconciliationService', async () => {
    const { ctrl, reconciliation } = makeAdminController();
    reconciliation.reconcilePurchase.mockResolvedValue({
      status: 'ok',
      drift_cents: 0,
    });
    const out = await ctrl.getReconciliation('p1');
    expect(reconciliation.reconcilePurchase).toHaveBeenCalledWith('p1');
    expect(out.status).toBe('ok');
  });

  it('listReconciliationDrift exposes the drift feed', async () => {
    const { ctrl, reconciliation } = makeAdminController();
    reconciliation.listDrift.mockResolvedValue([{ purchase_id: 'p1', drift_cents: 500 }]);
    const out = await ctrl.listReconciliationDrift();
    expect(out.drift).toHaveLength(1);
  });

  it('listRefunds + listDisputes return rows via RefundDisputeHandlerService', async () => {
    const { ctrl, refundDispute } = makeAdminController();
    refundDispute.listRefunds.mockResolvedValue([{ id: 'r1' }]);
    refundDispute.listDisputes.mockResolvedValue([{ id: 'd1' }]);
    const refunds = await ctrl.listRefunds('succeeded');
    const disputes = await ctrl.listDisputes();
    expect(refunds.refunds).toHaveLength(1);
    expect(disputes.disputes).toHaveLength(1);
  });

  it('refundPurchase validates amount_cents and forwards initiated_by_user_id', async () => {
    const { ctrl, refundDispute } = makeAdminController();
    refundDispute.createAdminRefund.mockResolvedValue({ id: 'rf1' });
    const req: any = { user: { id: 'owner-1', role: 'owner' } };
    const result = await ctrl.refundPurchase(req, 'p1', {
      amount_cents: 5_000,
      reason: 'requested_by_customer',
    });
    expect(refundDispute.createAdminRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        purchase_id: 'p1',
        amount_cents: 5_000,
        initiated_by_user_id: 'owner-1',
      }),
    );
    expect(result.id).toBe('rf1');
  });

  it('refundPurchase rejects bad amount_cents', async () => {
    const { ctrl } = makeAdminController();
    const { BadRequestException } = await import('@nestjs/common');
    const req: any = { user: { id: 'owner-1', role: 'owner' } };
    await expect(
      ctrl.refundPurchase(req, 'p1', { amount_cents: -10 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getEnterpriseRollup parses ISO dates + groupBy', async () => {
    const { ctrl, analytics } = makeAdminController();
    analytics.getEnterpriseRollup.mockResolvedValue({ gmv_cents: 0 });
    await ctrl.getEnterpriseRollup('2026-01-01', '2026-02-01', 'month');
    const call = analytics.getEnterpriseRollup.mock.calls[0][0];
    expect(call.groupBy).toBe('month');
    expect(call.from).toBeInstanceOf(Date);
    expect(call.to).toBeInstanceOf(Date);
  });

  it('getEnterpriseRollup rejects an unknown groupBy', async () => {
    const { ctrl } = makeAdminController();
    const { BadRequestException } = await import('@nestjs/common');
    await expect(
      ctrl.getEnterpriseRollup(undefined, undefined, 'weekly' as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('runReconciliationSweeper + runPayoutReadinessSweeper delegate', async () => {
    const { ctrl, reconciliation, payoutReadiness } = makeAdminController();
    reconciliation.runSweep.mockResolvedValue({ scanned: 0, drifted: 0, unknown: 0 });
    payoutReadiness.runStaleSweep.mockResolvedValue({ scanned: 0, refreshed: 0, failed: 0 });
    await ctrl.runReconciliationSweeper();
    await ctrl.runPayoutReadinessSweeper();
    expect(reconciliation.runSweep).toHaveBeenCalled();
    expect(payoutReadiness.runStaleSweep).toHaveBeenCalled();
  });
});

describe('CoachPaymentOpsController', () => {
  function makeReq(userId: string, role: 'coach' | 'owner' = 'coach') {
    return { user: { id: userId, role } } as any;
  }

  it('returns only the coach own purchases', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._purchases.push(
      { id: 'p1', coach_user_id: 'me', created_at: new Date() },
      { id: 'p2', coach_user_id: 'other', created_at: new Date() },
    );
    const out = await ctrl.listOwn(makeReq('me'), {});
    expect(out.purchases).toHaveLength(1);
    expect(out.purchases[0].id).toBe('p1');
    expect(out.next_cursor).toBeNull();
  });

  // Security-fix update (A1-P0-2): handler now scopes the WHERE by
  // coach_user_id for non-owner callers, so a foreign-owned purchase
  // and a nonexistent purchase both surface as 404 PURCHASE_NOT_FOUND.
  // Previous assertion expected 403 NOT_YOUR_PURCHASE which leaked the
  // existence of other coaches' purchase IDs.
  it('collapses a foreign coach purchase into 404 PURCHASE_NOT_FOUND (no 403-vs-404 enumeration)', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._purchases.push({
      id: 'p1',
      coach_user_id: 'other',
      client_user_id: 'cli',
    });
    await expect(ctrl.getOwn(makeReq('me'), 'p1')).rejects.toMatchObject({
      response: { error: 'PURCHASE_NOT_FOUND' },
    });
    await expect(ctrl.getOwn(makeReq('me'), 'p1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('owner can inspect any purchase via the coach surface', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._purchases.push({
      id: 'p1',
      coach_user_id: 'other',
      client_user_id: 'cli',
    });
    const out = await ctrl.getOwn(makeReq('owner-id', 'owner'), 'p1');
    expect(out.purchase.id).toBe('p1');
  });

  it('summarises earnings by status', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._splits.push(
      {
        id: 'l1',
        payee_user_id: 'me',
        kind: 'destination',
        amount_cents: 9_800,
        reversed_cents: 0,
        status: 'posted',
        created_at: new Date(),
      },
      {
        id: 'l2',
        payee_user_id: 'me',
        kind: 'destination',
        amount_cents: 9_300,
        reversed_cents: 0,
        status: 'pending',
        created_at: new Date(),
      },
      {
        id: 'l3',
        payee_user_id: 'me',
        kind: 'destination',
        amount_cents: 500,
        reversed_cents: 0,
        status: 'reversed',
        created_at: new Date(),
      },
    );
    const out = await ctrl.earnings(makeReq('me'), {});
    expect(out.summary.posted_cents).toBe(9_800);
    expect(out.summary.pending_cents).toBe(9_300);
    expect(out.summary.reversed_cents).toBe(500);
    expect(out.entries).toHaveLength(3);
    expect(out.next_cursor).toBeNull();
  });

  it('returns failed/past_due purchases on the coach roster', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._purchases.push(
      { id: 'p1', coach_user_id: 'me', status: 'past_due' },
      { id: 'p2', coach_user_id: 'me', status: 'paid' },
      { id: 'p3', coach_user_id: 'other', status: 'past_due' },
    );
    prisma.clientPurchase.findMany = jest.fn(async ({ where }: any) =>
      prisma._purchases.filter(
        (p: any) =>
          p.coach_user_id === where.coach_user_id &&
          where.OR.some((c: any) => c.status === p.status),
      ),
    );
    const out = await ctrl.failedOnRoster(makeReq('me'));
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].id).toBe('p1');
  });

  it('exposes the effective fee-policy snapshot for the coach', async () => {
    const { ctrl } = makeCoachController();
    const out = await ctrl.getOwnFeePolicy(makeReq('me'));
    expect(out.policy.platform_application_fee_bps).toBe(200);
    expect(out.override).toBeNull();
  });

  it('payout-readiness is scoped to the calling coach', async () => {
    const { ctrl, payoutReadiness } = makeCoachController();
    payoutReadiness.getForCoach.mockResolvedValue({ readiness_status: 'ready' });
    await ctrl.getOwnPayoutReadiness(makeReq('me'));
    expect(payoutReadiness.getForCoach).toHaveBeenCalledWith('me', {
      forceRefresh: false,
    });
  });

  it('summary endpoint delegates to AdminAnalyticsService.getCoachEarnings', async () => {
    const { ctrl, analytics } = makeCoachController();
    analytics.getCoachEarnings.mockResolvedValue({ coach_user_id: 'me' });
    await ctrl.getOwnEarningsSummary(makeReq('me'), '2026-04-01', '2026-05-01');
    expect(analytics.getCoachEarnings).toHaveBeenCalledWith(
      'me',
      expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) }),
    );
  });

  // --- B5: listOwn bounded cursor pagination ---

  it('B5: listOwn caps the page at the requested limit and returns a next_cursor', async () => {
    const { ctrl, prisma } = makeCoachController();
    for (let i = 0; i < 5; i++) {
      prisma._purchases.push({
        id: `p${i}`,
        coach_user_id: 'me',
        created_at: new Date(2026, 0, 10 - i),
      });
    }
    const page = await ctrl.listOwn(makeReq('me'), { limit: 2 });
    expect(page.purchases).toHaveLength(2);
    expect(page.purchases[0].id).toBe('p0');
    expect(page.purchases[1].id).toBe('p1');
    // 5 rows, page of 2 -> there IS a next page, cursor is the last row id.
    expect(page.next_cursor).toBe('p1');
  });

  it('B5: listOwn cursor returns the following page', async () => {
    const { ctrl, prisma } = makeCoachController();
    for (let i = 0; i < 5; i++) {
      prisma._purchases.push({
        id: `p${i}`,
        coach_user_id: 'me',
        created_at: new Date(2026, 0, 10 - i),
      });
    }
    const next = await ctrl.listOwn(makeReq('me'), { limit: 2, cursor: 'p1' });
    expect(next.purchases.map((p: any) => p.id)).toEqual(['p2', 'p3']);
    expect(next.next_cursor).toBe('p3');
  });

  it('B5: listOwn last page reports next_cursor=null', async () => {
    const { ctrl, prisma } = makeCoachController();
    for (let i = 0; i < 4; i++) {
      prisma._purchases.push({
        id: `p${i}`,
        coach_user_id: 'me',
        created_at: new Date(2026, 0, 10 - i),
      });
    }
    const last = await ctrl.listOwn(makeReq('me'), { limit: 2, cursor: 'p1' });
    expect(last.purchases.map((p: any) => p.id)).toEqual(['p2', 'p3']);
    expect(last.next_cursor).toBeNull();
  });

  it('B5: listOwn scope still filters by coach_user_id (a different coach sees none)', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._purchases.push(
      { id: 'p1', coach_user_id: 'me', created_at: new Date() },
      { id: 'p2', coach_user_id: 'other', created_at: new Date() },
    );
    const mine = await ctrl.listOwn(makeReq('me'), {});
    expect(mine.purchases).toHaveLength(1);
    const theirs = await ctrl.listOwn(makeReq('stranger'), {});
    expect(theirs.purchases).toHaveLength(0);
  });

  // --- B6: earnings cursor pagination + full-ledger summary + export ---

  function seedLedger(prisma: any, payee: string, n: number) {
    for (let i = 0; i < n; i++) {
      prisma._splits.push({
        id: `${payee}-le${i}`,
        payee_user_id: payee,
        purchase_id: `pur${i}`,
        kind: 'destination',
        amount_cents: 100,
        reversed_cents: 0,
        status: 'posted',
        currency: 'usd',
        created_at: new Date(2026, 0, 1, 0, 0, n - i),
      });
    }
  }

  it('B6: summary aggregates the FULL ledger even when the page is truncated past 200', async () => {
    const { ctrl, prisma } = makeCoachController();
    // 250 posted entries of 100c each -> full posted total must be 25_000c,
    // NOT the 20_000c the old hardcoded limit:200 would have produced.
    seedLedger(prisma, 'me', 250);
    const out = await ctrl.earnings(makeReq('me'), { limit: 50 });
    expect(out.entries).toHaveLength(50);
    expect(out.next_cursor).not.toBeNull();
    expect(out.summary.posted_cents).toBe(25_000);
  });

  it('B6: earnings page is bounded and cursor advances', async () => {
    const { ctrl, prisma } = makeCoachController();
    seedLedger(prisma, 'me', 5);
    const first = await ctrl.earnings(makeReq('me'), { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.entries[0].id).toBe('me-le0');
    expect(first.next_cursor).toBe('me-le1');
    const second = await ctrl.earnings(makeReq('me'), {
      limit: 2,
      cursor: 'me-le1',
    });
    expect(second.entries.map((e: any) => e.id)).toEqual(['me-le2', 'me-le3']);
  });

  it('B6: summary is scoped to payee (another coach ledger does not leak in)', async () => {
    const { ctrl, prisma } = makeCoachController();
    seedLedger(prisma, 'me', 3); // 300c posted
    seedLedger(prisma, 'other', 10); // 1000c posted, must be excluded
    const out = await ctrl.earnings(makeReq('me'), {});
    expect(out.summary.posted_cents).toBe(300);
  });

  it('B6: export.csv returns the full payee ledger, scoped, as CSV', async () => {
    const { ctrl, prisma } = makeCoachController();
    seedLedger(prisma, 'me', 3);
    seedLedger(prisma, 'other', 2);
    const headers: Record<string, string> = {};
    // P1: the export now STREAMS — it writes header + each batch directly to
    // the response and never returns a string. The mock res captures every
    // written chunk so we can reassemble the body.
    let body = '';
    let ended = false;
    const res: any = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      once: () => res,
      write: (chunk: string) => {
        body += chunk;
        return true;
      },
      end: () => {
        ended = true;
      },
    };
    await ctrl.exportEarningsCsv(makeReq('me'), res);
    expect(ended).toBe(true);
    expect(headers['Content-Disposition']).toMatch(/attachment; filename=/);
    const lines = body.trim().split('\r\n');
    // 1 header + 3 of MY rows (the 2 'other' rows must NOT appear).
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('amount_cents');
    expect(body).toContain('me-le0');
    expect(body).not.toContain('other-le0');
  });

  it('B6: export.csv drains MULTIPLE cursor batches and does NOT truncate the full ledger', async () => {
    // Regression for the silent maxRows=100_000 truncation: the batch loop
    // must keep paging via the id-stable cursor until the ledger is fully
    // exhausted. Seed well past the 500-row batch size to force several
    // round-trips and assert EVERY row is present.
    const { ctrl, prisma } = makeCoachController();
    const n = 1_250; // > 2 full batches of 500
    seedLedger(prisma, 'me', n);
    const headers: Record<string, string> = {};
    // Capture streamed chunks. Also assert the body was flushed across
    // MULTIPLE write() calls (one per batch) rather than a single buffered
    // string — proving the export streams instead of materializing the whole
    // CSV in memory (P1).
    const chunks: string[] = [];
    let ended = false;
    const res: any = {
      setHeader: (k: string, v: string) => (headers[k] = v),
      once: () => res,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end: () => {
        ended = true;
      },
    };
    await ctrl.exportEarningsCsv(makeReq('me'), res);
    expect(ended).toBe(true);
    // Header chunk + at least one chunk per 500-row batch (1250 -> 3 batches).
    expect(chunks.length).toBeGreaterThan(1);
    const csv = chunks.join('');
    const lines = csv.trim().split('\r\n');
    // 1 header + every one of the n payee rows (no silent cap).
    expect(lines).toHaveLength(n + 1);
    // The first and last seeded rows must both be present (nothing dropped
    // off the front or the tail of the export).
    expect(csv).toContain('me-le0');
    expect(csv).toContain(`me-le${n - 1}`);
    // The findMany mock must have been invoked more than once -> proves the
    // export issued multiple bounded cursor batches rather than one query.
    expect(
      (prisma.splitLedgerEntry.findMany as jest.Mock).mock.calls.length,
    ).toBeGreaterThan(1);
  });

  // P1 (R3): the export MUST honor writable-stream backpressure. When
  // res.write() returns false (socket buffer full / slow client), the export
  // has to PAUSE and await the 'drain' event before producing the next chunk;
  // otherwise Node buffers the whole ledger and the O(batchSize) memory claim
  // is false. We model a back-pressured stream as an EventEmitter whose
  // write() returns false until a synthetic 'drain' is emitted, and assert the
  // export actually parked (its promise stayed unresolved) until we drained.
  it('B6: export.csv WAITS for the drain event when write() signals backpressure', async () => {
    const { ctrl, prisma } = makeCoachController();
    // Two full batches so the loop writes header + batch and must page again.
    const n = 600; // > one 500-row batch -> at least 2 body writes
    seedLedger(prisma, 'me', n);

    const headers: Record<string, string> = {};
    let ended = false;
    const writes: string[] = [];
    // EventEmitter gives us a real once('drain', ...) so the controller's
    // `await once(res, 'drain')` genuinely suspends until we emit.
    const res: any = new EventEmitter();
    res.setHeader = (k: string, v: string) => (headers[k] = v);
    res.end = () => {
      ended = true;
    };
    // First write() (the header) returns false -> the export must await
    // 'drain' before it ever issues the first DB batch / second write.
    let writeCount = 0;
    res.write = (chunk: string) => {
      writes.push(chunk);
      writeCount += 1;
      // Apply backpressure on the very first write (the header).
      return writeCount > 1;
    };

    const done = ctrl.exportEarningsCsv(makeReq('me'), res);

    // Let any synchronous + first microtasks run. Because the header write
    // returned false, the export must be parked awaiting 'drain': it has NOT
    // ended and has NOT written a second (body) chunk yet.
    await new Promise((r) => setImmediate(r));
    expect(ended).toBe(false);
    expect(writes).toHaveLength(1); // only the header so far
    expect(writes[0]).toContain('amount_cents');

    // Race guard: assert the returned promise has NOT resolved while parked.
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    // Now release backpressure. The export should resume, drain the rest of
    // the ledger, write the body, and finally end.
    res.emit('drain');
    await done;
    expect(settled).toBe(true);
    expect(ended).toBe(true);
    const csv = writes.join('');
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(n + 1); // header + every payee row
    expect(csv).toContain('me-le0');
    expect(csv).toContain(`me-le${n - 1}`);
  });

  // P1 (R3): if the client disconnects mid-export, the DB loop must STOP
  // early instead of paging the entire (potentially huge) ledger for a
  // consumer that is gone. We emit 'close' after the first batch and assert
  // the export bails out: it does NOT call res.end() and stops issuing
  // further findMany() queries.
  it('B6: export.csv stops the DB loop early when the client disconnects', async () => {
    const { ctrl, prisma } = makeCoachController();
    const n = 2_000; // 4 full batches if it were to run to completion
    seedLedger(prisma, 'me', n);

    const headers: Record<string, string> = {};
    let ended = false;
    const res: any = new EventEmitter();
    res.setHeader = (k: string, v: string) => (headers[k] = v);
    res.end = () => {
      ended = true;
    };
    // Every write succeeds (no backpressure here) but we fire 'close' on the
    // FIRST body write to simulate the client aborting mid-stream.
    let writeCount = 0;
    res.write = (chunk: string) => {
      writeCount += 1;
      // writeCount === 1 is the header; on the first body chunk, disconnect.
      if (writeCount === 2) {
        res.emit('close');
      }
      return true;
    };

    await ctrl.exportEarningsCsv(makeReq('me'), res);

    // Disconnected mid-stream: the export must NOT have completed normally.
    expect(ended).toBe(false);
    // It must have stopped paging early: far fewer than the 4 batches a full
    // 2,000-row drain would require. (Header + first batch fetched, then we
    // disconnected, so the loop exits well before exhausting the ledger.)
    const calls = (prisma.splitLedgerEntry.findMany as jest.Mock).mock.calls
      .length;
    expect(calls).toBeLessThan(4);
  });

  // P1 (R4): the close-during-drain edge. If the client disconnects while the
  // export is PARKED awaiting 'drain' (because a prior write() returned false),
  // the 'drain' event may never fire. writeWithBackpressure must race 'drain'
  // against 'close'/'error' so it unblocks immediately on disconnect rather
  // than hanging forever and retaining the request context/memory. We make a
  // write return false, never emit 'drain', emit 'close' instead, and assert
  // the export promise resolves quickly, res.end() is NOT called, and no
  // further DB fetches happen after the parked write.
  it('B6: export.csv exits cleanly when client closes while parked on drain', async () => {
    const { ctrl, prisma } = makeCoachController();
    const n = 2_000; // 4 full batches if it were to run to completion
    seedLedger(prisma, 'me', n);

    const headers: Record<string, string> = {};
    let ended = false;
    const res: any = new EventEmitter();
    res.setHeader = (k: string, v: string) => (headers[k] = v);
    res.end = () => {
      ended = true;
    };
    // The FIRST write (the header) returns false -> the export parks awaiting
    // 'drain'. We deliberately never emit 'drain'; instead we emit 'close' to
    // simulate the client aborting WHILE the helper is suspended. Track how
    // many DB fetches happen so we can assert none occur after the park.
    let writeCount = 0;
    let fetchesAtPark = -1;
    res.write = (_chunk: string) => {
      writeCount += 1;
      if (writeCount === 1) {
        // We're about to park awaiting 'drain'. Record the DB-fetch count and
        // schedule a 'close' (not a 'drain') on a later tick to unblock us.
        fetchesAtPark = (prisma.splitLedgerEntry.findMany as jest.Mock).mock
          .calls.length;
        setImmediate(() => res.emit('close'));
        return false; // signal backpressure -> helper awaits drain/close
      }
      return true;
    };

    const done = ctrl.exportEarningsCsv(makeReq('me'), res);

    // Race the export promise against a timeout. If the helper were NOT
    // close-aware it would hang forever waiting on a 'drain' that never comes;
    // here it must settle promptly once 'close' fires.
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 1_000),
    );
    const result = await Promise.race([done.then(() => 'done' as const), timeout]);
    expect(result).toBe('done');

    // Disconnected while parked: the export must NOT have ended the response.
    expect(ended).toBe(false);
    // No further DB fetches occurred after the parked write: the loop
    // short-circuited on the helper's false return instead of fetching the
    // next batch. (At most the single fetch that produced no write, or fewer.)
    const fetchesAtEnd = (prisma.splitLedgerEntry.findMany as jest.Mock).mock
      .calls.length;
    expect(fetchesAtEnd).toBe(fetchesAtPark);
    // And it certainly did not drain the whole 4-batch ledger.
    expect(fetchesAtEnd).toBeLessThan(4);
  });
});

// --- DTO strict-validation: CursorPageQueryDto.limit must reject malformed
// partially-numeric values instead of silently coercing them (P2 fix). These
// run the value through class-transformer + class-validator exactly as the
// global ValidationPipe (transform:true) does in production.
describe('CursorPageQueryDto.limit strict validation', () => {
  async function runLimit(raw: unknown) {
    const dto = plainToInstance(
      CursorPageQueryDto,
      { limit: raw },
      { enableImplicitConversion: false },
    );
    const errors = await validate(dto);
    return { dto, errors };
  }

  it('accepts a clean integer string and converts it to a number', async () => {
    const { dto, errors } = await runLimit('50');
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
    expect(typeof dto.limit).toBe('number');
  });

  it.each(['50abc', '99x', '100foo', '1.5', '1e2', '0x10', 'abc', ' 50 0'])(
    'rejects malformed limit %p with a validation error (no silent coercion)',
    async (raw) => {
      const { errors } = await runLimit(raw);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('limit');
    },
  );

  it('does NOT coerce "50abc" to 50 (parseInt regression guard)', async () => {
    const { dto, errors } = await runLimit('50abc');
    expect(errors.length).toBeGreaterThan(0);
    expect(dto.limit).not.toBe(50);
  });

  it('rejects an out-of-range integer (over max)', async () => {
    const { errors } = await runLimit('101');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('rejects a below-min integer', async () => {
    const { errors } = await runLimit('0');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('treats an omitted limit as optional (no error)', async () => {
    const dto = plainToInstance(CursorPageQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBeUndefined();
  });

  // P2 (R2): an explicitly supplied empty / null / blank limit is NOT the
  // same as an omitted param — it is malformed input and MUST 400 rather
  // than slipping past @IsOptional with zero validation errors.
  it('rejects an explicit empty-string limit (?limit=)', async () => {
    const { dto, errors } = await runLimit('');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
    expect(dto.limit).not.toBe(undefined);
  });

  it('rejects an explicit null limit', async () => {
    const { dto, errors } = await runLimit(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
    expect(dto.limit).not.toBe(undefined);
  });

  it('rejects a whitespace-only limit', async () => {
    const { errors } = await runLimit('   ');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('rejects a malformed (non-UUID) cursor', async () => {
    const dto = plainToInstance(CursorPageQueryDto, { cursor: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('cursor');
  });
});
