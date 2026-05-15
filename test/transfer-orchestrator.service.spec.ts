import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';

function makePrismaStub() {
  const transfers: any[] = [];
  const ledger: any[] = [];
  let n = 0;
  return {
    _transfers: transfers,
    _ledger: ledger,
    connectTransfer: {
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = transfers.find((t) => t.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = transfers.find(
          (t) => t.idempotency_key === where.idempotency_key,
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
        transfers.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = transfers.find((t) => t.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
      findMany: jest.fn(async () => transfers.filter((t) => t.status === 'pending')),
    },
    splitLedgerEntry: {
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = ledger.find((e) => e.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = ledger.find((e) => e.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

class StripeStub extends StripeConnectApiService {
  createTransfer = jest.fn(async (args: any) => ({
    id: 'tr_' + args.idempotencyKey,
    amount: args.amount,
    currency: args.currency,
    destination: args.destination,
  }));
  reverseTransfer = jest.fn(async (args: any) => ({
    id: 'trr_' + args.idempotencyKey,
    transfer: args.transfer_id,
    amount: args.amount ?? 0,
  }));
}

describe('TransferOrchestratorService', () => {
  let prisma: any;
  let stripe: StripeStub;
  let svc: TransferOrchestratorService;
  let ledger: SplitLedgerService;

  beforeEach(() => {
    prisma = makePrismaStub();
    stripe = new StripeStub();
    ledger = new SplitLedgerService(prisma);
    svc = new TransferOrchestratorService(prisma, stripe as any, ledger);
  });

  it('idempotently enqueues a head-coach transfer (same purchase => same row)', async () => {
    const a = await svc.enqueueHeadCoachTransfer({
      purchase_id: 'p1',
      ledger_entry_id: 'le1',
      destination_stripe_account_id: 'acct_head',
      destination_user_id: 'head-1',
      amount_cents: 500,
      currency: 'usd',
      source_stripe_charge_id: 'ch_abc',
    });
    const b = await svc.enqueueHeadCoachTransfer({
      purchase_id: 'p1',
      ledger_entry_id: 'le1',
      destination_stripe_account_id: 'acct_head',
      destination_user_id: 'head-1',
      amount_cents: 500,
      currency: 'usd',
      source_stripe_charge_id: 'ch_abc',
    });
    expect(a.id).toBe(b.id);
    expect(prisma._transfers).toHaveLength(1);
  });

  it('posts a pending transfer to Stripe with source_transaction set', async () => {
    prisma._ledger.push({ id: 'le1', purchase_id: 'p1', kind: 'head_coach_split' });
    const row = await svc.enqueueHeadCoachTransfer({
      purchase_id: 'p1',
      ledger_entry_id: 'le1',
      destination_stripe_account_id: 'acct_head',
      destination_user_id: 'head-1',
      amount_cents: 500,
      currency: 'usd',
      source_stripe_charge_id: 'ch_abc',
    });
    const out = await svc.attempt(row.id);
    expect(stripe.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500,
        destination: 'acct_head',
        source_transaction: 'ch_abc',
      }),
    );
    expect(out.status).toBe('succeeded');
    expect(out.stripe_transfer_id).toMatch(/^tr_/);
    // Ledger entry should now be posted with the transfer id.
    expect(prisma._ledger[0].status).toBe('posted');
    expect(prisma._ledger[0].stripe_transfer_id).toMatch(/^tr_/);
  });

  it('reuses the same Stripe-Idempotency-Key on retry', async () => {
    prisma._ledger.push({ id: 'le1', purchase_id: 'p1', kind: 'head_coach_split' });
    const row = await svc.enqueueHeadCoachTransfer({
      purchase_id: 'p1',
      ledger_entry_id: 'le1',
      destination_stripe_account_id: 'acct_head',
      destination_user_id: 'head-1',
      amount_cents: 500,
      currency: 'usd',
      source_stripe_charge_id: 'ch_abc',
    });
    // First attempt: simulate Stripe error.
    stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError('balance not available', 400, 'balance_insufficient', 'invalid_request_error'),
    );
    let attempt = await svc.attempt(row.id);
    expect(attempt.status).toBe('pending');
    expect(attempt.last_error).toMatch(/balance/);
    // Stripe row should be back in pending with next_attempt_at in the future.
    expect(prisma._transfers[0].next_attempt_at).toBeInstanceOf(Date);
    // Second attempt succeeds — same idempotency key.
    attempt = await svc.attempt(row.id);
    const calls = stripe.createTransfer.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    expect(attempt.status).toBe('succeeded');
  });

  it('marks final-failed after max_attempts', async () => {
    prisma._ledger.push({ id: 'le1', purchase_id: 'p1', kind: 'head_coach_split' });
    const row = await svc.enqueueHeadCoachTransfer({
      purchase_id: 'p1',
      ledger_entry_id: 'le1',
      destination_stripe_account_id: 'acct_head',
      destination_user_id: 'head-1',
      amount_cents: 500,
      currency: 'usd',
      source_stripe_charge_id: 'ch_abc',
    });
    // Force max_attempts down for the test.
    prisma._transfers[0].max_attempts = 1;
    stripe.createTransfer.mockRejectedValue(
      new StripeConnectApiError('boom', 500, 'api_error', 'api_error'),
    );
    const updated = await svc.attempt(row.id);
    expect(updated.status).toBe('failed');
    expect(prisma._ledger[0].status).toBe('failed');
  });

  it('reverses a posted transfer (partial then full)', async () => {
    prisma._ledger.push({
      id: 'le1',
      purchase_id: 'p1',
      kind: 'head_coach_split',
      amount_cents: 500,
      reversed_cents: 0,
      status: 'posted',
    });
    const row = await svc.enqueueHeadCoachTransfer({
      purchase_id: 'p1',
      ledger_entry_id: 'le1',
      destination_stripe_account_id: 'acct_head',
      destination_user_id: 'head-1',
      amount_cents: 500,
      currency: 'usd',
      source_stripe_charge_id: 'ch_abc',
    });
    await svc.attempt(row.id);

    await svc.reverse({ transfer_row_id: row.id, amount_cents: 200 });
    expect(prisma._ledger[0].reversed_cents).toBe(200);
    expect(prisma._ledger[0].status).toBe('posted');

    await svc.reverse({ transfer_row_id: row.id, amount_cents: 300 });
    expect(prisma._ledger[0].reversed_cents).toBe(500);
    expect(prisma._ledger[0].status).toBe('reversed');
  });
});
