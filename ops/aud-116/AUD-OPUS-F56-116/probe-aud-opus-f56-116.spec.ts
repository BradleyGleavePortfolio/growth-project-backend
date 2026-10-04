// AUD-OPUS-F56-116 lens probe. Lives ONLY on audit/AUD-OPUS-F56-116/*; never merge.
// Base: growth-project-backend#686 head 7be7d396 (= #685 head 858d3716 plus
// three test files; src is identical).
//
// Part 1 (C-685-2 canary, expected RED): the charge lock is lost after the
// send claim, then parking the claim fails because the park's own CAS write
// (scheduleRecheck -> connectTransfer.updateMany) throws. B-627-10's tests
// cover only the read-back failure. The contract they state ("a failed park is
// logged with a closed code only") must hold here too.
//
// Part 2 (mutation sensitivity): each block re-runs the PR's OWN spec files,
// unchanged, in a fresh module registry, with ONE production behaviour
// replaced through a prototype spy. The control block must pass in full;
// every mutant block must make PR tests fail. A mutant that leaves a spec
// green means that spec does not pin the invariant. RED BY DESIGN.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
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


const CANARY = 'AUDIT_CANARY_name_contact_at_example_invalid';
const HOUR = 3_600_000;

describe('C-685-2 canary (expected RED): park CAS write throws after the lock is lost', () => {
  let warnLog: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const lines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map((c) => String(c[0]));

  async function run(parkError: Error) {
    const { prisma, db } = makeSettlementPrisma();
    const stripe = new FakeStripe();
    const ledger = new SplitLedgerService(asPrisma(prisma));
    const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
    const feePolicy = new FeePolicyService(asPrisma(prisma));
    const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
    db.accounts.push({ coach_user_id: 'coach-1', stripe_account_id: 'acct_coach' });
    const purchase = {
      id: 'purchase-1',
      coach_user_id: 'coach-1',
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
    // Same start as r9's agedRow(2): sale, full dispute, won; the
    // reinstatement's first send fails before Stripe; aged 25 h, keys pruned.
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
    const r = db.transfers.find((t) => t.kind === 'coach_reinstate')!;
    expect(r.status).toBe('pending');
    expect(r.stripe_send_unresolved_at).toBeInstanceOf(Date);
    r.attempts = r.max_attempts - 2;
    stripe.expireIdempotencyKeys();
    const d = new Date(Date.now() + 25 * HOUR);
    transfers.clock = () => d;

    const lost = new ChargeLockLostError('ch_1', 'taken_over');
    let broken = false;
    const fence = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        broken = true;
        throw lost;
      });
    // The park's CAS write throws (r9's B-627-10 tests make it return 0 and
    // make the read-back throw instead).
    const update = prisma.connectTransfer.updateMany.getMockImplementation()!;
    prisma.connectTransfer.updateMany.mockImplementation(async (args) => {
      if (broken) throw parkError;
      return update(args);
    });
    const before = stripe.createTransfer.mock.calls.length;
    const outcome = await transfers.attempt(r.id, { beforeStripe: fence }).then(
      () => null,
      (e: unknown) => e,
    );
    return {
      lost,
      outcome,
      sent: stripe.createTransfer.mock.calls.length - before,
      logged: [...lines(warnLog), ...lines(errorLog)],
    };
  }

  it('controls hold: the lock loss surfaces and nothing is sent', async () => {
    const { lost, outcome, sent } = await run(new Error(`${CANARY} message`));
    expect(outcome).toBe(lost);
    expect(sent).toBe(0);
  });

  it('acceptance (expected RED): the park error message never reaches the log', async () => {
    const { logged } = await run(new Error(`${CANARY} message`));
    expect(logged.filter((l) => /CANARY|canary/.test(l))).toEqual([]);
  });
});

// ---------------------------------------------------------------- Part 2
const SPECS: Record<string, string> = {
  conc: './s-fee-charge-concurrency.spec',
  r4: './s-fee-r4-money-protocol.spec',
  r5: './s-fee-r5-or-111-1.spec',
  r9: './s-fee-r9-paused-sender.spec',
  r7: './s-fee-r7-transfer-create-recovery.spec',
  r8: './s-fee-r8-transfer-in-flight.spec',
  renew: './s-fee-renewal-backfill.spec',
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
type Mods = { lock: any; fee: any; settle: any; orch: any };

function block(name: string, specs: string[], apply?: (m: Mods) => void) {
  describe(name, () => {
    jest.isolateModules(() => {
      const mods: Mods = {
        lock: require('../src/connect/fees/charge-lock'),
        fee: require('../src/connect/fees/fee-policy.service'),
        settle: require('../src/connect/fees/charge-settlement.service'),
        orch: require('../src/connect/fees/transfer-orchestrator.service'),
      };
      // Re-applied before every test: each PR spec's afterEach restores all spies.
      if (apply) beforeEach(() => apply(mods));
      for (const s of specs) {
        describe(`[${s}]`, () => {
          require(SPECS[s]);
        });
      }
    });
  });
}

block('CONTROL (must be all green)', ['conc', 'r4', 'r5', 'r9', 'r7', 'r8', 'renew']);

// TGP's 2% becomes 1.9%: every money assertion that pins the ruling must fail.
block('MUTANT fee-190bps', ['r4', 'r5', 'r7', 'renew'], (m) => {
  const proto: any = m.fee.FeePolicyService.prototype;
  const orig = proto.resolvePolicy;
  jest.spyOn(proto, 'resolvePolicy').mockImplementation(async function (this: any, ...args: any[]) {
    const p = await orig.apply(this, args);
    return { ...p, platform_application_fee_bps: 190 };
  });
});

// The per-charge fence always passes: a stale holder may move money.
block('MUTANT fence-always-passes', ['conc', 'r4', 'r9', 'r8'], (m) => {
  const proto: any = m.lock.ChargeLock.prototype;
  jest.spyOn(proto, 'fence').mockImplementation(async () => undefined);
});

// No 30 s start budget: a paused sender may start its create late.
block('MUTANT no-send-start-budget', ['r9', 'r7'], (m) => {
  const proto: any = m.orch.TransferOrchestratorService.prototype;
  jest.spyOn(proto, 'assertSendStartable').mockImplementation(() => undefined);
});

// OR-111-1 forward netting removed: open recoveries are never taken from the next sale.
block('MUTANT no-forward-netting', ['r4', 'r5'], (m) => {
  const proto: any = m.settle.ChargeSettlementService.prototype;
  jest.spyOn(proto, 'netOpenRecoveries').mockImplementation(async () => 0);
});
