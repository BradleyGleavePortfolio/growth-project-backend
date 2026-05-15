import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';

function makePrismaStub() {
  const entries: any[] = [];
  let n = 0;
  return {
    _entries: entries,
    splitLedgerEntry: {
      findFirst: jest.fn(async ({ where }: any) =>
        entries.find(
          (e) =>
            e.purchase_id === where.purchase_id &&
            e.kind === where.kind &&
            (where.payee_user_id === null
              ? e.payee_user_id == null
              : e.payee_user_id === where.payee_user_id),
        ) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        entries.filter((e) =>
          Object.entries(where).every(([k, v]) => e[k] === v),
        ),
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = entries.find((e) => e.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const composite = where.purchase_id_kind_payee_user_id;
        const existing = entries.find(
          (e) =>
            e.purchase_id === composite.purchase_id &&
            e.kind === composite.kind &&
            e.payee_user_id === composite.payee_user_id,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          id: 'le-' + ++n,
          status: 'pending',
          reversed_cents: 0,
          created_at: new Date(),
          ...create,
        };
        entries.push(row);
        return { ...row };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'le-' + ++n,
          status: 'pending',
          reversed_cents: 0,
          created_at: new Date(),
          ...data,
        };
        entries.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = entries.find((e) => e.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

const PURCHASE = {
  id: 'p-1',
  coach_user_id: 'coach-1',
  client_user_id: 'cli-1',
  amount_cents: 10_000,
  currency: 'usd',
  package_id: 'pk',
  status: 'paid',
} as any;

const PLAN_SOLO = {
  amount_cents: 10_000,
  currency_assumed: 'usd',
  application_fee_cents: 200,
  head_coach_split_cents: 0,
  destination_cents: 9_800,
  policy: { platform_application_fee_bps: 200, head_coach_split_bps: 500, source: 'default' as const },
  head_coach_id: null,
};

const PLAN_SUB = {
  amount_cents: 10_000,
  currency_assumed: 'usd',
  application_fee_cents: 200,
  head_coach_split_cents: 500,
  destination_cents: 9_300,
  policy: { platform_application_fee_bps: 200, head_coach_split_bps: 500, source: 'default' as const },
  head_coach_id: 'head-1',
};

describe('SplitLedgerService', () => {
  let prisma: any;
  let svc: SplitLedgerService;

  beforeEach(() => {
    prisma = makePrismaStub();
    svc = new SplitLedgerService(prisma);
  });

  it('materializes two rows for a solo-PT purchase (application_fee + destination)', async () => {
    const rows = await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SOLO,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_seller',
      head_coach_stripe_account_id: null,
    });
    expect(rows).toHaveLength(2);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['application_fee', 'destination']);
    const dest = rows.find((r) => r.kind === 'destination')!;
    expect(dest.payee_user_id).toBe('coach-1');
    expect(dest.amount_cents).toBe(9_800);
    const appFee = rows.find((r) => r.kind === 'application_fee')!;
    expect(appFee.payee_user_id).toBeNull();
    expect(appFee.amount_cents).toBe(200);
  });

  it('materializes three rows for a sub-coach purchase (application_fee + destination + head_coach_split)', async () => {
    const rows = await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SUB,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_sub',
      head_coach_stripe_account_id: 'acct_head',
    });
    expect(rows).toHaveLength(3);
    const hcs = rows.find((r) => r.kind === 'head_coach_split')!;
    expect(hcs.payee_user_id).toBe('head-1');
    expect(hcs.amount_cents).toBe(500);
    expect(hcs.payee_stripe_account_id).toBe('acct_head');
  });

  it('is idempotent — re-running collapses onto existing rows (composite unique)', async () => {
    await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SUB,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_sub',
      head_coach_stripe_account_id: 'acct_head',
    });
    await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SUB,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_sub',
      head_coach_stripe_account_id: 'acct_head',
    });
    expect(prisma._entries).toHaveLength(3);
  });

  it('does not create a head_coach_split row when the head coach has no Connect account', async () => {
    const rows = await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SUB,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_sub',
      head_coach_stripe_account_id: null,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'head_coach_split')).toBeUndefined();
  });

  it('marks a slice as posted with Stripe ids', async () => {
    const [first] = await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SOLO,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_seller',
      head_coach_stripe_account_id: null,
    });
    const posted = await svc.markPosted({
      entry_id: first.id,
      stripe_charge_id: 'ch_abc',
    });
    expect(posted.status).toBe('posted');
    expect(posted.stripe_charge_id).toBe('ch_abc');
  });

  it('applies partial reversal then flips to status=reversed on full reversal', async () => {
    const rows = await svc.ensurePendingEntries({
      purchase: PURCHASE,
      plan: PLAN_SUB,
      platform_account_id: null,
      seller_stripe_account_id: 'acct_sub',
      head_coach_stripe_account_id: 'acct_head',
    });
    const dest = rows.find((r) => r.kind === 'destination')!;
    await svc.applyReversal({ entry_id: dest.id, reversed_cents: 3_000 });
    let row = prisma._entries.find((e: any) => e.id === dest.id);
    expect(row.status).toBe('pending');
    expect(row.reversed_cents).toBe(3_000);
    await svc.applyReversal({ entry_id: dest.id, reversed_cents: 9_300 });
    row = prisma._entries.find((e: any) => e.id === dest.id);
    expect(row.status).toBe('reversed');
    expect(row.reversed_cents).toBe(9_300);
  });
});
