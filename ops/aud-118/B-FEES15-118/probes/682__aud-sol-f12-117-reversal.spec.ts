import { Logger } from '@nestjs/common';
import { ChargeLock, ChargeLockLostError, CHARGE_LOCK_TTL_MS } from '../src/connect/fees/charge-lock';
import { payoutNoticeCopy, type PayoutNoticeAmounts } from '../src/connect/fees/payout-notice-copy';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { parkFailureKind, TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { asPrisma, FakeStripe, makeSettlementPrisma } from './utils/settlement-fakes';

function fixture() {
  const { db, prisma } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, new SplitLedgerService(asPrisma(prisma)));
  return { db, prisma, stripe, svc };
}

async function pending(f: ReturnType<typeof fixture>) {
  return f.svc.enqueueSettlementTransfer({
    settlement_id: 'cs_1', purchase_id: 'p1', kind: 'coach_net',
    ledger_entry_id: null, destination_stripe_account_id: 'acct_coach',
    destination_user_id: 'coach', amount_cents: 1_000, netted_recovery_cents: 0,
    currency: 'usd', source_stripe_charge_id: 'ch1', idempotency_key: 'op1',
  });
}

describe('AUD-SOL-F12-117 F2 independently refreshed boundaries', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a paused reversal sender cannot debit the payee again after takeover and key expiry', async () => {
    const f = fixture();
    const row = await pending(f);
    const paid = await f.svc.attempt(row.id);
    let now = Date.now();
    const firstLock = new ChargeLock(asPrisma(f.prisma), { now: () => new Date(now), waitMs: 0 });
    const secondLock = new ChargeLock(asPrisma(f.prisma), { now: () => new Date(now), waitMs: 0 });
    let unblock: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const originalUpdate = f.prisma.transferReversalOp.updateMany.getMockImplementation()!;
    f.prisma.transferReversalOp.updateMany.mockImplementationOnce(async (args) => {
      const result = await originalUpdate(args);
      reached(); // Durable attempt increment committed; sender is paused before HTTP.
      await gate;
      return result;
    });
    const stale = firstLock.run('ch1', () => f.svc.reverse({
      transfer_row_id: paid.id, amount_cents: 400,
      fence: (tx) => firstLock.fence('ch1', tx ?? asPrisma(f.prisma)),
    }));
    await started;
    now += CHARGE_LOCK_TTL_MS + 1;
    await secondLock.run('ch1', () => f.svc.resolvePendingReversals(
      paid.id, (tx) => secondLock.fence('ch1', tx ?? asPrisma(f.prisma)),
    ));
    expect(f.stripe.reversedOn(paid.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers[0].reversed_amount_cents).toBe(400);
    now += 25 * 3_600_000;
    f.stripe.expireIdempotencyKeys();
    unblock();
    await expect(stale).rejects.toBeInstanceOf(ChargeLockLostError);
    expect(f.stripe.reversedOn(paid.stripe_transfer_id!)).toBe(400);
  });

  it('a stale snapshot returned by the final op re-read cannot send after takeover and key expiry', async () => {
    const f = fixture();
    const paid = await f.svc.attempt((await pending(f)).id);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readStarted = new Promise<void>((resolve) => { reached = resolve; });
    const read = f.prisma.transferReversalOp.findUnique.getMockImplementation()!;
    f.prisma.transferReversalOp.findUnique.mockImplementationOnce(async (args) => {
      const oldSnapshot = await read(args);
      reached();
      await gate;
      return oldSnapshot;
    });
    const stale = f.svc.reverse({ transfer_row_id: paid.id, amount_cents: 400 });
    await readStarted;
    await f.svc.resolvePendingReversals(paid.id);
    f.stripe.expireIdempotencyKeys();
    const future = new Date(Date.now() + 25 * 3_600_000);
    f.svc.clock = () => future;
    release();
    await expect(stale).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.stripe.reversedOn(paid.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers[0].reversed_amount_cents).toBe(400);
    expect(f.stripe.reverseTransfer).toHaveBeenCalledTimes(1);
  });

  it('an aged pending reversal with unavailable or incomplete listing is never resent', async () => {
    const f = fixture();
    const paid = await f.svc.attempt((await pending(f)).id);
    f.stripe.reversalNetworkFailures = 1;
    await expect(f.svc.reverse({
      transfer_row_id: paid.id, amount_cents: 400,
    })).rejects.toMatchObject({ code: 'SFEE_REVERSAL_UNCERTAIN' });
    f.stripe.expireIdempotencyKeys();
    f.stripe.failListReversals = true;
    await expect(f.svc.resolvePendingReversals(paid.id))
      .rejects.toMatchObject({ code: 'SFEE_REVERSAL_UNCERTAIN' });
    f.stripe.failListReversals = false;
    f.stripe.reversalListAlwaysHasMore = true;
    await expect(f.svc.resolvePendingReversals(paid.id))
      .rejects.toMatchObject({ code: 'SFEE_REVERSAL_UNCERTAIN' });
    expect(f.stripe.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(f.stripe.reversedOn(paid.stripe_transfer_id!)).toBe(0);
    expect(f.db.reversalOps![0].status).toBe('pending');
    f.stripe.reversalListAlwaysHasMore = false;
    await f.svc.resolvePendingReversals(paid.id);
    expect(f.stripe.reversedOn(paid.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers[0].reversed_amount_cents).toBe(400);
  });

  it.each(['definitive', 'uncertain', 'listing', 'receipt'] as const)(
    '%s failures never emit unrestricted error messages',
    async (path) => {
      const f = fixture();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const canary = `AUDIT_PERSONAL_MESSAGE_${path}`;
      const row = await pending(f);
      if (path === 'definitive') {
        f.stripe.createTransfer.mockRejectedValueOnce(new StripeConnectApiError(
          canary, 400, 'balance_insufficient', 'invalid_request_error',
        ));
      } else if (path === 'uncertain') {
        f.stripe.createTransfer.mockRejectedValueOnce(new Error(canary));
      } else if (path === 'listing') {
        f.db.transfers[0].stripe_send_unresolved_at = new Date(0);
        f.db.transfers[0].attempts = 1;
        f.stripe.listTransfers.mockRejectedValueOnce(new Error(canary));
      } else {
        f.prisma.$transaction.mockRejectedValueOnce(new Error(canary));
      }
      await f.svc.attempt(row.id);
      expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(canary);
    },
  );

  it('B-627-10 closure control: park vocabulary ignores custom name, code and message', () => {
    const custom = Object.assign(new Error('AUDIT_MESSAGE'), {
      name: 'AUDIT_NAME', code: 'AUDIT_CODE',
    });
    expect(parkFailureKind(custom)).toBe('unknown');
  });

  it('B-627-10 closure control: fence loss and a failed park still send nothing and log only the closed kind', async () => {
    const f = fixture();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const row = await pending(f);
    const lost = new Error('fixed fence loss');
    const canary = 'AUDIT_PARK_NAME_MESSAGE_CODE';
    let calls = 0;
    const fence = async () => {
      if (++calls === 2) {
        f.prisma.connectTransfer.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
        f.prisma.connectTransfer.findUniqueOrThrow.mockRejectedValueOnce(Object.assign(
          new Error(canary), { name: canary, code: canary },
        ));
        throw lost;
      }
    };
    await expect(f.svc.attempt(row.id, { beforeStripe: fence })).rejects.toBe(lost);
    expect(f.stripe.createTransfer).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(warn.mock.calls)).toContain('park_error=unknown');
  });

  it('copy control: every rendered payout notice is impersonal', () => {
    const amounts: PayoutNoticeAmounts = {
      currency: 'usd', charge_gross_cents: 10_000, customer_refunded_cents: 10_000,
      reversed_cents: 9_480, reinstated_cents: 500, released_cents: 500,
      held_cents: 520, held_tgp_fee_cents: 200, held_stripe_fee_cents: 320,
      held_dispute_fee_cents: 0, held_not_reversed_cents: 0, held_open_cents: 520,
    };
    for (const event of ['refund', 'chargeback', 'dispute_won', 'dispute_lost'] as const) {
      expect(payoutNoticeCopy(event, 'coach', amounts).body).not.toMatch(/\b(?:we|our)\b/i);
    }
  });
});
