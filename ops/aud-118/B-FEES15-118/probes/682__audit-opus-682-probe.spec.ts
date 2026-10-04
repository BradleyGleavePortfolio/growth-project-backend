// AUDIT PROBE (AUD-OPUS-F12-116, never merge). Exact F2 head 007d3dcb plus
// this spec only. Each `it` asserts the CORRECT behaviour; a failure here is
// the defect evidence. Real TransferOrchestratorService and SplitLedgerService
// against the repo's settlement fakes; no DB, no network.
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { payoutNoticeCopy, type PayoutNoticeAmounts } from '../src/connect/fees/payout-notice-copy';
import { FakeStripe, asPrisma, makeSettlementPrisma } from './utils/settlement-fakes';

function seedPaidTransfer() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  stripe.transfers.push({
    id: 'tr_1',
    amount: 1000,
    currency: 'usd',
    destination: 'acct_coach',
    source_transaction: 'ch_1',
    metadata: {},
  } as never);
  db.transfers.push({
    id: 'ctr_1',
    purchase_id: 'p1',
    settlement_id: 'cs_1',
    kind: 'coach_net',
    ledger_entry_id: null,
    destination_stripe_account_id: 'acct_coach',
    destination_user_id: 'coach-1',
    amount_cents: 1000,
    netted_recovery_cents: 0,
    currency: 'usd',
    source_stripe_charge_id: 'ch_1',
    idempotency_key: 'tgp-settle-ch_1-coach',
    status: 'succeeded',
    stripe_transfer_id: 'tr_1',
    reversed_amount_cents: 0,
    reversal_seq: 0,
    attempts: 1,
    max_attempts: 6,
    stripe_send_unresolved_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  return { prisma, db, stripe, svc };
}

describe('AUDIT Opus 682 probe: reversal send continuation after takeover', () => {
  it('a reversal sender paused after its attempt write never reverses again after takeover and key expiry', async () => {
    const { prisma, db, stripe, svc } = seedPaidTransfer();
    // Worker A pauses right after its attempts write commits, before HTTP.
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const atGate = new Promise<void>((r) => (reached = r));
    const realUpdate = prisma.transferReversalOp.update;
    let paused = false;
    prisma.transferReversalOp.update = jest.fn(async (args: never) => {
      const out = await realUpdate(args);
      if (!paused) {
        paused = true;
        reached();
        await gate;
      }
      return out;
    }) as never;
    const fenceA = jest.fn(async () => undefined); // A held the charge lock at its fence
    const a = svc.reverse({ transfer_row_id: 'ctr_1', amount_cents: 400, fence: fenceA });
    await atGate;

    // Lease expired; worker B holds the lock now and re-drives the same op.
    const fenceB = jest.fn(async () => undefined);
    await svc.resolvePendingReversals('ctr_1', fenceB);
    expect(db.reversalOps![0].status).toBe('succeeded');
    expect(stripe.reversedOn('tr_1')).toBe(400);

    // More than 24 h later Stripe has pruned the key; A resumes.
    stripe.expireIdempotencyKeys();
    release();
    await a.catch(() => undefined);

    // Control: the books record one 400-cent reversal.
    expect(db.transfers[0].reversed_amount_cents).toBe(400);
    // Acceptance: Stripe also holds exactly 400 reversed (one reversal).
    expect(stripe.reversals.length).toBe(1);
    expect(stripe.reversedOn('tr_1')).toBe(400);
  });

  it('control: an ordinary reversal still reverses once', async () => {
    const { db, stripe, svc } = seedPaidTransfer();
    await svc.reverse({ transfer_row_id: 'ctr_1', amount_cents: 400 });
    expect(stripe.reversedOn('tr_1')).toBe(400);
    expect(db.transfers[0].reversed_amount_cents).toBe(400);
  });
});

describe('AUDIT Opus 682 probe: payout notice voice', () => {
  const amounts: PayoutNoticeAmounts = {
    currency: 'usd',
    charge_gross_cents: 10_000,
    customer_refunded_cents: 10_000,
    reversed_cents: 9_480,
    reinstated_cents: 9_480,
    released_cents: 520,
    held_cents: 520,
    held_tgp_fee_cents: 200,
    held_stripe_fee_cents: 320,
    held_dispute_fee_cents: 0,
    held_not_reversed_cents: 0,
    held_open_cents: 520,
  };
  for (const event of ['refund', 'chargeback', 'dispute_won', 'dispute_lost'] as const) {
    for (const role of ['coach', 'head_coach'] as const) {
      it(`${event} / ${role}: no first person, no exclamation mark`, () => {
        const { title, body } = payoutNoticeCopy(event, role, amounts);
        expect(`${title} ${body}`).not.toMatch(/\b(we|we'll|we've|us|our|ours)\b/i);
        expect(`${title} ${body}`).not.toMatch(/!/);
      });
    }
  }
});
