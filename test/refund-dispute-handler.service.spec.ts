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
