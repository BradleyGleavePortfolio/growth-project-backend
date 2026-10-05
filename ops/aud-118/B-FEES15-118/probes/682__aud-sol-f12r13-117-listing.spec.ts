import { Logger } from '@nestjs/common';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { asPrisma, FakeStripe, makeSettlementPrisma } from './utils/settlement-fakes';

// Actual API parser, mocked HTTP only. This does not replace the money
// service's lookup helpers or introduce a compile-time lie about list shape.
class ListingWire extends StripeConnectApiService {
  readonly fetched: string[] = [];
  constructor(private readonly envelope: unknown) { super(); }
  protected fetchImpl: typeof fetch = async (input) => {
    this.fetched.push(String(input));
    return new Response(JSON.stringify(this.envelope), { status: 200 });
  };
}

function fixture() {
  const { db, prisma } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, new SplitLedgerService(asPrisma(prisma)));
  return { db, prisma, stripe, svc };
}

const enqueue = (f: ReturnType<typeof fixture>, kind: 'coach_reinstate' | 'head_coach_reinstate' | 'coach_net') =>
  f.svc.enqueueSettlementTransfer({
    settlement_id: 'cs_probe', purchase_id: 'p_probe', kind,
    ledger_entry_id: null, destination_stripe_account_id: 'acct_probe',
    destination_user_id: 'payee_probe', amount_cents: 1_000, netted_recovery_cents: 0,
    currency: 'usd', source_stripe_charge_id: kind === 'coach_net' ? 'ch_probe' : null,
    idempotency_key: `op_probe_${kind}`,
  });

const badPages = [
  ['missing data', { has_more: false }],
  ['missing terminal marker', { data: [] }],
] as const;

describe('AUD-SOL-F12R13-117 malformed listings cannot prove non-execution', () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_auditNoNetwork0001';
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecret;
  });

  for (const kind of ['coach_reinstate', 'head_coach_reinstate'] as const) {
    it.each(badPages)(`${kind}: %s stays unknown after response loss and key expiry`, async (_label, envelope) => {
      const f = fixture();
      const row = await enqueue(f, kind);
      f.stripe.transferResponsesLost = 1;
      f.stripe.failListTransfers = true;
      expect((await f.svc.attempt(row.id)).status).toBe('pending');
      expect(f.stripe.netTo('acct_probe')).toBe(1_000);
      f.stripe.expireIdempotencyKeys();
      f.svc.clock = () => new Date(Date.now() + 25 * 3_600_000);
      const wire = new ListingWire(envelope);
      Object.defineProperty(f.stripe, 'listTransfers', {
        value: jest.fn((args: Parameters<StripeConnectApiService['listTransfers']>[0]) => wire.listTransfers(args)),
      });
      const result = await f.svc.attempt(row.id);
      expect(wire.fetched.length).toBeGreaterThan(0);
      console.log('AUD117_BAD_TRANSFER_LIST', { envelope, kind, external: f.stripe.netTo('acct_probe'), booked: result.amount_cents, status: result.status });
      expect(f.stripe.netTo('acct_probe')).toBe(1_000);
      expect(result.status).toBe('pending');
      // Once a validated listing recovers the original object, repair its
      // receipt instead of making a second transfer.
      Object.defineProperty(f.stripe, 'listTransfers', {
        value: jest.fn(async () => ({ data: f.stripe.transfers, has_more: false })),
      });
      expect((await f.svc.attempt(row.id)).status).toBe('succeeded');
      expect(f.stripe.transfers).toHaveLength(1);
    });
  }

  it.each(badPages)('reversal: %s stays unknown after response loss and key expiry', async (_label, envelope) => {
    const f = fixture();
    const row = await f.svc.attempt((await enqueue(f, 'coach_net')).id);
    f.stripe.reversalResponsesLost = 1;
    f.stripe.failListReversals = true;
    await expect(f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 }))
      .rejects.toMatchObject({ code: 'SFEE_REVERSAL_UNCERTAIN' });
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    f.stripe.expireIdempotencyKeys();
    const wire = new ListingWire(envelope);
    Object.defineProperty(f.stripe, 'listTransferReversals', {
      value: jest.fn((id: string, args: Parameters<StripeConnectApiService['listTransferReversals']>[1]) => wire.listTransferReversals(id, args)),
    });
    const result = await f.svc.resolvePendingReversals(row.id).then(() => 'resolved', (err: unknown) => err);
    expect(wire.fetched.length).toBeGreaterThan(0);
    console.log('AUD117_BAD_REVERSAL_LIST', { envelope, external: f.stripe.reversedOn(row.stripe_transfer_id!), booked: f.db.transfers[0].reversed_amount_cents, opStatus: f.db.reversalOps![0].status });
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(result).toMatchObject({ code: 'SFEE_REVERSAL_UNCERTAIN' });
  });

  it('control: valid transfer listing repairs an aged lost receipt without sending twice', async () => {
    const f = fixture();
    const row = await enqueue(f, 'coach_reinstate');
    f.stripe.transferResponsesLost = 1;
    f.stripe.failListTransfers = true;
    await f.svc.attempt(row.id);
    f.stripe.expireIdempotencyKeys();
    const wire = new ListingWire({ data: f.stripe.transfers, has_more: false });
    Object.defineProperty(f.stripe, 'listTransfers', {
      value: jest.fn((args: Parameters<StripeConnectApiService['listTransfers']>[0]) => wire.listTransfers(args)),
    });
    f.svc.clock = () => new Date(Date.now() + 25 * 3_600_000);
    expect((await f.svc.attempt(row.id)).status).toBe('succeeded');
    expect(wire.fetched).toHaveLength(1);
    expect(f.stripe.netTo('acct_probe')).toBe(1_000);
    expect(f.stripe.transfers).toHaveLength(1);
  });

  it('control: null/invalid-JSON transfer listing remains unknown rather than sending', async () => {
    const f = fixture();
    const row = await enqueue(f, 'coach_reinstate');
    f.stripe.transferResponsesLost = 1;
    f.stripe.failListTransfers = true;
    await f.svc.attempt(row.id);
    f.stripe.expireIdempotencyKeys();
    f.svc.clock = () => new Date(Date.now() + 25 * 3_600_000);
    const wire = new ListingWire(null);
    Object.defineProperty(f.stripe, 'listTransfers', {
      value: jest.fn((args: Parameters<StripeConnectApiService['listTransfers']>[0]) => wire.listTransfers(args)),
    });
    expect((await f.svc.attempt(row.id)).status).toBe('pending');
    expect(wire.fetched).toHaveLength(1);
    expect(f.stripe.netTo('acct_probe')).toBe(1_000);
  });
});
