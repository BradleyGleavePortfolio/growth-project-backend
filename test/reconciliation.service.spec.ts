import { ReconciliationService } from '../src/connect/fees/reconciliation.service';

// Minimal Prisma stand-in for ReconciliationService.
function makePrismaStub() {
  const purchases: any[] = [];
  const splits: any[] = [];
  const transfers: any[] = [];
  const snapshots: any[] = [];
  return {
    _purchases: purchases,
    _splits: splits,
    _transfers: transfers,
    _snapshots: snapshots,
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ take = 50 }: any = {}) => purchases.slice(0, take)),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        splits.filter((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        ),
      ),
      findFirst: jest.fn(async ({ where = {} }: any) =>
        splits.find((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        ) ?? null,
      ),
    },
    connectTransfer: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        transfers.filter((t) =>
          Object.entries(where).every(([k, v]) => t[k] === v),
        ),
      ),
    },
    reconciliationSnapshot: {
      findUnique: jest.fn(async ({ where }: any) =>
        snapshots.find((s) => s.purchase_id === where.purchase_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = snapshots.find((s) => s.purchase_id === where.purchase_id);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: 'rec-' + (snapshots.length + 1), ...create };
        snapshots.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where = {}, take = 100 }: any) =>
        snapshots
          .filter((s) =>
            Object.entries(where).every(([k, v]) => s[k] === v),
          )
          .slice(0, take),
      ),
    },
  };
}

function makeStripeStub(overrides: Record<string, any> = {}) {
  return {
    retrievePaymentIntent: jest.fn(async () => ({
      id: 'pi_x',
      latest_charge: 'ch_x',
    })),
    retrieveCharge: jest.fn(async () => ({
      id: 'ch_x',
      amount: 10_000,
      amount_refunded: 0,
      application_fee_amount: 200,
    })),
    ...overrides,
  };
}

describe('ReconciliationService', () => {
  function makeSvc(extraStripe: Record<string, any> = {}) {
    const prisma = makePrismaStub();
    const stripe = makeStripeStub(extraStripe);
    const svc = new ReconciliationService(prisma as any, stripe as any);
    return { svc, prisma, stripe };
  }

  it('returns ok when Stripe + ledger agree exactly', async () => {
    const { svc, prisma } = makeSvc();
    prisma._purchases.push({
      id: 'p1',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_x',
    });
    prisma._splits.push(
      {
        id: 'l1',
        purchase_id: 'p1',
        kind: 'destination',
        amount_cents: 9_800,
        reversed_cents: 0,
        status: 'posted',
      },
      {
        id: 'l2',
        purchase_id: 'p1',
        kind: 'application_fee',
        amount_cents: 200,
        reversed_cents: 0,
        status: 'posted',
      },
    );
    const result = await svc.reconcilePurchase('p1');
    expect(result.status).toBe('ok');
    expect(result.drift_cents).toBe(0);
    expect(result.stripe.amount_cents).toBe(10_000);
    expect(result.ledger.destination_cents).toBe(9_800);
  });

  it('returns drift when Stripe shows more revenue than the ledger', async () => {
    const { svc, prisma } = makeSvc();
    prisma._purchases.push({
      id: 'p2',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_x',
    });
    // Ledger only has 5_000 destination — Stripe has 10_000 amount.
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p2',
      kind: 'destination',
      amount_cents: 5_000,
      reversed_cents: 0,
      status: 'posted',
    });
    const result = await svc.reconcilePurchase('p2');
    expect(result.status).toBe('drift');
    expect(result.drift_cents).toBe(10_000 - 5_000);
  });

  it('reflects refunded amount on the Stripe side', async () => {
    const { svc, prisma } = makeSvc({
      retrieveCharge: jest.fn(async () => ({
        id: 'ch_x',
        amount: 10_000,
        amount_refunded: 4_000,
        application_fee_amount: 200,
      })),
    });
    prisma._purchases.push({
      id: 'p3',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_x',
    });
    prisma._splits.push(
      {
        id: 'l1',
        purchase_id: 'p3',
        kind: 'destination',
        amount_cents: 9_800,
        reversed_cents: 3_920,
        status: 'posted',
      },
      {
        id: 'l2',
        purchase_id: 'p3',
        kind: 'application_fee',
        amount_cents: 200,
        reversed_cents: 80,
        status: 'posted',
      },
    );
    const result = await svc.reconcilePurchase('p3');
    // stripe_net = 10000 - 4000 = 6000.
    // ledger_net = (9800 + 200) - (3920 + 80) = 6000.
    expect(result.status).toBe('ok');
    expect(result.drift_cents).toBe(0);
    expect(result.stripe.refunded_cents).toBe(4_000);
    expect(result.ledger.reversed_cents).toBe(4_000);
  });

  it('returns unknown when Stripe is unreachable', async () => {
    const { svc, prisma } = makeSvc({
      retrievePaymentIntent: jest.fn(async () => {
        throw new Error('stripe down');
      }),
    });
    prisma._purchases.push({
      id: 'p4',
      amount_cents: 1_000,
      stripe_payment_intent_id: 'pi_dead',
    });
    const result = await svc.reconcilePurchase('p4');
    expect(result.status).toBe('unknown');
    expect(result.drift_cents).toBeNull();
  });

  it('persists snapshot rows that listDrift returns', async () => {
    const { svc, prisma } = makeSvc();
    prisma._purchases.push({
      id: 'p5',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_x',
    });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p5',
      kind: 'destination',
      amount_cents: 5_000,
      reversed_cents: 0,
      status: 'posted',
    });
    await svc.reconcilePurchase('p5');
    const drift = await svc.listDrift();
    expect(drift).toHaveLength(1);
    expect(drift[0].purchase_id).toBe('p5');
  });
});
