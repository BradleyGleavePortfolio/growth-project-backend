import { ReconciliationService } from '../src/connect/fees/reconciliation.service';

// Minimal Prisma stand-in for ReconciliationService.
function makePrismaStub() {
  const purchases: any[] = [];
  const splits: any[] = [];
  const transfers: any[] = [];
  const snapshots: any[] = [];
  const settlements: any[] = [];
  const recoveries: any[] = [];
  return {
    _settlements: settlements,
    _recoveries: recoveries,
    // S-FEE: settlement-backed purchases reconcile per charge.
    chargeSettlement: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        settlements.filter(
          (r) =>
            r.purchase_id === where.purchase_id &&
            r.mechanism === where.mechanism &&
            r.status === where.status,
        ),
      ),
    },
    payeeRecovery: {
      findMany: jest.fn(async ({ where = {} }: any) =>
        recoveries.filter((r) => (where.settlement_id?.in ?? []).includes(r.settlement_id)),
      ),
    },
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
  describe('S-FEE settlement-backed purchases', () => {
    // $49.00 US card: Stripe fee 172, TGP 2% = 98, coach net 4630.
    function seedSettled(
      prisma: ReturnType<typeof makePrismaStub>,
      opts: { transfer?: boolean } = {},
    ) {
      prisma._purchases.push({ id: 'p49', amount_cents: 4_900, stripe_payment_intent_id: 'pi_49' });
      prisma._settlements.push({
        id: 'cs-1',
        purchase_id: 'p49',
        stripe_charge_id: 'ch_49',
        mechanism: 'separate_charge_transfer',
        status: 'settled',
        coach_user_id: 'coach-1',
        head_coach_user_id: null,
        gross_cents: 4_900,
        stripe_fee_cents: 172,
        platform_fee_cents: 98,
        head_coach_split_cents: 0,
        coach_net_cents: 4_630,
        refunded_cents: 0,
        dispute_withdrawn_cents: 0,
        dispute_fee_cents: 0,
        target_platform_fee_cents: 98,
        target_head_coach_cents: 0,
        target_coach_net_cents: 4_630,
        created_at: new Date(),
      });
      const slice = (kind: string, amount: number, payee: string | null) => ({
        id: `le-${kind}`,
        purchase_id: 'p49',
        stripe_charge_id: 'ch_49',
        kind,
        payee_user_id: payee,
        amount_cents: amount,
        reversed_cents: 0,
        status: 'posted',
      });
      prisma._splits.push(
        slice('application_fee', 98, null),
        slice('stripe_fee', 172, null),
        slice('destination', 4_630, 'coach-1'),
      );
      if (opts.transfer !== false) {
        prisma._transfers.push({
          id: 'tr-1',
          purchase_id: 'p49',
          settlement_id: 'cs-1',
          destination_user_id: 'coach-1',
          amount_cents: 4_630,
          netted_recovery_cents: 0,
          reversed_amount_cents: 0,
          status: 'succeeded',
        });
      }
    }
    const charge49 = (fee: number) => ({
      retrieveCharge: jest.fn(async () => ({
        id: 'ch_49',
        amount: 4_900,
        amount_refunded: 0,
        balance_transaction: {
          id: 'txn_49',
          amount: 4_900,
          fee,
          net: 4_900 - fee,
          currency: 'usd',
        },
      })),
    });

    it('ok when Stripe, ledger slices, transfers and platform net agree', async () => {
      const { svc, prisma, stripe } = makeSvc(charge49(172));
      seedSettled(prisma);
      const result = await svc.reconcilePurchase('p49');
      expect(result.status).toBe('ok');
      expect(result.drift_cents).toBe(0);
      expect(stripe.retrieveCharge).toHaveBeenCalledWith('ch_49', {
        expandBalanceTransaction: true,
      });
    });

    it('drift when Stripe reports a different fee than the settlement recorded', async () => {
      const { svc, prisma } = makeSvc(charge49(200));
      seedSettled(prisma);
      const result = await svc.reconcilePurchase('p49');
      expect(result.status).toBe('drift');
      expect(result.drift_cents).toBe(28);
      expect(result.notes).toContain('stripe_fee: expected 172, found 200');
    });

    it('drift when the coach transfer is missing (platform holding the coach net)', async () => {
      const { svc, prisma } = makeSvc(charge49(172));
      seedSettled(prisma, { transfer: false });
      const result = await svc.reconcilePurchase('p49');
      expect(result.status).toBe('drift');
      expect(result.notes).toContain('coach_position: expected 4630, found 0');
      expect(result.notes).toContain('platform_net: expected 98, found 4728');
    });
  });
});
