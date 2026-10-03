// S-FEE round 9 — audit finding at cd332bfa (Sol comment 5964932906):
//   B-627-9 (narrowed)  a sender paused after its claim committed and before
//            its Stripe call could start the create after another worker had
//            taken over: the five-minute marker age is not a bound on a paused
//            process. The new holder read Stripe's (truthful) empty listing,
//            found the attempt budget spent and marked the row failed with a
//            repay alert; the paused sender then resumed and moved the money.
//            Fix: (1) an unresolved create proven absent after the in-flight
//            window is never failed: at the budget it is ADOPTED (the same
//            attempt is re-sent under the same Stripe idempotency key), so its
//            result is Stripe's answer for that key; (2) after the claim
//            commits the sender re-proves the charge lease and its claim
//            (attempts + marker), and at the HTTP boundary (synchronously,
//            right before fetch) that the claim is younger than its 30 s start
//            budget; otherwise it sends nothing and parks the claim.
// The first test is Sol's probe (both workers through
// ChargeSettlementService.attemptTransferUnderLock with the real charge lease,
// fence, orchestrator and ledger; the claim commits and A's continuation is
// held before any Stripe call; clocks pass the in-flight window and the lease
// TTL; B takes over). Every test here except the one marked (control) fails
// on cd332bfa. No live Stripe or DB.
// This file imports only symbols that exist at cd332bfa, so the failing-before
// run fails on assertions, not on compilation.
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { Prisma, type ClientPurchase } from '@prisma/client';
import { ChargeLockLostError } from '../src/connect/fees/charge-lock';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import {
  FakeStripe,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const COACH = 'coach-1';
const HOUR = 3_600_000;
const MINUTE = 60_000;
// Round 9 constants, as literals so this file compiles at cd332bfa.
const SEND_START_BUDGET_MS = 30_000;

let errorLog: jest.SpyInstance;
let warnLog: jest.SpyInstance;
beforeEach(() => {
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const lines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map((c) => String(c[0]));
const repayAlerts = () => lines(errorLog).filter((l) => /^SFEE_TRANSFER_FAILED alert=true/.test(l));
const recoveredAlerts = () =>
  lines(errorLog).filter((l) => /^SFEE_TRANSFER_RECOVERED alert=true/.test(l));
const duplicateAlerts = () =>
  lines(errorLog).filter((l) => /^SFEE_TRANSFER_DUPLICATE alert=true/.test(l));

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  const purchase = {
    id: 'purchase-1',
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'package-1',
    amount_cents: 10_000,
    currency: 'usd',
    billing_type: 'one_time',
    status: 'paid',
    entitlement_active: true,
    stripe_payment_intent_id: 'pi_ch_1',
    source: null,
    created_at: new Date(),
  } as Row as ClientPurchase;
  db.purchases.push(purchase as Row);
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 10_000, fee: 320 }));
  // $100 sale, $3.20 fee, a full dispute ($15 fee), then the dispute is won:
  // the coach's $94.80 is reinstated by a transfer with no source charge. The
  // first reinstatement send fails before it reaches Stripe (marker set).
  const sellDisputeWin = async () => {
    await svc.settleCharge({ purchase, charge_id: 'ch_1' });
    await svc.applyAdjustments({
      purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 10_000, fee_cents: 1_500 },
    });
    stripe.transferNetworkFailures = 1;
    await svc.applyAdjustments({
      purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 0, fee_cents: 0 },
    });
  };
  // A reinstatement carries no ledger slice (ledger_entry_id null): its
  // money record is the transfer row and the settlement position.
  const row = () => db.transfers.find((t) => t.kind === 'coach_reinstate')!;
  const reinstatements = () =>
    stripe.transfers.filter((t) => !t.source_transaction && /reinstate/.test(t.metadata.tgp_kind));
  const at = (ms: number) => {
    const d = new Date(Date.now() + ms);
    transfers.clock = () => d;
    return d;
  };
  // The charge's money lease outlives nobody: a holder paused past its TTL
  // loses it to the next worker (models CHARGE_LOCK_TTL_MS elapsing).
  const expireChargeLease = () => {
    const lease = (db.leases ?? []).find((l) => l.name === 'sfee-charge:ch_1');
    expect(lease).toBeDefined();
    lease!.lease_until = new Date(0);
  };
  // Hold worker A's continuation right after its send claim commits (before
  // any Stripe call). The claim is the write that sets attempts + marker.
  const pauseAfterClaim = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let claimed!: () => void;
    const isClaimed = new Promise<void>((r) => (claimed = r));
    const real = prisma.connectTransfer.updateMany.getMockImplementation()!;
    let held = false;
    prisma.connectTransfer.updateMany.mockImplementation(async (args) => {
      const out = await real(args);
      const isClaim =
        args.data.stripe_send_unresolved_at instanceof Date && 'attempts' in args.data;
      if (!held && isClaim && out.count === 1) {
        held = true;
        claimed();
        await gate;
      }
      return out;
    });
    return { release, isClaimed };
  };
  // Hold worker A inside createTransfer. 'before-check': before the HTTP
  // boundary check (the request has not started); 'in-transit': after the
  // boundary check passed, the request is on the wire and reaches Stripe only
  // when released.
  const pauseInCreate = (where: 'before-check' | 'in-transit') => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCreate = new Promise<void>((r) => (entered = r));
    const real = stripe.createTransfer.getMockImplementation()!;
    stripe.createTransfer.mockImplementationOnce(async (args) => {
      if (where === 'in-transit') {
        if (args.beforeSend) args.beforeSend();
        entered();
        await gate;
        return real({ ...args, beforeSend: undefined });
      }
      entered();
      await gate;
      return real(args);
    });
    return { release, inCreate };
  };
  return {
    prisma,
    db,
    stripe,
    transfers,
    svc,
    sellDisputeWin,
    row,
    reinstatements,
    at,
    expireChargeLease,
    pauseAfterClaim,
    pauseInCreate,
  };
}

// The fields attemptTransferUnderLock reads to find the charge it locks.
const lockRef = (
  r: Row,
): { id: string; source_stripe_charge_id: string | null; settlement_id: string | null } => ({
  id: String(r.id),
  source_stripe_charge_id: r.source_stripe_charge_id ?? null,
  settlement_id: r.settlement_id ?? null,
});

// Starting point: the first reinstatement send never reached Stripe (marker
// set), the row is aged past the in-flight window and its keys are pruned,
// and `left` sends remain in the attempt budget.
async function agedRow(left: number) {
  const c = setup();
  await c.sellDisputeWin();
  const r = c.row();
  expect(r.status).toBe('pending');
  expect(r.stripe_send_unresolved_at).toBeInstanceOf(Date);
  expect(c.reinstatements()).toHaveLength(0);
  r.attempts = r.max_attempts - left;
  c.stripe.expireIdempotencyKeys();
  const t0 = c.at(25 * HOUR);
  return { c, r, t0 };
}

describe('B-627-9 narrowed: a sender paused after its claim never pays after a takeover', () => {
  it("Sol's probe: A claims the final send and pauses; B takes over after the window and the lease TTL; one payout, no repay alert", async () => {
    const { c, r, t0 } = await agedRow(1);
    const p = c.pauseAfterClaim();
    const a = c.svc.attemptTransferUnderLock(lockRef(r)); // A: claims attempt 6/6, then pauses
    await p.isClaimed;
    expect(c.row().attempts).toBe(r.max_attempts);
    // Past the in-flight window and the charge lease TTL.
    c.at(25 * HOUR + 6 * MINUTE);
    c.expireChargeLease();
    const b = await c.svc.attemptTransferUnderLock(lockRef(r)); // B: new holder, empty listing

    // Before A resumes: no failure and no repay instruction escaped.
    expect(repayAlerts()).toHaveLength(0);
    expect(c.row().status).not.toBe('failed');
    // B adopted the unresolved attempt under the same key and paid it once.
    expect(b.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    expect(
      lines(warnLog).some((l) =>
        /^SFEE_TRANSFER_ADOPTED transfer=.* attempt=6\/6 .*re-sent under the same key/.test(l),
      ),
    ).toBe(true);
    const callsBeforeResume = c.stripe.createTransfer.mock.calls.length;

    p.release();
    await a;

    // A started no Stripe request after its lease and claim were taken over.
    expect(c.stripe.createTransfer.mock.calls.length).toBe(callsBeforeResume);
    expect(c.reinstatements()).toHaveLength(1);
    expect(c.reinstatements()[0].amount).toBe(9_480);
    expect(c.stripe.netTo('acct_coach')).toBe(9_480);
    const fresh = c.row();
    expect(fresh.status).toBe('succeeded');
    expect(fresh.stripe_transfer_id).toBe(c.reinstatements()[0].id);
    expect(fresh.stripe_send_unresolved_at).toBeNull();
    expect(repayAlerts()).toHaveLength(0);
    expect(recoveredAlerts()).toHaveLength(0);
    expect(duplicateAlerts()).toHaveLength(0);
    expect(lines(warnLog).some((l) => /^SFEE_TRANSFER_SEND_ABANDONED transfer=/.test(l))).toBe(
      true,
    );
    expect(fresh.posted_at.getTime()).toBeGreaterThan(t0.getTime());
  });

  it('budget left: B re-sends and pays; A resumes after the key expired and sends nothing (no second transfer)', async () => {
    const { c, r } = await agedRow(2);
    const p = c.pauseAfterClaim();
    const a = c.svc.attemptTransferUnderLock(lockRef(r)); // A: claims attempt 5/6, pauses
    await p.isClaimed;
    c.at(25 * HOUR + 6 * MINUTE);
    c.expireChargeLease();
    const b = await c.svc.attemptTransferUnderLock(lockRef(r)); // B: absent, claims 6/6, pays
    expect(b.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    // A stays paused for more than a day: Stripe prunes the key.
    c.stripe.expireIdempotencyKeys();
    c.at(50 * HOUR);
    p.release();
    await a;

    expect(c.reinstatements()).toHaveLength(1);
    expect(c.stripe.netTo('acct_coach')).toBe(9_480);
    expect(duplicateAlerts()).toHaveLength(0);
    expect(c.row().status).toBe('succeeded');
    expect(c.row().stripe_transfer_id).toBe(c.reinstatements()[0].id);
  });

  it('paused between the re-proof and the request (no charge lock): the HTTP-boundary check sends nothing', async () => {
    const { c, r } = await agedRow(1);
    const p = c.pauseInCreate('before-check');
    const a = c.transfers.attempt(r.id); // A: claims 6/6, re-proves, enters the Stripe call
    await p.inCreate;
    c.at(25 * HOUR + 6 * MINUTE);
    const b = await c.transfers.attempt(r.id); // B: adopts, pays once
    expect(repayAlerts()).toHaveLength(0);
    expect(b.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    p.release();
    const aRes = await a;

    expect(aRes.status).toBe('succeeded'); // A re-read B's recorded result
    expect(c.reinstatements()).toHaveLength(1);
    expect(c.stripe.netTo('acct_coach')).toBe(9_480);
    expect(repayAlerts()).toHaveLength(0);
    expect(recoveredAlerts()).toHaveLength(0);
    expect(
      lines(warnLog).some((l) =>
        /^SFEE_TRANSFER_SEND_ABANDONED transfer=.*: SFEE_TRANSFER_SEND_ABANDONED .*the create was not sent/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('a request already past the boundary (in transit) collapses on the same key with the adopted send', async () => {
    const { c, r } = await agedRow(1);
    const p = c.pauseInCreate('in-transit');
    const a = c.transfers.attempt(r.id);
    await p.inCreate;
    c.at(25 * HOUR + 6 * MINUTE);
    const b = await c.transfers.attempt(r.id); // adopts: same key
    expect(b.status).toBe('succeeded');
    expect(repayAlerts()).toHaveLength(0);
    p.release();
    const aRes = await a; // Stripe replays the adopted transfer for the key

    expect(aRes.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    expect(c.stripe.netTo('acct_coach')).toBe(9_480);
    expect(duplicateAlerts()).toHaveLength(0);
    expect(c.row().stripe_transfer_id).toBe(c.reinstatements()[0].id);
  });
});

describe('B-627-9 narrowed: the adopted send establishes the result', () => {
  it("a definitive refusal of the adopted send is the proven final failure; a paused sender's late request gets the same answer", async () => {
    const { c, r } = await agedRow(1);
    const p = c.pauseInCreate('in-transit');
    const a = c.transfers.attempt(r.id);
    await p.inCreate;
    c.at(25 * HOUR + 6 * MINUTE);
    c.stripe.transferRefusals = 1; // Stripe refuses the key (saved for the key)
    const callsBefore = c.stripe.createTransfer.mock.calls.length;
    const b = await c.transfers.attempt(r.id);
    // The failure is Stripe's answer to the adopted send, not elapsed time.
    expect(c.stripe.createTransfer.mock.calls.length).toBe(callsBefore + 1);
    expect(lines(warnLog).some((l) => /^SFEE_TRANSFER_ADOPTED transfer=/.test(l))).toBe(true);
    expect(c.stripe.transferRefusals).toBe(0);
    expect(b.status).toBe('failed');
    expect(c.row().stripe_send_unresolved_at).toBeNull();
    expect(repayAlerts()).toHaveLength(1);
    p.release();
    const aRes = await a;

    // A's late request with the same key met the saved refusal: no money.
    expect(aRes.status).toBe('failed');
    expect(c.reinstatements()).toHaveLength(0);
    expect(recoveredAlerts()).toHaveLength(0);
    expect(repayAlerts()).toHaveLength(1);
  });

  it('a non-definitive failure of the adopted send stays pending with an alert, is never failed, and pays once later', async () => {
    const { c, r } = await agedRow(1);
    // Spend the last attempt on a send that never reached Stripe.
    c.stripe.transferNetworkFailures = 1;
    await c.transfers.attempt(r.id);
    expect(c.row().attempts).toBe(r.max_attempts);
    const marker: Date = c.row().stripe_send_unresolved_at;
    const budgetLine =
      /^SFEE_TRANSFER_FAILED transfer=.* attempt=6\/6 alert=true: .*attempt budget spent: the payout of 9480 usd stays pending/;
    const budgetLines = () => lines(errorLog).filter((l) => budgetLine.test(l)).length;
    const afterLastSend = budgetLines();

    const adoptAt = c.at(25 * HOUR + 6 * MINUTE);
    c.stripe.transferNetworkFailures = 1; // the adopted send times out too
    const held = await c.transfers.attempt(r.id);
    expect(held.status).toBe('pending');
    expect(c.row().status).toBe('pending');
    expect(c.row().attempts).toBe(r.max_attempts);
    expect(c.row().stripe_send_unresolved_at.getTime()).toBeGreaterThan(marker.getTime());
    expect(repayAlerts()).toHaveLength(0);
    expect(lines(warnLog).some((l) => /^SFEE_TRANSFER_ADOPTED transfer=/.test(l))).toBe(true);
    expect(budgetLines()).toBe(afterLastSend + 1);
    // Never re-sent inside its window; re-sent after the daily backoff.
    expect(c.row().next_attempt_at.getTime()).toBeGreaterThanOrEqual(
      c.row().stripe_send_unresolved_at.getTime() + 5 * MINUTE,
    );
    expect(c.row().next_attempt_at.getTime()).toBeGreaterThanOrEqual(adoptAt.getTime() + 24 * HOUR);

    c.at(50 * HOUR);
    const paid = await c.transfers.attempt(r.id);
    expect(paid.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    expect(c.stripe.netTo('acct_coach')).toBe(9_480);
    expect(repayAlerts()).toHaveLength(0);
  });
});

describe('B-627-9 narrowed: the send-start budget', () => {
  it('a sender that resumes after its 30 s start budget sends nothing and parks the claim until its window ends; the next worker sends it once', async () => {
    const { c, r, t0 } = await agedRow(2);
    const p = c.pauseAfterClaim();
    const a = c.transfers.attempt(r.id);
    await p.isClaimed;
    const claimedAt: Date = c.row().stripe_send_unresolved_at;
    expect(claimedAt.getTime()).toBe(t0.getTime());
    c.at(25 * HOUR + SEND_START_BUDGET_MS + 1_000); // nobody else touched the row
    p.release();
    const aRes = await a;

    expect(aRes.status).toBe('pending');
    expect(c.reinstatements()).toHaveLength(0);
    const parked = c.row();
    expect(parked.stripe_send_unresolved_at.getTime()).toBe(claimedAt.getTime());
    expect(parked.next_attempt_at.getTime()).toBe(
      claimedAt.getTime() + c.transfers.inFlightWindowMs,
    );
    expect(String(parked.last_error)).toMatch(/^SFEE_TRANSFER_SEND_ABANDONED: /);
    expect(repayAlerts()).toHaveLength(0);

    // Inside the window the parked claim is held; after it, sent once.
    c.at(25 * HOUR + 2 * MINUTE);
    await c.transfers.attempt(r.id);
    expect(c.reinstatements()).toHaveLength(0);
    c.at(25 * HOUR + 6 * MINUTE);
    const paid = await c.transfers.attempt(r.id);
    expect(paid.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    expect(c.stripe.netTo('acct_coach')).toBe(9_480);
  });

  it('a wall-clock step backward during the pause does not extend the start budget (monotonic age)', async () => {
    const { c, r, t0 } = await agedRow(2);
    let mono = performance.now();
    jest.spyOn(performance, 'now').mockImplementation(() => mono);
    const p = c.pauseAfterClaim();
    const a = c.transfers.attempt(r.id);
    await p.isClaimed;
    // 31 s really pass, while the wall clock is stepped back to the claim.
    mono += SEND_START_BUDGET_MS + 1_000;
    c.transfers.clock = () => new Date(t0.getTime());
    p.release();
    const aRes = await a;

    expect(aRes.status).toBe('pending');
    expect(c.reinstatements()).toHaveLength(0);
    expect(String(c.row().last_error)).toMatch(/^SFEE_TRANSFER_SEND_ABANDONED: /);
    expect(repayAlerts()).toHaveLength(0);
  });

  it('(control) a sender inside its start budget sends normally', async () => {
    const { c, r } = await agedRow(1);
    const p = c.pauseAfterClaim();
    const a = c.transfers.attempt(r.id);
    await p.isClaimed;
    c.at(25 * HOUR + SEND_START_BUDGET_MS - 1_000);
    p.release();
    const aRes = await a;
    expect(aRes.status).toBe('succeeded');
    expect(c.reinstatements()).toHaveLength(1);
    expect(lines(warnLog).some((l) => /SFEE_TRANSFER_SEND_ABANDONED/.test(l))).toBe(false);
  });
});

// Round 10 — B-627-10 (Sol, 3a5338d7): when the charge lock is lost after
// the claim and parking the claim then fails too, the log line named the
// park error by its Error.name (free text). It must use a closed code.
describe('B-627-10: a failed park is logged with a closed code only', () => {
  const CANARY = 'AUDIT_CANARY_name_contact_at_example_invalid';
  async function lockLostThenParkFails(parkError: Error) {
    const { c, r } = await agedRow(2);
    const lost = new ChargeLockLostError('ch_1', 'taken_over');
    let broken = false;
    // First fence (before the claim) passes; the re-proof after it fails.
    const fence = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        broken = true;
        throw lost;
      });
    const update = c.prisma.connectTransfer.updateMany.getMockImplementation()!;
    c.prisma.connectTransfer.updateMany.mockImplementation(async (args) =>
      broken ? { count: 0 } : update(args),
    );
    const read = c.prisma.connectTransfer.findUniqueOrThrow.getMockImplementation()!;
    c.prisma.connectTransfer.findUniqueOrThrow.mockImplementation(async (args) => {
      if (broken) throw parkError;
      return read(args);
    });
    const callsBefore = c.stripe.createTransfer.mock.calls.length;
    const outcome = await c.transfers.attempt(r.id, { beforeStripe: fence }).then(
      () => null,
      (e: unknown) => e,
    );
    const logged = [...lines(warnLog), ...lines(errorLog)];
    const sent = c.stripe.createTransfer.mock.calls.length - callsBefore;
    return { c, lost, outcome, logged, sent };
  }

  it('a custom error name, message and code never reach the log; the lock loss still surfaces and nothing is sent', async () => {
    const custom = Object.assign(new Error(`${CANARY} message`), {
      name: CANARY,
      code: 'P9999_canary',
    });
    const { c, lost, outcome, logged, sent } = await lockLostThenParkFails(custom);
    expect(outcome).toBe(lost);
    expect(sent).toBe(0);
    expect(c.reinstatements()).toHaveLength(0);
    expect(logged.filter((l) => /CANARY|canary|P9999/.test(l))).toEqual([]);
    expect(
      logged.some((l) =>
        /^SFEE_TRANSFER_SEND_ABANDONED transfer=\S+ park_error=unknown: parking the claim failed/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('an unrecognized database error code is logged as db_request, without its code or message', async () => {
    const dbError = new Prisma.PrismaClientKnownRequestError(`${CANARY} db message`, {
      code: 'P9999',
      clientVersion: 'canary',
    });
    const { c, lost, outcome, logged, sent } = await lockLostThenParkFails(dbError);
    expect(outcome).toBe(lost);
    expect(sent).toBe(0);
    expect(c.reinstatements()).toHaveLength(0);
    expect(logged.filter((l) => /CANARY|canary|P9999/.test(l))).toEqual([]);
    expect(
      logged.some((l) =>
        /^SFEE_TRANSFER_SEND_ABANDONED transfer=\S+ park_error=db_request: parking the claim failed/.test(
          l,
        ),
      ),
    ).toBe(true);
  });
});
