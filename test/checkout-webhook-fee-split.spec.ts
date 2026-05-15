import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { DunningService } from '../src/checkout/dunning.service';
import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

// Integration-style: wires the actual webhook handler against an
// in-memory prisma stub + stub Stripe client to verify lifecycle events
// drive the Phase 4-5 ledger and dunning state through real code paths.

class StripeStub extends StripeConnectApiService {
  retrievePaymentIntent = jest.fn(async (_id: string) => ({
    id: _id,
    latest_charge: 'ch_test',
  }));
  retrieveSubscription = jest.fn(async (id: string) => ({
    id,
    status: 'active',
    current_period_end: Math.floor((Date.now() + 30 * 24 * 3600 * 1000) / 1000),
  }));
  createTransfer = jest.fn(async (args: any) => ({
    id: 'tr_' + args.idempotencyKey,
    amount: args.amount,
    currency: args.currency,
    destination: args.destination,
  }));
  cancelSubscription = jest.fn();
}

function makePrismaStub() {
  const data: any = {
    purchases: [] as any[],
    packages: [] as any[],
    customers: [] as any[],
    accounts: [] as any[],
    splits: [] as any[],
    transfers: [] as any[],
    dunning: [] as any[],
    reminders: [] as any[],
    feePolicies: [] as any[],
    assignments: [] as any[],
  };
  let n = 0;
  return {
    _data: data,
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.purchases.find(
          (p: any) =>
            (where.stripe_checkout_session_id &&
              p.stripe_checkout_session_id === where.stripe_checkout_session_id) ||
            (where.stripe_subscription_id &&
              p.stripe_subscription_id === where.stripe_subscription_id) ||
            (where.id && p.id === where.id),
        ) ?? null,
      ),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ where, data: patch }: any) => {
        const row = data.purchases.find((p: any) => p.id === where.id);
        Object.assign(row, patch);
        return { ...row };
      }),
    },
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.packages.find((p: any) => p.id === where.id) ?? null,
      ),
    },
    connectCustomer: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(),
    },
    connectAccount: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.accounts.find((a: any) => a.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
    feePolicy: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.feePolicies.find((f: any) => f.coach_id === where.coach_id) ?? null,
      ),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async ({ where }: any) =>
        data.assignments.find(
          (a: any) =>
            a.sub_coach_id === where.sub_coach_id && a.archived_at == null,
        ) ?? null,
      ),
    },
    splitLedgerEntry: {
      findFirst: jest.fn(async ({ where }: any) =>
        data.splits.find(
          (e: any) =>
            e.purchase_id === where.purchase_id &&
            e.kind === where.kind &&
            (where.payee_user_id === null
              ? e.payee_user_id == null
              : e.payee_user_id === where.payee_user_id),
        ) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const composite = where.purchase_id_kind_payee_user_id;
        const existing = data.splits.find(
          (e: any) =>
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
          ...create,
        };
        data.splits.push(row);
        return { ...row };
      }),
      create: jest.fn(async ({ data: input }: any) => {
        const row = {
          id: 'le-' + ++n,
          status: 'pending',
          reversed_cents: 0,
          ...input,
        };
        data.splits.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data: patch }: any) => {
        const row = data.splits.find((e: any) => e.id === where.id);
        Object.assign(row, patch);
        return { ...row };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = data.splits.find((e: any) => e.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
    },
    connectTransfer: {
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = data.transfers.find((t: any) => t.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = data.transfers.find(
          (t: any) => t.idempotency_key === where.idempotency_key,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          id: 'tr-' + ++n,
          attempts: 0,
          max_attempts: 6,
          reversed_amount_cents: 0,
          ...create,
        };
        data.transfers.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data: patch }: any) => {
        const row = data.transfers.find((t: any) => t.id === where.id);
        Object.assign(row, patch);
        return { ...row };
      }),
      findMany: jest.fn(async () => data.transfers.filter((t: any) => t.status === 'pending')),
    },
    dunningState: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.dunning.find((d: any) => d.purchase_id === where.purchase_id) ?? null,
      ),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data: input }: any) => {
        const row = { id: 'd-' + ++n, ...input };
        data.dunning.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data: patch }: any) => {
        const row = data.dunning.find((d: any) =>
          where.purchase_id ? d.purchase_id === where.purchase_id : d.id === where.id,
        );
        if (patch.failure_count?.increment) {
          row.failure_count = (row.failure_count ?? 0) + patch.failure_count.increment;
          delete patch.failure_count;
        }
        Object.assign(row, patch);
        return { ...row };
      }),
    },
    paymentReminder: {
      create: jest.fn(async ({ data: input }: any) => {
        const dupe = data.reminders.find(
          (r: any) =>
            r.purchase_id === input.purchase_id &&
            r.kind === input.kind &&
            r.channel === input.channel &&
            r.window_key === input.window_key,
        );
        if (dupe) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: 'r-' + ++n, ...input };
        data.reminders.push(row);
        return { ...row };
      }),
    },
  };
}

function makeHandler() {
  const prisma = makePrismaStub();
  const stripe = new StripeStub();
  const fee = new FeePolicyService(prisma as any);
  const ledger = new SplitLedgerService(prisma as any);
  const transfers = new TransferOrchestratorService(prisma as any, stripe as any, ledger);
  const splits = new PurchaseSplitHandlerService(
    prisma as any,
    stripe as any,
    fee,
    ledger,
    transfers,
  );
  const dunning = new DunningService(prisma as any, stripe as any);
  const handler = new CheckoutWebhookHandlerService(
    prisma as any,
    stripe as any,
    splits,
    dunning,
  );
  return { handler, prisma, stripe };
}

describe('CheckoutWebhookHandlerService Phase 4-5 integration', () => {
  it('checkout.session.completed materializes the ledger and posts the head-coach transfer', async () => {
    const { handler, prisma, stripe } = makeHandler();
    prisma._data.purchases.push({
      id: 'p1',
      coach_user_id: 'sub-1',
      client_user_id: 'cli-1',
      package_id: 'pk',
      stripe_checkout_session_id: 'cs_1',
      amount_cents: 10_000,
      currency: 'usd',
      billing_type: 'one_time',
      status: 'pending',
      created_at: new Date(),
    });
    prisma._data.accounts.push(
      { coach_user_id: 'sub-1', stripe_account_id: 'acct_sub' },
      { coach_user_id: 'head-1', stripe_account_id: 'acct_head' },
    );
    prisma._data.assignments.push({
      sub_coach_id: 'sub-1',
      head_coach_id: 'head-1',
      archived_at: null,
      created_at: new Date(),
    });

    const result = await handler.handle({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'payment',
          payment_intent: 'pi_abc',
          customer: 'cus_x',
          status: 'complete',
        },
      },
    });
    expect(result.claimed).toBe(true);
    expect(prisma._data.purchases[0].status).toBe('paid');
    expect(prisma._data.purchases[0].entitlement_active).toBe(true);
    // 3 ledger entries (sub-coach scenario).
    expect(prisma._data.splits).toHaveLength(3);
    // Head-coach transfer was posted.
    expect(stripe.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, destination: 'acct_head' }),
    );
    expect(prisma._data.transfers[0].status).toBe('succeeded');
  });

  it('replaying checkout.session.completed is idempotent (no duplicate ledger or transfer rows)', async () => {
    const { handler, prisma, stripe } = makeHandler();
    prisma._data.purchases.push({
      id: 'p1',
      coach_user_id: 'sub-1',
      client_user_id: 'cli-1',
      package_id: 'pk',
      stripe_checkout_session_id: 'cs_1',
      amount_cents: 10_000,
      currency: 'usd',
      billing_type: 'one_time',
      status: 'pending',
      created_at: new Date(),
    });
    prisma._data.accounts.push(
      { coach_user_id: 'sub-1', stripe_account_id: 'acct_sub' },
      { coach_user_id: 'head-1', stripe_account_id: 'acct_head' },
    );
    prisma._data.assignments.push({
      sub_coach_id: 'sub-1',
      head_coach_id: 'head-1',
      archived_at: null,
      created_at: new Date(),
    });

    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: { id: 'cs_1', mode: 'payment', payment_intent: 'pi_abc' },
      },
    };
    await handler.handle(event);
    await handler.handle(event);
    await handler.handle(event);
    expect(prisma._data.splits).toHaveLength(3);
    expect(prisma._data.transfers).toHaveLength(1);
    // All createTransfer calls share the same idempotency-key
    const keys = new Set(stripe.createTransfer.mock.calls.map((c: any) => c[0].idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it('invoice.payment_failed opens a dunning window and queues a reminder', async () => {
    const { handler, prisma } = makeHandler();
    prisma._data.purchases.push({
      id: 'p1',
      coach_user_id: 'coach-1',
      client_user_id: 'cli-1',
      package_id: 'pk',
      stripe_checkout_session_id: 'cs_1',
      stripe_subscription_id: 'sub_abc',
      amount_cents: 9900,
      currency: 'usd',
      billing_type: 'recurring',
      status: 'active',
      created_at: new Date(),
    });
    const result = await handler.handle({
      id: 'evt_failed',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1',
          subscription: 'sub_abc',
          amount_due: 9900,
          attempt_count: 1,
          last_payment_error: { message: 'card_declined' },
        },
      },
    });
    expect(result.claimed).toBe(true);
    expect(prisma._data.purchases[0].status).toBe('past_due');
    expect(prisma._data.dunning).toHaveLength(1);
    expect(prisma._data.dunning[0].status).toBe('active');
    // Two reminders (inapp + email).
    expect(prisma._data.reminders).toHaveLength(2);
  });

  it('invoice.paid resolves the dunning window after a recovery', async () => {
    const { handler, prisma } = makeHandler();
    prisma._data.purchases.push({
      id: 'p1',
      coach_user_id: 'coach-1',
      client_user_id: 'cli-1',
      package_id: 'pk',
      stripe_checkout_session_id: 'cs_1',
      stripe_subscription_id: 'sub_abc',
      amount_cents: 9900,
      currency: 'usd',
      billing_type: 'recurring',
      status: 'past_due',
      created_at: new Date(),
    });
    prisma._data.accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_solo',
    });
    prisma._data.dunning.push({
      id: 'd1',
      purchase_id: 'p1',
      status: 'active',
      failure_count: 1,
    });
    const result = await handler.handle({
      id: 'evt_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_2',
          subscription: 'sub_abc',
          amount_paid: 9900,
          charge: 'ch_renew',
        },
      },
    });
    expect(result.claimed).toBe(true);
    expect(prisma._data.dunning[0].status).toBe('resolved');
    expect(prisma._data.dunning[0].resolved_at).toBeInstanceOf(Date);
  });
});
