import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';

function makePrismaStub() {
  const transfers: any[] = [];
  const ledger: any[] = [];
  // Round 4 (B-627-5): keyed reversal operations.
  const ops: any[] = [];
  let n = 0;
  // Prisma where semantics the orchestrator uses: equality (null matches a
  // missing column; dates compare by instant), `in`, and OR.
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((w: any) => matches(row, w));
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
      return row[k] === v;
    });
  const stub: any = {
    _transfers: transfers,
    _ledger: ledger,
    _ops: ops,
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(stub)),
    transferReversalOp: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          ops.find((o) => o.idempotency_key === where.idempotency_key) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        ops.filter((o) => matches(o, where)).sort((a, b) => a.seq - b.seq),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 'op-' + ++n, attempts: 0, last_error: null, ...data };
        ops.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = ops.find((o) => o.id === where.id);
        for (const [k, v] of Object.entries<any>(data)) {
          row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
        }
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = ops.filter((o) => matches(o, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      }),
    },
    connectTransfer: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = transfers.filter((t) => matches({ reversal_seq: 0, ...t }, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = transfers.find((t) => t.id === where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = transfers.find((t) => t.idempotency_key === where.idempotency_key);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          id: 'tr-' + ++n,
          attempts: 0,
          max_attempts: 6,
          reversed_amount_cents: 0,
          reversal_seq: 0,
          created_at: new Date(),
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
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = ledger.filter((e) => matches(e, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      }),
    },
  };
  return stub;
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
  listTransferReversals = jest.fn(async () => ({ data: [], has_more: false }));
  // B-627-8 (round 7): nothing at Stripe unless a test says otherwise.
  listTransfers = jest.fn(async () => ({ data: [], has_more: false }));
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
    prisma._ledger.push({
      id: 'le1',
      purchase_id: 'p1',
      kind: 'head_coach_split',
      status: 'pending',
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
    prisma._ledger.push({
      id: 'le1',
      purchase_id: 'p1',
      kind: 'head_coach_split',
      status: 'pending',
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
    // First attempt: simulate Stripe error.
    stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError(
        'balance not available',
        400,
        'balance_insufficient',
        'invalid_request_error',
      ),
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

  it("final failure at max_attempts needs Stripe's answer (B-627-8 / B-627-9: an unresolved create is adopted, never failed from elapsed time)", async () => {
    prisma._ledger.push({
      id: 'le1',
      purchase_id: 'p1',
      kind: 'head_coach_split',
      status: 'pending',
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
    // Force max_attempts down for the test.
    prisma._transfers[0].max_attempts = 1;
    stripe.createTransfer.mockRejectedValue(
      new StripeConnectApiError('boom', 500, 'api_error', 'api_error'),
    );
    // A 500 may have executed: never final on the attempt that sent it.
    const first = await svc.attempt(row.id);
    expect(first.status).toBe('pending');
    expect(prisma._transfers[0].stripe_send_unresolved_at).toBeInstanceOf(Date);
    expect(prisma._ledger[0].status).not.toBe('failed');
    // B-627-9: an immediate re-check is inside the in-flight window: held,
    // never failed while the create may still execute.
    const held = await svc.attempt(row.id);
    expect(held.status).toBe('pending');
    expect(prisma._ledger[0].status).not.toBe('failed');
    // Round 9: after the window an absent listing is not proof (the sender
    // may be paused before its request). At the budget the unresolved attempt
    // is adopted: re-sent under the SAME key, without a new attempt.
    const later = Date.now() + svc.inFlightWindowMs + 1_000;
    svc.clock = () => new Date(later);
    const adopted = await svc.attempt(row.id);
    expect(stripe.createTransfer).toHaveBeenCalledTimes(2);
    const calls = stripe.createTransfer.mock.calls;
    expect(calls[1][0].idempotencyKey).toBe(calls[0][0].idempotencyKey);
    expect(adopted.status).toBe('pending'); // still a 500: not failed
    expect(prisma._transfers[0].attempts).toBe(1);
    expect(prisma._transfers[0].stripe_send_unresolved_at.getTime()).toBe(later);
    expect(prisma._ledger[0].status).not.toBe('failed');
    // Stripe's definitive answer for the key is the proof of final failure.
    stripe.createTransfer.mockRejectedValue(
      new StripeConnectApiError(
        'No such destination',
        400,
        'resource_missing',
        'invalid_request_error',
      ),
    );
    const muchLater = later + 25 * 3_600_000;
    svc.clock = () => new Date(muchLater);
    const updated = await svc.attempt(row.id);
    expect(stripe.createTransfer).toHaveBeenCalledTimes(3);
    expect(updated.status).toBe('failed');
    expect(prisma._transfers[0].stripe_send_unresolved_at).toBeNull();
    expect(prisma._ledger[0].status).toBe('failed');
  });

  it('a definitive refusal (4xx) at the attempt budget is final at once', async () => {
    prisma._ledger.push({
      id: 'le1',
      purchase_id: 'p1',
      kind: 'head_coach_split',
      status: 'pending',
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
    prisma._transfers[0].max_attempts = 1;
    stripe.createTransfer.mockRejectedValue(
      new StripeConnectApiError(
        'balance not available',
        400,
        'balance_insufficient',
        'invalid_request_error',
      ),
    );
    const updated = await svc.attempt(row.id);
    expect(updated.status).toBe('failed');
    expect(stripe.listTransfers).not.toHaveBeenCalled();
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
    // Round 4: one durable keyed operation per reversal, both completed.
    expect(prisma._ops.map((o: any) => [o.idempotency_key, o.amount_cents, o.status])).toEqual([
      [`tgp-tr-rev-${row.id}-op1`, 200, 'succeeded'],
      [`tgp-tr-rev-${row.id}-op2`, 300, 'succeeded'],
    ]);
  });

  it('a definitive Stripe refusal is reported as refused, an unknown outcome throws (never refused)', async () => {
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
    stripe.reverseTransfer.mockRejectedValueOnce(
      new StripeConnectApiError(
        'Insufficient funds',
        400,
        'balance_insufficient',
        'invalid_request_error',
      ),
    );
    await expect(
      svc.reverse({ transfer_row_id: row.id, amount_cents: 200 }),
    ).resolves.toMatchObject({
      status: 'refused',
    });
    stripe.reverseTransfer.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(svc.reverse({ transfer_row_id: row.id, amount_cents: 200 })).rejects.toMatchObject(
      {
        code: 'SFEE_REVERSAL_UNCERTAIN',
      },
    );
    expect(prisma._ops.map((o: any) => o.status)).toEqual(['refused', 'pending']);
    expect(prisma._ledger[0].reversed_cents).toBe(0);
  });
});
