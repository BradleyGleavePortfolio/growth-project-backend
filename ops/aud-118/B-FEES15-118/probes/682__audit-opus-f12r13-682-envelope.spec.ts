// AUD-OPUS-F12R13-117 lens probe (Claude Opus 5.5, agent 117) on #682 @ be26e289. Never merge.
// Independent check of the list-envelope edge (GPT-6.1 Sol B-682-4 at this head):
// findStripeTransfer / findStripeReversal (transfer-orchestrator.service.ts:939-942,
// 1240-1243) read `res.data ?? []` and `if (!res.has_more) return 'absent'`, so a
// successful list body that lacks `has_more` or `data` is taken as a COMPLETE list
// that proves absence. After Stripe's 24 h key window, absence is the only barrier
// against a second send. Controls: a valid listing and an explicit has_more=true.
import { Logger } from '@nestjs/common';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { asPrisma, FakeStripe, makeSettlementPrisma } from './utils/settlement-fakes';

const DAY_PLUS = 25 * 3600 * 1000;

function fx() {
  const { db, prisma } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const later = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  return { db, prisma, stripe, svc, later };
}
type Fx = ReturnType<typeof fx>;

async function enqueue(f: Fx, key = 'op-env') {
  return f.svc.enqueueSettlementTransfer({
    settlement_id: 'cs_env',
    purchase_id: 'p_env',
    kind: 'coach_net',
    ledger_entry_id: null,
    destination_stripe_account_id: 'acct_coach',
    destination_user_id: 'coach-env',
    amount_cents: 1_000,
    netted_recovery_cents: 0,
    currency: 'usd',
    source_stripe_charge_id: 'ch_env',
    idempotency_key: key,
  });
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

/** A 400-cent reversal executed at Stripe whose response was lost while listing was down. */
async function lostReversal(f: Fx) {
  const queued = await enqueue(f);
  const row = await f.svc.attempt(queued.id);
  expect(row.status).toBe('succeeded');
  f.stripe.reversalResponsesLost = 1;
  f.stripe.failListReversals = true;
  await expect(f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 })).rejects.toBeInstanceOf(
    ReversalUncertainError,
  );
  expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
  expect(f.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
  // Listing is back; Stripe's 24 h idempotency window has passed.
  f.stripe.failListReversals = false;
  f.stripe.expireIdempotencyKeys();
  const now = Date.now() + DAY_PLUS;
  f.later.clock = () => new Date(now);
  return row;
}

describe('PROBE ENV reversal lookup: list envelope validation', () => {
  it.each([
    ['data without has_more', { data: [] }],
    ['has_more false without data', { has_more: false }],
    ['empty object', {}],
  ])('ENV-R %s: taken as a complete list, a second 400 is reversed at Stripe, books say 400', async (_n, body) => {
    const f = fx();
    const row = await lostReversal(f);
    f.stripe.listTransferReversals.mockImplementationOnce(async () => body as never);
    const res = await f.later.resolvePendingReversals(row.id).then(
      () => 'resolved',
      (e: unknown) => (e as Error).constructor.name,
    );
    const stripeTotal = f.stripe.reversedOn(row.stripe_transfer_id!);
    const books = f.db.transfers.find((t) => t.id === row.id)!.reversed_amount_cents;
    // eslint-disable-next-line no-console
    console.log(`ENV-R ${_n}: result=${res} stripe_reversed=${stripeTotal} books_reversed=${books} op=${f.db.reversalOps![0].status}`);
    expect({ stripeTotal, books }).toEqual({ stripeTotal: 800, books: 400 });
  });

  it('ENV-R control: has_more true with an empty page is unknown: nothing sent', async () => {
    const f = fx();
    const row = await lostReversal(f);
    f.stripe.listTransferReversals.mockImplementationOnce(async () => ({ data: [], has_more: true }) as never);
    await expect(f.later.resolvePendingReversals(row.id)).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
  });

  it('ENV-R control: a valid listing finds the lost reversal: nothing sent, books 400', async () => {
    const f = fx();
    const row = await lostReversal(f);
    await f.later.resolvePendingReversals(row.id);
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'succeeded', stripe_reversal_id: 'trr_1' });
  });
});

/** A 1,000-cent transfer executed at Stripe whose response was lost while listing was down. */
async function lostTransfer(f: Fx) {
  const queued = await enqueue(f);
  f.stripe.transferResponsesLost = 1;
  f.stripe.failListTransfers = true;
  const held = await f.svc.attempt(queued.id);
  expect(held.status).not.toBe('succeeded');
  expect(f.stripe.transfers).toHaveLength(1);
  f.stripe.failListTransfers = false;
  f.stripe.expireIdempotencyKeys();
  const now = Date.now() + DAY_PLUS;
  f.later.clock = () => new Date(now);
  return queued;
}

describe('PROBE ENV transfer lookup: list envelope validation', () => {
  it.each([
    ['has_more false without data', { has_more: false }],
    ['data without has_more', { data: [] }],
  ])('ENV-T %s: taken as a complete list, a second 1,000 transfer is sent', async (_n, body) => {
    const f = fx();
    const queued = await lostTransfer(f);
    f.stripe.listTransfers.mockImplementationOnce(async () => body as never);
    const after = await f.later.attempt(queued.id);
    const stripeTotal = f.stripe.transfers.reduce((n, t) => n + t.amount, 0);
    // eslint-disable-next-line no-console
    console.log(`ENV-T ${_n}: row=${after.status} stripe_transfers=${f.stripe.transfers.length} stripe_total=${stripeTotal} books=${after.amount_cents}`);
    expect({ count: f.stripe.transfers.length, stripeTotal, status: after.status }).toEqual({
      count: 2,
      stripeTotal: 2_000,
      status: 'succeeded',
    });
  });

  it('ENV-T control: a valid listing finds the lost transfer: reconciled, one transfer', async () => {
    const f = fx();
    const queued = await lostTransfer(f);
    const after = await f.later.attempt(queued.id);
    expect(after).toMatchObject({ status: 'succeeded', stripe_transfer_id: 'tr_1' });
    expect(f.stripe.transfers).toHaveLength(1);
  });
});
