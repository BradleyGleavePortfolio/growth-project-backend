import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AdminPaymentOpsController,
  CoachPaymentOpsController,
} from '../src/checkout/payment-ops.controller';
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
      findMany: jest.fn(async ({ where = {} }: any) =>
        purchases.filter((p) =>
          Object.entries(where).every(([k, v]: any) => {
            if (k === 'OR' && Array.isArray(v)) {
              return v.some((clause: any) =>
                Object.entries(clause).every(([ck, cv]: any) => p[ck] === cv),
              );
            }
            return p[k] === v;
          }),
        ),
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
      ),
      count: jest.fn(async ({ where = {} }: any) =>
        purchases.filter((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ).length,
      ),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        splits.filter((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        ),
      ),
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
  const ctrl = new AdminPaymentOpsController(
    prisma as any,
    fee,
    ledger,
    dunning,
    splits,
  );
  return { ctrl, prisma, fee, dunning, splits };
}

function makeCoachController() {
  const prisma = makePrismaStub();
  const fee = new FeePolicyService(prisma as any);
  const ledger = new SplitLedgerService(prisma as any);
  const ctrl = new CoachPaymentOpsController(prisma as any, fee, ledger);
  return { ctrl, prisma };
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
    const out = await ctrl.listOwn(makeReq('me'));
    expect(out.purchases).toHaveLength(1);
    expect(out.purchases[0].id).toBe('p1');
  });

  it('forbids inspecting another coach purchase', async () => {
    const { ctrl, prisma } = makeCoachController();
    prisma._purchases.push({
      id: 'p1',
      coach_user_id: 'other',
      client_user_id: 'cli',
    });
    await expect(ctrl.getOwn(makeReq('me'), 'p1')).rejects.toBeInstanceOf(
      ForbiddenException,
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
    const out = await ctrl.earnings(makeReq('me'));
    expect(out.summary.posted_cents).toBe(9_800);
    expect(out.summary.pending_cents).toBe(9_300);
    expect(out.summary.reversed_cents).toBe(500);
    expect(out.entries).toHaveLength(3);
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
});
