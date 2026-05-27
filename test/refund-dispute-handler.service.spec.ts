import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';

function makePrismaStub() {
  const purchases: any[] = [];
  const splits: any[] = [];
  const transfers: any[] = [];
  const refunds: any[] = [];
  const disputes: any[] = [];
  // A276-P1-2 (refix) — RefundDisputeHandlerService now mirrors the
  // GuestCheckout row's status when ClientPurchase flips to 'refunded',
  // keeping admin reports that filter by GuestCheckout.status in lockstep.
  const guestCheckouts: any[] = [];
  return {
    _purchases: purchases,
    _splits: splits,
    _transfers: transfers,
    _refunds: refunds,
    _disputes: disputes,
    _guestCheckouts: guestCheckouts,
    guestCheckout: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matchesStatus = (row: any) => {
          if (where.status === undefined) return true;
          if (typeof where.status === 'object' && where.status !== null) {
            if ('not' in where.status) return row.status !== where.status.not;
          }
          return row.status === where.status;
        };
        const matched = guestCheckouts.filter(
          (r) =>
            (where.stripe_payment_intent_id === undefined ||
              r.stripe_payment_intent_id === where.stripe_payment_intent_id) &&
            matchesStatus(r),
        );
        for (const r of matched) Object.assign(r, data);
        return { count: matched.length };
      }),
    },
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
      // A276-F2-P2-3 — the post-refund lockstep and dispute first-
      // observation paths now wrap their multi-write sequence in a
      // $transaction and use updateMany with a status guard. Mimic the
      // real Prisma semantics (notIn / not / value-equality + count).
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matchesStatus = (row: any) => {
          if (where.status === undefined) return true;
          if (typeof where.status === 'object' && where.status !== null) {
            if ('not' in where.status) return row.status !== where.status.not;
            if ('notIn' in where.status)
              return !(where.status.notIn as string[]).includes(row.status);
            if ('in' in where.status)
              return (where.status.in as string[]).includes(row.status);
          }
          return row.status === where.status;
        };
        const matched = purchases.filter(
          (p) =>
            (where.id === undefined || p.id === where.id) &&
            matchesStatus(p),
        );
        for (const r of matched) Object.assign(r, data);
        return { count: matched.length };
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
      // A276-F2-P2-2 — emulate the DB-level unique constraint on
      // stripe_dispute_id by raising Prisma's P2002 on duplicate create.
      // This is the serialisation point the new code relies on.
      create: jest.fn(async ({ data }: any) => {
        if (
          disputes.find((d) => d.stripe_dispute_id === data.stripe_dispute_id)
        ) {
          const err: any = new Error(
            'Unique constraint failed on the fields: (`stripe_dispute_id`)',
          );
          err.code = 'P2002';
          err.meta = { target: ['stripe_dispute_id'] };
          throw err;
        }
        const row = {
          id: 'dp-' + (disputes.length + 1),
          ledger_reversed: false,
          ...data,
        };
        disputes.push(row);
        return { ...row };
      }),
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
  // A276-F2-P2-3 — interactive transactions: invoke the lambda with the
  // same stub so writes inside the tx hit the in-memory tables. If the
  // lambda throws, propagate (real Prisma rolls back; here we simply
  // emulate the error path).
  (prisma as any).$transaction = jest.fn(
    async (cb: (tx: any) => Promise<any>) => cb(prisma),
  );
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
  // A276 P0-2 (refix) — NotificationsService is a HARD dependency on
  // RefundDisputeHandlerService. Tests inject an explicit stub so we can
  // assert COACH_ALERT emission shape + count.
  const notifications = {
    createNotification: jest.fn(async () => undefined),
  } as any;
  const svc = new RefundDisputeHandlerService(
    prisma as any,
    stripe,
    ledger,
    transfers,
    payoutReadiness,
    notifications,
  );
  return { svc, prisma, stripe, ledger, transfers, payoutReadiness, notifications };
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

  // A276-P1-2 (refix) — a refund routed through the converted-purchase
  // path must also flip the originating GuestCheckout row's status from
  // 'converted' to 'refunded' so admin reports filtering by
  // GuestCheckout.status surface the transaction. Without the lockstep,
  // ClientPurchase.status='refunded' diverges from GuestCheckout.status=
  // 'converted' for the lifetime of the row (P1-2 audit finding).
  it('A276-P1-2: full refund on converted purchase flips the originating GuestCheckout to refunded', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({
      id: 'p_conv',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_conv',
    });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p_conv',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 0,
      status: 'posted',
      stripe_charge_id: 'ch_conv',
    });
    prisma._guestCheckouts.push({
      id: 'gc_conv',
      stripe_payment_intent_id: 'pi_conv',
      status: 'converted',
      refunded_at: null,
    });

    const result = await svc.handle({
      id: 'evt_lockstep',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_conv',
          amount: 10_000,
          amount_refunded: 10_000,
          refunds: { data: [{ id: 'rf_lockstep', amount: 10_000, status: 'succeeded' }] },
        },
      },
    });

    expect(result.claimed).toBe(true);
    // ClientPurchase flipped.
    expect(
      prisma._purchases.find((x: any) => x.id === 'p_conv').status,
    ).toBe('refunded');
    // GuestCheckout flipped in lockstep.
    const gc = prisma._guestCheckouts.find((g: any) => g.id === 'gc_conv');
    expect(gc.status).toBe('refunded');
    // refunded_at is NOT re-stamped on this path (the GuestCheckout
    // handler owns that field; in the post-conversion case it stays
    // null — "never refunded through the guest path").
    expect(gc.refunded_at).toBeNull();
  });

  // A276-P1-2 (refix) — partial refund on the converted-purchase path
  // does NOT touch GuestCheckout.status. Status flip is reserved for
  // the closing delivery that completes the full refund.
  it('A276-P1-2: partial refund on converted purchase does NOT flip the GuestCheckout status', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({
      id: 'p_partial',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_partial',
    });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p_partial',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 0,
      status: 'posted',
      stripe_charge_id: 'ch_partial',
    });
    prisma._guestCheckouts.push({
      id: 'gc_partial',
      stripe_payment_intent_id: 'pi_partial',
      status: 'converted',
      refunded_at: null,
    });

    await svc.handle({
      id: 'evt_partial',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_partial',
          amount: 10_000,
          amount_refunded: 4_000,
          refunds: { data: [{ id: 'rf_partial', amount: 4_000, status: 'succeeded' }] },
        },
      },
    });

    const gc = prisma._guestCheckouts.find((g: any) => g.id === 'gc_partial');
    expect(gc.status).toBe('converted');
  });

  // A276-P1-2 (refix) — lockstep update is idempotent. A Stripe
  // re-delivery of the same closing event re-runs the updateMany but
  // the WHERE status:{not:'refunded'} guard matches zero rows.
  it('A276-P1-2: lockstep update is idempotent on Stripe re-delivery', async () => {
    const { svc, prisma } = makeServices();
    prisma._purchases.push({
      id: 'p_redeliv',
      amount_cents: 10_000,
      stripe_payment_intent_id: 'pi_redeliv',
      status: 'refunded',
      entitlement_active: false,
    });
    prisma._splits.push({
      id: 'l1',
      purchase_id: 'p_redeliv',
      kind: 'destination',
      amount_cents: 9_800,
      reversed_cents: 9_800,
      status: 'reversed',
      stripe_charge_id: 'ch_redeliv',
    });
    prisma._guestCheckouts.push({
      id: 'gc_redeliv',
      stripe_payment_intent_id: 'pi_redeliv',
      status: 'refunded', // already mirrored from prior delivery
      refunded_at: null,
    });
    // Pre-stamp the refund so the ledger-reversal path treats this as
    // a re-delivery.
    prisma._refunds.push({
      id: 'rf-1',
      stripe_refund_id: 'rf_redeliv',
      purchase_id: 'p_redeliv',
      stripe_charge_id: 'ch_redeliv',
      amount_cents: 10_000,
      status: 'succeeded',
      ledger_reversed: true,
      transfer_reversed: true,
    });

    await svc.handle({
      id: 'evt_redeliv',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_redeliv',
          amount: 10_000,
          amount_refunded: 10_000,
          refunds: { data: [{ id: 'rf_redeliv', amount: 10_000, status: 'succeeded' }] },
        },
      },
    });

    // GuestCheckout row still 'refunded' — but the updateMany call's
    // count was 0 (status:{not:'refunded'} matched nothing). We assert
    // by checking the mock call shape.
    const gcCalls = (prisma.guestCheckout.updateMany as jest.Mock).mock.calls;
    expect(gcCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = gcCalls[gcCalls.length - 1][0];
    expect(lastCall.where.status).toEqual({ not: 'refunded' });
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

  // --- A276 P0-2 + P1-1 (refix): COACH_ALERT on post-conversion path ---

  describe('COACH_ALERT post-conversion (A276-P0-2 + P1-1 refix)', () => {
    function seedPurchase(prisma: any, overrides: any = {}) {
      const purchase = {
        id: 'p_alert',
        amount_cents: 29_700,
        coach_user_id: 'coach-1',
        status: 'paid',
        entitlement_active: true,
        ...overrides,
      };
      prisma._purchases.push(purchase);
      prisma._splits.push({
        id: 'l_alert',
        purchase_id: purchase.id,
        kind: 'destination',
        amount_cents: purchase.amount_cents - 297,
        reversed_cents: 0,
        status: 'posted',
        stripe_charge_id: 'ch_alert',
      });
      return purchase;
    }

    it('emits exactly one COACH_ALERT per refund.id on the post-conversion charge.refunded path', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      await svc.handle({
        id: 'evt_full',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_alert',
            amount: 29_700,
            amount_refunded: 29_700,
            refunds: {
              data: [
                {
                  id: 'rf_full',
                  amount: 29_700,
                  status: 'succeeded',
                  reason: 'requested_by_customer',
                },
              ],
            },
          },
        },
      });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      const call = notifications.createNotification.mock.calls[0][0];
      expect(call.user_id).toBe('coach-1');
      expect(call.kind).toBe('coach_alert');
      expect(call.deep_link).toBe('tgp://coach/billing/refunds');
      expect(call.channel).toBe('inapp');
      expect(call.body).toMatch(/Refund processed: \$297\.00/);
      expect(call.payload).toMatchObject({
        event: 'refund_processed',
        purchase_id: 'p_alert',
        stripe_refund_id: 'rf_full',
        stripe_charge_id: 'ch_alert',
        amount_refunded_cents: 29_700,
        fully_refunded: true,
        entitlement_revoked: true,
      });
    });

    it('partial refund emits a partial-shaped COACH_ALERT and keeps entitlement_active', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      await svc.handle({
        id: 'evt_partial',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_alert',
            amount: 29_700,
            amount_refunded: 10_000,
            refunds: {
              data: [
                {
                  id: 'rf_partial',
                  amount: 10_000,
                  status: 'succeeded',
                  reason: null,
                },
              ],
            },
          },
        },
      });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      const call = notifications.createNotification.mock.calls[0][0];
      expect(call.body).toMatch(/Partial refund: \$100\.00/);
      expect(call.payload.fully_refunded).toBe(false);
      expect(call.payload.entitlement_revoked).toBe(false);
      // Purchase keeps entitlement.
      expect(prisma._purchases[0].entitlement_active).toBe(true);
      expect(prisma._purchases[0].status).toBe('paid');
    });

    it('redelivery of the same charge.refunded does not double-notify', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      const event = {
        id: 'evt_redeliver',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_alert',
            amount: 29_700,
            amount_refunded: 29_700,
            refunds: {
              data: [
                { id: 'rf_once', amount: 29_700, status: 'succeeded' },
              ],
            },
          },
        },
      };
      await svc.handle(event);
      await svc.handle(event);
      // Stripe redelivery: same refund id, same outcome. We must not
      // fire a second COACH_ALERT.
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    });

    it('pending refund (status != succeeded) does NOT notify', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      await svc.handle({
        id: 'evt_pending',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_alert',
            amount: 29_700,
            amount_refunded: 0,
            refunds: {
              data: [{ id: 'rf_pending', amount: 29_700, status: 'pending' }],
            },
          },
        },
      });
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it('notifier failure does NOT roll back the refund / ledger writes', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      notifications.createNotification.mockRejectedValueOnce(
        new Error('expo unreachable'),
      );
      const result = await svc.handle({
        id: 'evt_notifier_fail',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_alert',
            amount: 29_700,
            amount_refunded: 29_700,
            refunds: {
              data: [{ id: 'rf_n', amount: 29_700, status: 'succeeded' }],
            },
          },
        },
      });
      expect(result.claimed).toBe(true);
      // The ledger reversal + purchase update commit even when the alert
      // throws — the refund row is the source of truth.
      expect(prisma._refunds[0].ledger_reversed).toBe(true);
      expect(prisma._purchases[0].status).toBe('refunded');
      expect(prisma._purchases[0].entitlement_active).toBe(false);
    });

    it('charge.dispute.created emits one COACH_ALERT with disputes deep_link', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      const dueByEpoch = Math.floor(Date.now() / 1000) + 7 * 86400;
      await svc.handle({
        id: 'evt_disp_open',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_alert',
            charge: 'ch_alert',
            status: 'needs_response',
            amount: 29_700,
            currency: 'usd',
            reason: 'fraudulent',
            evidence_details: { due_by: dueByEpoch },
          },
        },
      });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      const call = notifications.createNotification.mock.calls[0][0];
      expect(call.user_id).toBe('coach-1');
      expect(call.kind).toBe('coach_alert');
      expect(call.deep_link).toBe('tgp://coach/billing/disputes');
      expect(call.body).toMatch(/Chargeback opened/);
      expect(call.payload).toMatchObject({
        event: 'dispute_opened',
        purchase_id: 'p_alert',
        stripe_dispute_id: 'dp_alert',
        stripe_charge_id: 'ch_alert',
        reason: 'fraudulent',
      });
      expect(typeof call.payload.evidence_due_by).toBe('string');
    });

    it('redelivery of the same charge.dispute.created does not double-notify', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      const event = {
        id: 'evt_disp_redeliver',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_once',
            charge: 'ch_alert',
            status: 'needs_response',
            amount: 29_700,
          },
        },
      };
      await svc.handle(event);
      await svc.handle(event);
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    });

    // A276-F2-P2-2 — parallel webhook deliveries (two replicas, or
    // create+updated arriving within milliseconds) used to BOTH see
    // existingDispute=null between the findUnique read and the upsert
    // create. Both would fire COACH_ALERT. The new code relies on the
    // DB-level unique index on stripe_dispute_id: whichever call's
    // create() commits first wins; the loser sees P2002 and falls
    // through to the update branch without alerting.
    it('A276-F2-P2-2: parallel charge.dispute.created deliveries fire exactly ONE COACH_ALERT', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      const event = {
        id: 'evt_disp_parallel',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_parallel',
            charge: 'ch_alert',
            status: 'needs_response',
            amount: 29_700,
            reason: 'fraudulent',
          },
        },
      };
      // Two concurrent deliveries — await them together so the second
      // observes (or races with) the first's create. The Prisma stub's
      // create raises P2002 on the second call; the new code converts
      // that into the "not first observation" branch and skips the
      // alert.
      await Promise.all([svc.handle(event), svc.handle(event)]);
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      // Exactly one dispute row exists.
      expect(
        prisma._disputes.filter((d: any) => d.stripe_dispute_id === 'dp_parallel'),
      ).toHaveLength(1);
    });

    // A276-F2-P2-2 — the race-loser branch (P2002 caught) must still
    // converge the dispute row to the latest payload via the update
    // path, so a `charge.dispute.updated` racing against a winning
    // `charge.dispute.created` doesn't drop the under_review status.
    it('A276-F2-P2-2: race loser converges row state via update branch', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      // Pre-seed the row so create() throws P2002 immediately — this
      // is the exact code path the race loser takes.
      prisma._disputes.push({
        id: 'dp-existing',
        stripe_dispute_id: 'dp_race_loser',
        stripe_charge_id: 'ch_alert',
        purchase_id: 'p_alert',
        status: 'needs_response',
        amount_cents: 29_700,
        ledger_reversed: false,
      });
      await svc.handle({
        id: 'evt_disp_race_loser',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_race_loser',
            charge: 'ch_alert',
            status: 'under_review',
            amount: 29_700,
            reason: 'fraudulent',
          },
        },
      });
      // No double-alert.
      expect(notifications.createNotification).not.toHaveBeenCalled();
      // Row converged to the latest payload.
      const row = prisma._disputes.find(
        (d: any) => d.stripe_dispute_id === 'dp_race_loser',
      );
      expect(row.status).toBe('under_review');
      expect(row.reason).toBe('fraudulent');
    });

    // A279-P2-A — out-of-order Stripe dispute deliveries.
    //
    // Scenario: `charge.dispute.updated` arrives first (so the winning
    // create runs with initial=false and does NOT mirror the purchase
    // status); then `charge.dispute.created` arrives second with
    // initial=true, hits P2002 in the create branch, and falls through
    // to the P2002 catch UPDATE. Pre-A279-P2-A that catch branch did
    // NOT mirror ClientPurchase.status, so purchase.status stayed
    // 'paid' forever even though a real dispute was open.
    //
    // This test would FAIL on the pre-A279-P2-A source (purchase.status
    // === 'paid').
    it('A279-P2-A: out-of-order updated→created sequence still flips ClientPurchase.status to disputed', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);

      // 1. `updated` arrives first — initial=false. The winning create
      //    inserts the row but does NOT mirror purchase.status (the
      //    create-branch mirror is guarded by `if (initial)`).
      await svc.handle({
        id: 'evt_disp_oo_updated_first',
        type: 'charge.dispute.updated',
        data: {
          object: {
            id: 'dp_oo_seq',
            charge: 'ch_alert',
            status: 'under_review',
            amount: 29_700,
          },
        },
      });
      // First-observation alert fired (out-of-order delivery still
      // notifies; existing contract).
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      // But purchase is still 'paid' — initial=false skipped the mirror.
      expect(prisma._purchases[0].status).toBe('paid');

      // 2. `created` arrives second — initial=true. Hits P2002 (the
      //    row exists), falls into the catch branch. The A279-P2-A fix
      //    mirrors ClientPurchase.status='disputed' in that branch.
      await svc.handle({
        id: 'evt_disp_oo_created_second',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_oo_seq',
            charge: 'ch_alert',
            status: 'needs_response',
            amount: 29_700,
            reason: 'fraudulent',
          },
        },
      });

      // No double-alert (P2002 catch is not the first-observation).
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      // The contract this test enforces: purchase mirror MUST converge
      // to 'disputed' even when the create event arrives second.
      expect(prisma._purchases[0].status).toBe('disputed');
      // The dispute row converged to the latest create payload too.
      const row = prisma._disputes.find(
        (d: any) => d.stripe_dispute_id === 'dp_oo_seq',
      );
      expect(row.reason).toBe('fraudulent');
    });

    // A279-P2-A — the P2002 catch branch must NOT overwrite an
    // already-refunded purchase. The `notIn: ['disputed', 'refunded']`
    // WHERE guard preserves the existing invariant from the create
    // branch: a stale dispute event arriving after a refund is a no-op.
    it('A279-P2-A: P2002 catch branch does NOT drag a refunded purchase back to disputed', async () => {
      const { svc, prisma, notifications } = makeServices();
      const purchase = seedPurchase(prisma, { status: 'refunded' });
      void purchase;
      // Pre-seed the dispute row so create() raises P2002 — simulates
      // the race-loser arriving after a refund landed.
      prisma._disputes.push({
        id: 'dp-existing-refunded',
        stripe_dispute_id: 'dp_after_refund',
        stripe_charge_id: 'ch_alert',
        purchase_id: 'p_alert',
        status: 'needs_response',
        amount_cents: 29_700,
        ledger_reversed: false,
      });
      await svc.handle({
        id: 'evt_disp_after_refund',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_after_refund',
            charge: 'ch_alert',
            status: 'under_review',
            amount: 29_700,
          },
        },
      });
      // No alert (the row already existed; this is the race-loser path).
      expect(notifications.createNotification).not.toHaveBeenCalled();
      // Purchase stayed 'refunded' — the notIn guard rejected the write.
      expect(prisma._purchases[0].status).toBe('refunded');
    });

    // A276-F2-P2-3 — the dispute first-observation branch wraps the
    // ChargeDispute create + ClientPurchase status mirror in a single
    // $transaction so a crash between the two writes cannot leave a
    // dispute row without the matching purchase.status='disputed'.
    it('A276-F2-P2-3: dispute first-observation runs through $transaction (atomic create + purchase mirror)', async () => {
      const { svc, prisma } = makeServices();
      seedPurchase(prisma);
      await svc.handle({
        id: 'evt_disp_atomic',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_atomic',
            charge: 'ch_alert',
            status: 'needs_response',
            amount: 29_700,
          },
        },
      });
      expect((prisma as any).$transaction).toHaveBeenCalled();
      // Both writes committed: dispute row exists AND purchase is
      // 'disputed'.
      expect(
        prisma._disputes.find((d: any) => d.stripe_dispute_id === 'dp_atomic'),
      ).toBeTruthy();
      expect(prisma._purchases[0].status).toBe('disputed');
    });

    // A276-F2-P2-3 — if the in-tx ClientPurchase mirror write fails,
    // the entire transaction rolls back. There is no orphan dispute row
    // and Stripe will retry the webhook (we propagate the error).
    it('A276-F2-P2-3: a failure inside the dispute $transaction rolls back the create', async () => {
      const { svc, prisma } = makeServices();
      seedPurchase(prisma);
      // Fail the purchase mirror write — in real Prisma this would
      // roll the chargeDispute.create back. Our stub doesn't truly
      // roll back, so we assert the error PROPAGATED (Stripe retry)
      // and the create was never run as a standalone write outside
      // the tx.
      const fakePrismaError: any = new Error('purchase mirror failed');
      prisma.clientPurchase.updateMany.mockImplementationOnce(async () => {
        throw fakePrismaError;
      });
      await expect(
        svc.handle({
          id: 'evt_disp_rollback',
          type: 'charge.dispute.created',
          data: {
            object: {
              id: 'dp_rollback',
              charge: 'ch_alert',
              status: 'needs_response',
              amount: 29_700,
            },
          },
        }),
      ).rejects.toThrow(/purchase mirror failed/);
      // The error was raised from INSIDE $transaction, which propagated
      // it — i.e. the tx was invoked.
      expect((prisma as any).$transaction).toHaveBeenCalled();
    });

    // A276-F2-P2-3 — the full-refund lockstep (ClientPurchase status
    // flip + GuestCheckout mirror) MUST run through $transaction so
    // they commit atomically. Pre-fix, both writes used this.prisma
    // and could half-commit on crash.
    it('A276-F2-P2-3: full refund lockstep writes run through $transaction', async () => {
      const { svc, prisma } = makeServices();
      prisma._purchases.push({
        id: 'p_atomic',
        amount_cents: 29_700,
        coach_user_id: 'coach-1',
        status: 'paid',
        entitlement_active: true,
        stripe_payment_intent_id: 'pi_atomic',
      });
      prisma._splits.push({
        id: 'l_atomic',
        purchase_id: 'p_atomic',
        kind: 'destination',
        amount_cents: 29_700,
        reversed_cents: 0,
        status: 'posted',
        stripe_charge_id: 'ch_atomic',
      });
      prisma._guestCheckouts.push({
        id: 'gc_atomic',
        stripe_payment_intent_id: 'pi_atomic',
        status: 'converted',
      });
      // Reset the $transaction spy so we can assert against THIS call.
      ((prisma as any).$transaction as jest.Mock).mockClear();
      await svc.handle({
        id: 'evt_full_refund_atomic',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_atomic',
            amount: 29_700,
            amount_refunded: 29_700,
            refunds: {
              data: [{ id: 'rf_atomic', amount: 29_700, status: 'succeeded' }],
            },
          },
        },
      });
      // $transaction was invoked for the lockstep writes.
      expect((prisma as any).$transaction).toHaveBeenCalled();
      // Both sides committed.
      expect(prisma._purchases[0].status).toBe('refunded');
      expect(prisma._purchases[0].entitlement_active).toBe(false);
      expect(prisma._guestCheckouts[0].status).toBe('refunded');
    });

    // A276-F2-P2-2 — unique-index conflict is the ONLY swallowed error.
    // Any other failure (DB connection, etc.) must propagate so Stripe
    // retries the webhook.
    it('A276-F2-P2-2: non-P2002 errors from chargeDispute.create propagate', async () => {
      const { svc, prisma } = makeServices();
      seedPurchase(prisma);
      const boom = new Error('connection reset');
      prisma.chargeDispute.create.mockImplementationOnce(async () => {
        throw boom;
      });
      await expect(
        svc.handle({
          id: 'evt_disp_db_boom',
          type: 'charge.dispute.created',
          data: {
            object: {
              id: 'dp_boom',
              charge: 'ch_alert',
              status: 'needs_response',
              amount: 29_700,
            },
          },
        }),
      ).rejects.toThrow(/connection reset/);
    });

    it('charge.dispute.updated DOES alert when no prior created was seen (out-of-order delivery)', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      // Stripe may deliver an `updated` before `created` if the created
      // event was dropped. We still alert so the 7-day evidence window
      // isn't lost.
      await svc.handle({
        id: 'evt_disp_update_first',
        type: 'charge.dispute.updated',
        data: {
          object: {
            id: 'dp_oo',
            charge: 'ch_alert',
            status: 'under_review',
            amount: 29_700,
          },
        },
      });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      const call = notifications.createNotification.mock.calls[0][0];
      expect(call.payload.event).toBe('dispute_opened');
    });

    it('charge.dispute.updated after a prior created does NOT re-notify', async () => {
      const { svc, prisma, notifications } = makeServices();
      seedPurchase(prisma);
      await svc.handle({
        id: 'evt_disp_create',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_seq',
            charge: 'ch_alert',
            status: 'needs_response',
            amount: 29_700,
          },
        },
      });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      await svc.handle({
        id: 'evt_disp_update',
        type: 'charge.dispute.updated',
        data: {
          object: {
            id: 'dp_seq',
            charge: 'ch_alert',
            status: 'under_review',
            amount: 29_700,
          },
        },
      });
      // Still just the one notification from the created event.
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    });

    it('admin-initiated refund emits a COACH_ALERT once', async () => {
      const { svc, prisma, stripe, notifications } = makeServices();
      seedPurchase(prisma, { stripe_payment_intent_id: 'pi_admin' });
      // Override the default mock so Stripe returns a FULL refund of
      // the purchase amount; the admin path uses the Stripe-returned
      // amount as the canonical refund amount.
      stripe.createRefund.mockResolvedValueOnce({
        id: 'rf_admin_full',
        amount: 29_700,
        status: 'succeeded',
      });
      await svc.createAdminRefund({
        purchase_id: 'p_alert',
        amount_cents: 29_700,
        reason: 'requested_by_customer',
        note: null,
        initiated_by_user_id: 'owner-1',
      });
      expect(notifications.createNotification).toHaveBeenCalledTimes(1);
      const call = notifications.createNotification.mock.calls[0][0];
      expect(call.deep_link).toBe('tgp://coach/billing/refunds');
      expect(call.payload.event).toBe('refund_processed');
      expect(call.payload.fully_refunded).toBe(true);
      expect(prisma._purchases[0].status).toBe('refunded');
      expect(prisma._purchases[0].entitlement_active).toBe(false);
    });
  });
});
