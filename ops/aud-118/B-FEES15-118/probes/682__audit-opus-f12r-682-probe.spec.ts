// AUD-OPUS-F12R-116 lens probe (Claude Opus 5.5) on #682 @ a5d6a434. Never merge.
// Independent probes of the round-11 reversal send admission, the duplicate
// alert, closed diagnostics and the impersonal payout copy.
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChargeLockLostError } from '../src/connect/fees/charge-lock';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import {
  formatMoney,
  payoutNoticeCopy,
  type PayoutNoticeAmounts,
  type PayoutNoticeEvent,
  type PayoutNoticeRole,
} from '../src/connect/fees/payout-notice-copy';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import {
  TRANSFER_SEND_START_BUDGET_MS,
  TransferOrchestratorService,
} from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { asPrisma, FakeStripe, makeSettlementPrisma } from './utils/settlement-fakes';

const CANARY = 'OPUS_PROBE_CANARY payee@example.invalid "refund body"';

function fx() {
  const { db, prisma } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const svc = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc2 = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  return { db, prisma, stripe, svc, svc2 };
}
type Fx = ReturnType<typeof fx>;

async function postedTransfer(f: Fx, key = 'op-probe') {
  const row = await f.svc.enqueueSettlementTransfer({
    settlement_id: 'cs_p',
    purchase_id: 'p_p',
    kind: 'coach_net',
    ledger_entry_id: null,
    destination_stripe_account_id: 'acct_coach',
    destination_user_id: 'coach-p',
    amount_cents: 1_000,
    netted_recovery_cents: 0,
    currency: 'usd',
    source_stripe_charge_id: 'ch_p',
    idempotency_key: key,
  });
  return f.svc.attempt(row.id);
}

// A pending reversal op that nobody has driven yet (attempts 0).
async function undrivenOp(f: Fx, transferId: string, amount = 400) {
  const t = f.db.transfers.find((r) => r.id === transferId)!;
  t.reversal_seq = 1;
  return f.prisma.transferReversalOp.create({
    data: {
      transfer_id: transferId,
      seq: 1,
      idempotency_key: `tgp-tr-rev-${transferId}-op1`,
      amount_cents: amount,
      base_reversed_cents: 0,
      purpose: 'adjust',
      status: 'pending',
    },
  });
}

function gate() {
  let open!: () => void;
  let hit!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (hit = r));
  return { open, hit: () => hit(), reached, opened };
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

describe('PROBE R-W the 30 s start window', () => {
  // Advance the wall clock by `wallMs` and the monotonic clock by `monoMs`
  // between the claim and the HTTP boundary (inside reverseTransfer, before
  // the fake runs beforeSend).
  async function runWithGap(wallMs: number, monoMs: number) {
    const f = fx();
    const row = await postedTransfer(f);
    let wall = Date.now();
    let mono = 1_000_000;
    f.svc.clock = () => new Date(wall);
    const perf = jest.spyOn(performance, 'now').mockImplementation(() => mono);
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      wall += wallMs;
      mono += monoMs;
      return real(args);
    });
    const outcome = await f.svc
      .reverse({ transfer_row_id: row.id, amount_cents: 400 })
      .then((o) => o.status, (e: unknown) => (e as Error).constructor.name);
    return { f, row, outcome, perf };
  }

  it('W1: exactly at the budget (30,000 ms) the reversal starts', async () => {
    expect(TRANSFER_SEND_START_BUDGET_MS).toBe(30_000);
    const { f, row, outcome } = await runWithGap(30_000, 30_000);
    expect(outcome).toBe('succeeded');
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
  });

  it('W2: 1 ms past the budget nothing is sent; op pending attempts=1; SEND_ABANDONED logged', async () => {
    const { f, row, outcome } = await runWithGap(30_001, 30_001);
    expect(outcome).toBe('ReversalUncertainError');
    expect(f.stripe.reversals).toHaveLength(0);
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(0);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(all(warn).some((l) => l.startsWith('SFEE_REVERSAL_SEND_ABANDONED transfer='))).toBe(true);
  });

  it('W3: wall clock stepped back 1 h, monotonic +30,001 ms: still abandoned', async () => {
    const { f, outcome } = await runWithGap(-3_600_000, 30_001);
    expect(outcome).toBe('ReversalUncertainError');
    expect(f.stripe.reversals).toHaveLength(0);
  });

  it('W4: suspended machine (wall +31 s, monotonic +0): still abandoned', async () => {
    const { f, outcome } = await runWithGap(31_000, 0);
    expect(outcome).toBe('ReversalUncertainError');
    expect(f.stripe.reversals).toHaveLength(0);
  });

  it('W5: the budget counts from before the claim write (a 31 s claim write abandons)', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    let wall = Date.now();
    f.svc.clock = () => new Date(wall);
    const ops = f.prisma.transferReversalOp;
    const realUM = ops.updateMany.getMockImplementation()!;
    ops.updateMany.mockImplementation(async (args) => {
      const out = await realUM(args);
      if ((args.data as Record<string, unknown>).attempts !== undefined) wall += 31_000;
      return out;
    });
    await expect(f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 })).rejects.toBeInstanceOf(
      ReversalUncertainError,
    );
    expect(f.stripe.reverseTransfer).not.toHaveBeenCalled();
  });

  it('W6: after an abandoned claim the next driver lists Stripe first, then reverses exactly once', async () => {
    const { f, row, perf } = await runWithGap(30_001, 30_001);
    perf.mockRestore();
    f.svc.clock = () => new Date();
    const listsBefore = f.stripe.listTransferReversals.mock.calls.length;
    await f.svc.resolvePendingReversals(row.id);
    const listOrder = f.stripe.listTransferReversals.mock.invocationCallOrder.slice(listsBefore);
    const sendOrder = f.stripe.reverseTransfer.mock.invocationCallOrder;
    expect(listOrder.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...listOrder)).toBeLessThan(Math.max(...sendOrder));
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.transfers.find((t) => t.id === row.id)!.reversed_amount_cents).toBe(400);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });
});

describe('PROBE R-C the atomic claim', () => {
  it('C1: two unlocked drivers race one undriven op: one Stripe request, 400 reversed once', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    await undrivenOp(f, row.id);
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    f.stripe.reverseTransfer.mockImplementation(async (args) => {
      await new Promise((r) => setTimeout(r, 15));
      return real(args);
    });
    const res = await Promise.allSettled([
      f.svc.resolvePendingReversals(row.id),
      f.svc2.resolvePendingReversals(row.id),
    ]);
    expect(f.stripe.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'succeeded', attempts: 1 });
    const rejected = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    for (const r of rejected) expect(r.reason).toBeInstanceOf(ReversalUncertainError);
  });

  it('C2: a stale op snapshot (attempts 0) whose live row was claimed elsewhere sends nothing', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    const stale = await undrivenOp(f, row.id);
    // Another worker claimed it (attempts 1) and is still in flight.
    Object.assign(f.db.reversalOps![0], { attempts: 1, last_attempt_at: new Date() });
    const drive = (f.svc as unknown as { drive: (op: unknown) => Promise<unknown> }).drive.bind(
      f.svc,
    );
    // attempts 0 in the snapshot: no listing, straight to the claim CAS, which must lose.
    await expect(drive(stale)).rejects.toBeInstanceOf(ReversalUncertainError);
    expect(f.stripe.reverseTransfer).not.toHaveBeenCalled();
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('C3: lease lost right after the claim: ChargeLockLostError, nothing sent, next driver reverses once', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    const fence = async () => {
      if (f.db.reversalOps!.some((o) => o.attempts === 1)) {
        throw new ChargeLockLostError('ch_p', 'taken_over');
      }
    };
    await expect(
      f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400, fence }),
    ).rejects.toBeInstanceOf(ChargeLockLostError);
    expect(f.stripe.reverseTransfer).not.toHaveBeenCalled();
    expect(f.db.reversalOps![0]).toMatchObject({ status: 'pending', attempts: 1 });
    await f.svc.resolvePendingReversals(row.id);
    expect(f.stripe.listTransferReversals).toHaveBeenCalled();
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
  });
});

describe('PROBE R-D SFEE_REVERSAL_DUPLICATE', () => {
  it('D1: two completers with the SAME Stripe reversal (normal race) raise no duplicate alert', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    const g = gate();
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      const r = await real(args); // Stripe committed; the response is slow
      g.hit();
      await g.opened;
      return r;
    });
    const a = f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    await g.reached;
    await f.svc2.resolvePendingReversals(row.id); // lists, finds trr_1, completes
    g.open();
    await expect(a).resolves.toMatchObject({ status: 'succeeded' });
    expect(all(error).some((l) => l.startsWith('SFEE_REVERSAL_DUPLICATE'))).toBe(false);
    expect(f.db.transfers.find((t) => t.id === row.id)!.reversed_amount_cents).toBe(400);
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(400);
  });

  it('D2: books say refused while Stripe holds the reversal: alert names status=refused and recorded=none', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    const g = gate();
    const real = f.stripe.reverseTransfer.getMockImplementation()!;
    f.stripe.reverseTransfer.mockImplementationOnce(async (args) => {
      args.beforeSend?.(); // request started
      g.hit();
      await g.opened;
      return real({ ...args, beforeSend: undefined });
    });
    const a = f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400 });
    await g.reached;
    f.stripe.failReversals = true;
    await expect(f.svc2.resolvePendingReversals(row.id)).resolves.toBeUndefined();
    expect(f.db.reversalOps![0].status).toBe('refused');
    f.stripe.failReversals = false;
    g.open();
    await a;
    const dup = all(error).filter((l) => l.startsWith('SFEE_REVERSAL_DUPLICATE'));
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatch(
      /^SFEE_REVERSAL_DUPLICATE alert=true transfer=\S+ op=\S+ amount=400 status=refused recorded_stripe_reversal=none also_at_stripe=trr_1: /,
    );
  });

  it('D3 (documents C): two reversals for one op key already at Stripe, op still pending: completes silently', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    const op = await undrivenOp(f, row.id);
    Object.assign(f.db.reversalOps![0], { attempts: 1, last_attempt_at: new Date() });
    for (const id of ['trr_a', 'trr_b']) {
      f.stripe.reversals.push({
        id,
        transfer: row.stripe_transfer_id!,
        amount: 400,
        metadata: { tgp_reversal_op: op.idempotency_key },
      });
    }
    await f.svc.resolvePendingReversals(row.id);
    const dup = all(error).filter((l) => l.startsWith('SFEE_REVERSAL_DUPLICATE'));
    // eslint-disable-next-line no-console
    console.log(
      `D3 stripe=${f.stripe.reversedOn(row.stripe_transfer_id!)} books=${
        f.db.transfers.find((t) => t.id === row.id)!.reversed_amount_cents
      } duplicate_alerts=${dup.length}`,
    );
    expect(f.stripe.reversedOn(row.stripe_transfer_id!)).toBe(800);
  });
});

describe('PROBE R-L closed diagnostics on paths the builder spec does not cover', () => {
  const leak = (f: Fx, extra: unknown = null) => {
    const seen = JSON.stringify({ logs: [...all(warn), ...all(error)], db: f.db, extra });
    return seen.includes('OPUS_PROBE_CANARY') || seen.includes('example.invalid');
  };

  it('L1: unresolved send + listing failure at attempt start (holdUncertain at :467)', async () => {
    const f = fx();
    const row = await f.svc.enqueueSettlementTransfer({
      settlement_id: 'cs_l',
      purchase_id: 'p_l',
      kind: 'coach_net',
      ledger_entry_id: null,
      destination_stripe_account_id: 'acct_coach',
      destination_user_id: 'coach-l',
      amount_cents: 1_000,
      netted_recovery_cents: 0,
      currency: 'usd',
      source_stripe_charge_id: 'ch_l',
      idempotency_key: 'op-l1',
    });
    Object.assign(f.db.transfers[0], {
      attempts: 1,
      stripe_send_unresolved_at: new Date(Date.now() - 3_600_000),
      last_attempt_at: new Date(Date.now() - 3_600_000),
    });
    f.stripe.listTransfers.mockRejectedValueOnce(
      new StripeConnectApiError(CANARY, 500, CANARY, 'api_error'),
    );
    const out = await f.svc.attempt(row.id).catch((e: unknown) => ({ thrown: (e as Error).message }));
    expect(leak(f, out)).toBe(false);
  });

  it('L2: transfer refused, not final (retry) with a Prisma-shaped message', async () => {
    const f = fx();
    const r2 = await f.svc.enqueueSettlementTransfer({
      settlement_id: 'cs_l2',
      purchase_id: 'p_l2',
      kind: 'coach_net',
      ledger_entry_id: null,
      destination_stripe_account_id: 'acct_coach',
      destination_user_id: 'coach-l2',
      amount_cents: 500,
      netted_recovery_cents: 0,
      currency: 'usd',
      source_stripe_charge_id: 'ch_l2',
      idempotency_key: 'op-l2',
    });
    f.stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError(`Insufficient funds ${CANARY}`, 400, 'balance_insufficient', 'invalid_request_error'),
    );
    const out = await f.svc.attempt(r2.id);
    expect(leak(f, out)).toBe(false);
    expect(String(out.last_error)).toMatch(/^SFEE_TRANSFER_PLATFORM_BALANCE_INSUFFICIENT: kind=stripe http=400 type=invalid_request_error code=balance_insufficient$/);
  });

  it('L3: reversal refused then re-asked by key: outcome.error stays closed', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    f.stripe.reverseTransfer.mockRejectedValueOnce(
      new StripeConnectApiError(CANARY, 400, CANARY, CANARY),
    );
    const first = await f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400, idempotency_key: 'rf-1' });
    const again = await f.svc.reverse({ transfer_row_id: row.id, amount_cents: 400, idempotency_key: 'rf-1' });
    expect(first).toMatchObject({ status: 'refused' });
    expect(again).toMatchObject({ status: 'refused', error: 'kind=stripe http=400 type=other code=other' });
    expect(leak(f, [first, again])).toBe(false);
  });

  it('L4: reversal uncertain with a Prisma known-request error during listing: thrown message closed', async () => {
    const f = fx();
    const row = await postedTransfer(f);
    f.stripe.reverseTransfer.mockRejectedValueOnce(new Error(CANARY));
    f.stripe.listTransferReversals.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(CANARY, { code: 'P2010', clientVersion: 'x' }),
    );
    const thrown = await f.svc
      .reverse({ transfer_row_id: row.id, amount_cents: 400 })
      .then(() => null, (e: unknown) => e as Error);
    expect(thrown).toBeInstanceOf(ReversalUncertainError);
    expect(thrown!.message).not.toContain('OPUS_PROBE_CANARY');
    expect(leak(f, thrown!.message)).toBe(false);
  });
});

describe('PROBE R-P payout copy: impersonal, exact amounts, 160 limit', () => {
  const FIRST_PERSON = /\b(we|we'll|we've|we're|we'd|us|our|ours|ourselves|let's)\b/i;
  const amounts = (c: number, currency: string, over: Partial<PayoutNoticeAmounts> = {}) => ({
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
    ...over,
  });
  const events: PayoutNoticeEvent[] = ['refund', 'chargeback', 'dispute_won', 'dispute_lost'];
  const roles: PayoutNoticeRole[] = ['coach', 'head_coach'];

  it('P1: no first person, no "!", no emoji, <= 160, every shown amount complete, across a large grid', () => {
    const truncated: string[] = [];
    let checked = 0;
    for (const currency of ['usd', 'eur', 'jpy']) {
      for (const c of [1, 99, 100, 520, 9_480, 99_999, 999_999, 9_999_999]) {
        for (const zeroField of [null, 'reversed_cents', 'reinstated_cents', 'released_cents', 'held_open_cents']) {
          const a = amounts(c, currency, zeroField ? { [zeroField]: 0 } : {});
          for (const event of events) {
            for (const role of roles) {
              const { title, body } = payoutNoticeCopy(event, role, a);
              checked += 1;
              const text = `${title} ${body}`;
              expect(text).not.toMatch(FIRST_PERSON);
              expect(text).not.toMatch(/!/);
              expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
              expect(body.length).toBeLessThanOrEqual(160);
              if (body.endsWith('...')) {
                truncated.push(`${currency}:${c}:${zeroField ?? 'all'}:${event}:${role}`);
              } else {
                // Every amount the sentence names is the exact formatted amount.
                const shown = body.match(/(\$[\d,]+\.\d{2}|[\d,]+(\.\d{2})? [A-Z]{3})/g) ?? [];
                for (const s of shown) expect(s).toBe(formatMoney(c, currency));
              }
            }
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`P1 checked=${checked} truncated=${truncated.length} first=${truncated.slice(0, 6).join(' | ')}`);
    expect(checked).toBe(3 * 8 * 5 * 4 * 2);
    // USD up to $99,999.99 never truncates.
    expect(truncated.filter((t) => t.startsWith('usd:') && Number(t.split(':')[1]) <= 9_999_999)).toEqual([]);
  });

  it('P2: the exact r5 fixture sentences (builder table) and the head-coach variants', () => {
    const base: PayoutNoticeAmounts = {
      currency: 'usd',
      charge_gross_cents: 10_000,
      customer_refunded_cents: 10_000,
      reversed_cents: 9_480,
      reinstated_cents: 0,
      released_cents: 0,
      held_cents: 2_020,
      held_tgp_fee_cents: 200,
      held_stripe_fee_cents: 320,
      held_dispute_fee_cents: 1_500,
      held_not_reversed_cents: 0,
      held_open_cents: 2_020,
    };
    expect(payoutNoticeCopy('chargeback', 'coach', base).body).toBe(
      "A client's bank took back $100.00 in a dispute. $94.80 was taken back from that sale's payout. $20.20 is held from your next sale.",
    );
    expect(payoutNoticeCopy('refund', 'head_coach', { ...base, reversed_cents: 500, held_open_cents: 0 }).body).toBe(
      'A client got $100.00 back. $5.00 was taken back from your share of that sale. Nothing is held from your next sale.',
    );
    expect(
      payoutNoticeCopy('dispute_won', 'coach', { ...base, reinstated_cents: 7_980, released_cents: 2_020, held_open_cents: 0 }).body,
    ).toBe(
      'You won the dispute on a $100.00 charge. $79.80 was paid back to you and the $20.20 hold was released. Nothing is held from your next sale.',
    );
    expect(payoutNoticeCopy('dispute_lost', 'coach', base).body).toBe(
      'The bank decided the dispute on a $100.00 charge for the client. $20.20 is still held from your next sale.',
    );
  });
});
