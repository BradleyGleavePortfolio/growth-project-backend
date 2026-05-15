import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

// End-to-end test of the post-charge split flow:
//   onChargeSucceeded -> ledger entries created + posted, head-coach
//   Transfer enqueued and posted to Stripe.

class StripeStub extends StripeConnectApiService {
  retrievePaymentIntent = jest.fn(async (_id: string) => ({
    id: _id,
    latest_charge: 'ch_test',
  }));
  createTransfer = jest.fn(async (args: any) => ({
    id: 'tr_' + args.idempotencyKey,
    amount: args.amount,
    currency: args.currency,
    destination: args.destination,
  }));
}

function makePrismaStub() {
  const data: any = {
    connectAccounts: [] as any[],
    feePolicies: [] as any[],
    teamAssignments: [] as any[],
    purchases: [] as any[],
    splitLedger: [] as any[],
    transfers: [] as any[],
  };
  let n = 0;
  return {
    _data: data,
    connectAccount: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.connectAccounts.find((a: any) => a.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
    feePolicy: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.feePolicies.find((p: any) => p.coach_id === where.coach_id) ?? null,
      ),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          data.teamAssignments.find(
            (a: any) =>
              a.sub_coach_id === where.sub_coach_id && a.archived_at == null,
          ) ?? null
        );
      }),
    },
    splitLedgerEntry: {
      findFirst: jest.fn(async ({ where }: any) =>
        data.splitLedger.find(
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
        const existing = data.splitLedger.find(
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
          created_at: new Date(),
          ...create,
        };
        data.splitLedger.push(row);
        return { ...row };
      }),
      create: jest.fn(async ({ data: input }: any) => {
        const row = {
          id: 'le-' + ++n,
          status: 'pending',
          reversed_cents: 0,
          ...input,
        };
        data.splitLedger.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data: patch }: any) => {
        const row = data.splitLedger.find((e: any) => e.id === where.id);
        Object.assign(row, patch);
        return { ...row };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = data.splitLedger.find((e: any) => e.id === where.id);
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
  };
}

function makeService() {
  const prisma = makePrismaStub();
  const stripe = new StripeStub();
  const fee = new FeePolicyService(prisma as any);
  const ledger = new SplitLedgerService(prisma as any);
  const transfers = new TransferOrchestratorService(prisma as any, stripe as any, ledger);
  const svc = new PurchaseSplitHandlerService(
    prisma as any,
    stripe as any,
    fee,
    ledger,
    transfers,
  );
  return { svc, prisma, stripe };
}

const SOLO_PURCHASE = {
  id: 'p-solo',
  client_user_id: 'cli-1',
  coach_user_id: 'coach-solo',
  package_id: 'pk',
  amount_cents: 10_000,
  currency: 'usd',
  stripe_payment_intent_id: 'pi_abc',
  billing_type: 'one_time',
  status: 'paid',
} as any;

const SUB_PURCHASE = {
  id: 'p-sub',
  client_user_id: 'cli-2',
  coach_user_id: 'sub-1',
  package_id: 'pk',
  amount_cents: 10_000,
  currency: 'usd',
  stripe_payment_intent_id: 'pi_def',
  billing_type: 'one_time',
  status: 'paid',
} as any;

describe('PurchaseSplitHandlerService (end-to-end)', () => {
  describe('solo PT', () => {
    it('writes application_fee + destination as posted, no transfer enqueued', async () => {
      const { svc, prisma, stripe } = makeService();
      prisma._data.connectAccounts.push({
        coach_user_id: 'coach-solo',
        stripe_account_id: 'acct_solo',
      });
      const result = await svc.onChargeSucceeded({ purchase: SOLO_PURCHASE });
      expect(result.ledger_entries).toBe(2);
      expect(result.transfer_enqueued).toBe(false);
      expect(result.charge_id).toBe('ch_test');
      // application_fee posted with charge id
      const appFee = prisma._data.splitLedger.find((e: any) => e.kind === 'application_fee');
      expect(appFee.status).toBe('posted');
      expect(appFee.amount_cents).toBe(200);
      expect(appFee.stripe_charge_id).toBe('ch_test');
      // destination posted with charge id, amount = 98%
      const dest = prisma._data.splitLedger.find((e: any) => e.kind === 'destination');
      expect(dest.status).toBe('posted');
      expect(dest.amount_cents).toBe(9_800);
      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });
  });

  describe('sub-coach', () => {
    it('writes three ledger rows + posts a head-coach transfer with source_transaction=ch_test', async () => {
      const { svc, prisma, stripe } = makeService();
      prisma._data.connectAccounts.push({
        coach_user_id: 'sub-1',
        stripe_account_id: 'acct_sub',
      });
      prisma._data.connectAccounts.push({
        coach_user_id: 'head-1',
        stripe_account_id: 'acct_head',
      });
      prisma._data.teamAssignments.push({
        sub_coach_id: 'sub-1',
        head_coach_id: 'head-1',
        archived_at: null,
        created_at: new Date(),
      });

      const result = await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      expect(result.ledger_entries).toBe(3);
      expect(result.transfer_enqueued).toBe(true);

      const hcs = prisma._data.splitLedger.find((e: any) => e.kind === 'head_coach_split');
      expect(hcs.amount_cents).toBe(500);
      expect(hcs.payee_user_id).toBe('head-1');

      const dest = prisma._data.splitLedger.find((e: any) => e.kind === 'destination');
      expect(dest.amount_cents).toBe(9_300);

      // Stripe transfer was created with source_transaction.
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 500,
          destination: 'acct_head',
          source_transaction: 'ch_test',
        }),
      );
      // Transfer row stamped succeeded.
      expect(prisma._data.transfers[0].status).toBe('succeeded');
      // head_coach_split ledger entry stamped posted with transfer id.
      expect(hcs.status).toBe('posted');
      expect(hcs.stripe_transfer_id).toMatch(/^tr_/);
    });

    it('is idempotent — re-invoking onChargeSucceeded does not double-post the transfer', async () => {
      const { svc, prisma, stripe } = makeService();
      prisma._data.connectAccounts.push({
        coach_user_id: 'sub-1',
        stripe_account_id: 'acct_sub',
      });
      prisma._data.connectAccounts.push({
        coach_user_id: 'head-1',
        stripe_account_id: 'acct_head',
      });
      prisma._data.teamAssignments.push({
        sub_coach_id: 'sub-1',
        head_coach_id: 'head-1',
        archived_at: null,
        created_at: new Date(),
      });

      await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      const firstCallCount = stripe.createTransfer.mock.calls.length;
      await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      // Second call may invoke Stripe once more (idempotency-key collapses
      // on Stripe's side), but the local ConnectTransfer row count must
      // stay at 1.
      expect(prisma._data.transfers).toHaveLength(1);
      // Same idempotency key reused across attempts.
      const keys = new Set(
        stripe.createTransfer.mock.calls.map((c: any) => c[0].idempotencyKey),
      );
      expect(keys.size).toBe(1);
      expect(stripe.createTransfer.mock.calls.length).toBeGreaterThanOrEqual(
        firstCallCount,
      );
    });

    it('skips the head-coach transfer when the head coach has no Connect account', async () => {
      const { svc, prisma, stripe } = makeService();
      prisma._data.connectAccounts.push({
        coach_user_id: 'sub-1',
        stripe_account_id: 'acct_sub',
      });
      prisma._data.teamAssignments.push({
        sub_coach_id: 'sub-1',
        head_coach_id: 'head-1',
        archived_at: null,
        created_at: new Date(),
      });
      const result = await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      // head coach has no acct -> ledger only has application_fee + destination
      expect(result.ledger_entries).toBe(2);
      expect(result.transfer_enqueued).toBe(false);
      expect(stripe.createTransfer).not.toHaveBeenCalled();
    });
  });

  it('skips the entire split when the seller has no Connect account', async () => {
    const { svc, prisma, stripe } = makeService();
    const result = await svc.onChargeSucceeded({ purchase: SOLO_PURCHASE });
    expect(result.ledger_entries).toBe(0);
    expect(result.transfer_enqueued).toBe(false);
    expect(prisma._data.splitLedger).toHaveLength(0);
    expect(stripe.createTransfer).not.toHaveBeenCalled();
  });
});
