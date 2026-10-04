// AUD-OPUS-F12-117 lens probe (Claude Opus 5.5, agent 117) on #682 @ a5d6a434. Never merge.
// Extra cases beyond the AUD-OPUS-F12R-116 probe: a 409 idempotency_key_in_use
// re-send while the first request is still in flight, an abandoned claim
// followed by a failed listing, the send_abandoned cause text, and where the
// 160-character body cut lands for every supported currency up to Stripe's
// maximum charge.
import { Logger } from '@nestjs/common';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import {
  formatMoney,
  NOTICE_BODY_MAX,
  payoutNoticeCopy,
  type PayoutNoticeAmounts,
  type PayoutNoticeEvent,
  type PayoutNoticeRole,
} from '../src/connect/fees/payout-notice-copy';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { asPrisma, FakeStripe, makeSettlementPrisma } from './utils/settlement-fakes';

const CANARY = 'OPUS117_CANARY payee@example.invalid';

function fx() {
  const { db, prisma } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc2 = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  return { db, prisma, stripe, svc, svc2 };
}
type Fx = ReturnType<typeof fx>;

async function postedTransfer(f: Fx, key = 'op-117') {
  const row = await f.svc.enqueueSettlementTransfer({
    settlement_id: 'cs_117',
    purchase_id: 'p_117',
    kind: 'coach_net',
    ledger_entry_id: null,
    destination_stripe_account_id: 'acct_coach',
    destination_user_id: 'coach-117',
    amount_cents: 1_000,
    netted_recovery_cents: 0,
    currency: 'usd',
    source_stripe_charge_id: 'ch_117',
    idempotency_key: key,
  });
  return f.svc.attempt(row.id);
}

function gate() {
  let open!: () => void;
  let hit!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (hit = r));
  return { open: () => open(), hit: () => hit(), reached, opened };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
const all = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

describe('PROBE X-R reversal send admission, extra cases', () => {
  it('X1: a re-send answered 409 idempotency_key_in_use while the first request is in flight is never a refusal; 400 reversed once', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    const g = gate();
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    // Worker A: request started, Stripe still processing it.
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      args.beforeSend?.();
      g.hit();
      await g.opened;
      return real({ ...args, beforeSend: undefined });
    });
    // Worker B: Stripe answers 409 for the same key while A's request runs.
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      args.beforeSend?.();
      throw new StripeConnectApiError(CANARY, 409, 'idempotency_key_in_use', 'idempotency_error');
    });
    const a = f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    await g.reached;
    const b = await f.svc2.resolvePendingReversals(row.id).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(b).toBeInstanceOf(ReversalUncertainError);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 2 });
    g.open();
    await expect(a).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'succeeded', stripe_reversal_id: 'trr_1' });
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers.find((t) => t.id === row.id)!.reversed_amount_cents).toBe(400);
    expect(all(warn).some((l) => l.startsWith('SFEE_REVERSAL_REFUSED'))).toBe(false);
    expect(all(error).some((l) => l.startsWith('SFEE_REVERSAL_DUPLICATE'))).toBe(false);
    const seen = JSON.stringify({ logs: [...all(warn), ...all(error)], db: f.db, b: (b as Error).message });
    expect(seen).not.toContain('OPUS117_CANARY');
  });

  it('X2: an abandoned claim, then a driver whose listing fails: nothing sent, op pending, closed reason', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    let wall = Date.now();
    f.svc.clock = () => new Date(wall);
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      wall += 30_001;
      return real(args);
    });
    await expect(f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 })).rejects.toBeInstanceOf(
      ReversalUncertainError,
    );
    expect(f.stripe.reversals).toHaveLength(0);
    f.stripe.failListReversals = true;
    const sendsBefore = f.stripe.reverseTransfer.mock.calls.length;
    const second = await f.svc2.resolvePendingReversals(row.id).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(second).toBeInstanceOf(ReversalUncertainError);
    expect(f.stripe.reverseTransfer.mock.calls.length).toBe(sendsBefore);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(String(f.db.reversalOps![0].last_error)).toBe(
      'reversal lookup unavailable: listing failed: kind=stripe http=500 type=api_error code=none',
    );
    f.stripe.failListReversals = false;
    await f.svc2.resolvePendingReversals(row.id);
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('X3 (documents C): the send_abandoned cause text in ReversalUncertainError', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    let wall = Date.now();
    f.svc.clock = () => new Date(wall);
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      wall += 30_001;
      return real(args);
    });
    const err = await f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    // eslint-disable-next-line no-console
    console.log(`X3 message=${err?.message}`);
    expect(err).toBeInstanceOf(ReversalUncertainError);
    expect(err!.message).toContain('send_abandoned');
  });
});

describe('PROBE X-P where the 160-character cut lands', () => {
  const events: PayoutNoticeEvent[] = ['refund', 'chargeback', 'dispute_won', 'dispute_lost'];
  const roles: PayoutNoticeRole[] = ['coach', 'head_coach'];
  const shape = (c: number, currency: string): PayoutNoticeAmounts => ({
    currency,
    charge_gross_cents: c,
    customer_refunded_cents: c,
    reversed_cents: c,
    reinstated_cents: c,
    released_cents: c,
    held_cents: c,
    held_tgp_fee_cents: 0,
    held_stripe_fee_cents: 0,
    held_dispute_fee_cents: 0,
    held_not_reversed_cents: 0,
    held_open_cents: c,
  });

  it('X4: every supported currency up to Stripe max (99,999,999 minor units): amounts never cut; truncations listed', () => {
    const truncated: string[] = [];
    const amountCut: string[] = [];
    for (const currency of ['usd', 'eur', 'gbp', 'aud', 'cad']) {
      for (const c of [1_999, 99_999, 999_999, 9_999_999, 99_999_999]) {
        for (const event of events) {
          for (const role of roles) {
            const a = shape(c, currency);
            const { body } = payoutNoticeCopy(event, role, a);
            expect(body.length).toBeLessThanOrEqual(NOTICE_BODY_MAX);
            if (!body.endsWith('...')) continue;
            truncated.push(`${currency}:${c}:${event}:${role}=${body.slice(-40)}`);
            const amount = formatMoney(c, currency);
            const head = body.slice(0, -3);
            // An amount is cut when a prefix of it (not the whole) ends the kept text.
            for (let k = 1; k < amount.length; k += 1) {
              if (head.endsWith(amount.slice(0, k))) amountCut.push(`${currency}:${c}:${event}:${role}`);
            }
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`X4 truncated=${truncated.length} amount_cut=${amountCut.length}\n${truncated.join('\n')}`);
    expect(truncated.filter((t) => t.startsWith('usd:'))).toEqual([]);
    expect(amountCut).toEqual([]);
  });
});
