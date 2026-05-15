import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';

function makePrismaStub() {
  const purchases: any[] = [];
  const splits: any[] = [];
  const transfers: any[] = [];
  const refunds: any[] = [];
  const disputes: any[] = [];
  return {
    _purchases: purchases,
    _splits: splits,
    _transfers: transfers,
    _refunds: refunds,
    _disputes: disputes,
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
      ),
      findFirst: jest.fn(async ({ where = {} }: any) =>
        purchases.find((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    splitLedgerEntry: {
      findFirst: jest.fn(async ({ where = {} }: any) =>
        splits.find((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        ) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        splits.find((s) => s.id === where.id) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const r = splits.find((s) => s.id === where.id);
        if (!r) throw new Error('not found');
        return r;
      }),
      findMany: jest.fn(async ({ where = {} }: any) =>
        splits.filter((s) =>
          Object.entries(where).every(([k, v]) => s[k] === v),
        ),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = splits.find((s) => s.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    connectTransfer: {
      findFirst: jest.fn(async ({ where = {} }: any) =>
        transfers.find((t) =>
          Object.entries(where).every(([k, v]) => t[k] === v),
        ) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        transfers.find((t) => t.id === where.id) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const r = transfers.find((t) => t.id === where.id);
        if (!r) throw new Error('not found');
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = transfers.find((t) => t.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    chargeRefund: {
      findUnique: jest.fn(async ({ where }: any) =>
        refunds.find((r) => r.stripe_refund_id === where.stripe_refund_id) ?? null,
      ),
      findMany: jest.fn(async ({ where = {}, take = 50 }: any) =>
        refunds
          .filter((r) =>
            Object.entries(where).every(([k, v]) => r[k] === v),
          )
          .slice(0, take),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'rf-' + (refunds.length + 1),
          ledger_reversed: false,
          transfer_reversed: false,
          ...data,
        };
        refunds.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = refunds.find(
          (r) =>
            (where.id && r.id === where.id) ||
            (where.stripe_refund_id &&
              r.stripe_refund_id === where.stripe_refund_id),
        );
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    chargeDispute: {
      findUnique: jest.fn(async ({ where }: any) =>
        disputes.find((d) => d.stripe_dispute_id === where.stripe_dispute_id) ?? null,
      ),
      findMany: jest.fn(async ({ where = {}, take = 50 }: any) =>
        disputes
          .filter((d) =>
            Object.entries(where).every(([k, v]) => d[k] === v),
          )
          .slice(0, take),
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = disputes.find(
          (d) => d.stripe_dispute_id === where.stripe_dispute_id,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          id: 'dp-' + (disputes.length + 1),
          ledger_reversed: false,
          ...create,
        };
        disputes.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = disputes.find(
          (d) =>
            (where.id && d.id === where.id) ||
            (where.stripe_dispute_id &&
              d.stripe_dispute_id === where.stripe_dispute_id),
        );
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

function makeServices() {
  const prisma = makePrismaStub();
  const stripe = {
    retrieveCharge: jest.fn(async () => ({
      id: 'ch_x',
      amount: 10_000,
      payment_intent: 'pi_x',
    })),
    retrievePaymentIntent: jest.fn(async () => ({
      id: 'pi_x',
      latest_charge: 'ch_x',
    })),
    createRefund: jest.fn(async () => ({
      id: 'rf_stripe',
      amount: 5_000,
      status: 'succeeded',
    })),
    reverseTransfer: jest.fn(async () => ({ id: 'trr_1' })),
  } as any;
  const ledger = {
    findByPurchase: jest.fn(async (purchaseId: string) => prisma._splits.filter((s) => s.purchase_id === purchaseId)),
    applyReversal: jest.fn(async (args: any) => {
      const row = prisma._splits.find((s) => s.id === args.entry_id);
      if (!row) return null;
      row.reversed_cents = (row.reversed_cents ?? 0) + args.reversed_cents;
      if (row.reversed_cents >= row.amount_cents) row.status = 'reversed';
      return row;
    }),
  } as any;
  const transfers = {
    reverse: jest.fn(async ({ transfer_row_id, amount_cents }: any) => {
      const row = prisma._transfers.find((t) => t.id === transfer_row_id);
      if (!row) return null;
      row.reversed_amount_cents = (row.reversed_amount_cents ?? 0) + amount_cents;
      if (row.reversed_amount_cents >= row.amount_cents) row.status = 'reversed';
      return row;
    }),
  } as any;
  const payoutReadiness = {
    recordPayoutEvent: jest.fn(async () => null),
  } as any;
  const svc = new RefundDisputeHandlerService(
    prisma as any,
    stripe,
    ledger,
    transfers,
    payoutReadiness,
  );
  return { svc, prisma, stripe, ledger, transfers, payoutReadiness };
}

describe('RefundDisputeHandlerService', () => {
  it('handles charge.refunded — flips purchase to refunded + reverses ledger', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({ id: 'p1', amount_cents: 10_000 });
    prisma._splits.push(
      {
        id: 'l1',
        purchase_id: 'p1',
        kind: 'destination',
        amount_cents: 9_800,
        reversed_cents: 0,
        status: 'posted',
        stripe_charge_id: 'ch_x',
      },
      {
        id: 'l2',
        purchase_id: 'p1',
        kind: 'application_fee',
        amount_cents: 200,
        reversed_cents: 0,
        status: 'posted',
        stripe_charge_id: 'ch_x',
      },
    );
    const result = await svc.handle({
      id: 'evt_1',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_x',
          amount: 10_000,
          amount_refunded: 10_000,
          refunds: { data: [{ id: 'rf_1', amount: 10_000, status: 'succeeded' }] },
        },
      },
    });
    expect(result.claimed).toBe(true);
    const p = prisma._purchases.find((x: any) => x.id === 'p1');
    expect(p.status).toBe('refunded');
    expect(p.entitlement_active).toBe(false);
    // Ledger reversed.
    const dest = prisma._splits.find((s: any) => s.kind === 'destination');
    expect(dest.reversed_cents).toBe(9_800);
    expect(dest.status).toBe('reversed');
  });

  it('partial refund reverses only the proportional ledger amount', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({ id: 'p2', amount_cents: 10_000 });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p2',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 0,
      status: 'posted',
      stripe_charge_id: 'ch_x',
    });
    await svc.handle({
      id: 'evt_2',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_x',
          amount: 10_000,
          amount_refunded: 4_000,
          refunds: { data: [{ id: 'rf_2', amount: 4_000, status: 'succeeded' }] },
        },
      },
    });
    // Purchase NOT flipped to refunded (partial).
    const p = prisma._purchases.find((x: any) => x.id === 'p2');
    expect(p.status).not.toBe('refunded');
    // 4_000 / 10_000 of 9_800 = 3_920.
    const dest = prisma._splits[0];
    expect(dest.reversed_cents).toBe(3_920);
  });

  it('claims dispute.created and flips purchase to disputed', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({ id: 'p3', amount_cents: 10_000 });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p3',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 0,
      status: 'posted',
      stripe_charge_id: 'ch_x',
    });
    const result = await svc.handle({
      id: 'evt_3',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_1',
          charge: 'ch_x',
          status: 'needs_response',
          amount: 10_000,
          reason: 'fraudulent',
        },
      },
    });
    expect(result.claimed).toBe(true);
    expect(prisma._disputes).toHaveLength(1);
    expect(prisma._purchases[0].status).toBe('disputed');
  });

  it('dispute lost reverses the destination ledger entry', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({ id: 'p4', amount_cents: 10_000 });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p4',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 0,
      status: 'posted',
      stripe_charge_id: 'ch_x',
    });
    // First open the dispute.
    await svc.handle({
      id: 'evt_open',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_x',
          charge: 'ch_x',
          status: 'needs_response',
          amount: 9_800,
        },
      },
    });
    // Then close as lost.
    const result = await svc.handle({
      id: 'evt_close',
      type: 'charge.dispute.closed',
      data: {
        object: {
          id: 'dp_x',
          status: 'lost',
          amount: 9_800,
          balance_transactions: [{ id: 'txn_1' }],
        },
      },
    });
    expect(result.claimed).toBe(true);
    const dispute = prisma._disputes[0];
    expect(dispute.status).toBe('lost');
    expect(dispute.ledger_reversed).toBe(true);
    const p = prisma._purchases[0];
    expect(p.status).toBe('chargeback_lost');
  });

  it('createAdminRefund hits Stripe + persists ChargeRefund', async () => {
    const { svc, prisma, stripe } = makeServices();
    prisma._purchases.push({
      id: 'p5',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_x',
    });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p5',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 0,
      status: 'posted',
      stripe_charge_id: 'ch_x',
    });
    const refund = await svc.createAdminRefund({
      purchase_id: 'p5',
      amount_cents: 5_000,
      reason: 'requested_by_customer',
      note: 'support ticket #99',
      initiated_by_user_id: 'owner-1',
    });
    expect(stripe.createRefund).toHaveBeenCalled();
    expect(refund.stripe_refund_id).toBe('rf_stripe');
    expect(prisma._refunds).toHaveLength(1);
    expect(prisma._refunds[0].initiated_by_user_id).toBe('owner-1');
  });

  it('payout.paid is forwarded to PayoutReadinessService.recordPayoutEvent', async () => {
    const { svc, payoutReadiness } = makeServices();
    await svc.handle({
      id: 'evt_po',
      type: 'payout.paid',
      data: {
        object: {
          id: 'po_1',
          amount: 5_000,
          account: 'acct_x',
          arrival_date: 1_700_000_000,
        },
      },
    });
    expect(payoutReadiness.recordPayoutEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payout_id: 'po_1',
        stripe_account_id: 'acct_x',
        status: 'paid',
      }),
    );
  });

  it('returns claimed=false for unmapped event types', async () => {
    const { svc } = makeServices();
    const result = await svc.handle({
      id: 'evt_random',
      type: 'invoice.upcoming',
      data: { object: {} },
    });
    expect(result.claimed).toBe(false);
  });
});
