// B-641-7 (narrowed) + B-641-8 (B-COACH-5, agent 115) — the 23-hour retry
// admission for head-coach transfer reversals is enforced on the ONE shared
// path, for every caller (late charge.refund.updated, admin re-entry, the
// sweep, overlapping sweeps on several instances), and rows past the window
// leave the retry batch so fresh refunds are never starved.
//
// Real RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService over the stateful Prisma double (which honors
// orderBy / take / cursor like production Prisma). Only Stripe is synthetic,
// and it models key retention: a key creates one reversal while it is
// retained; `expireKeys()` forgets every key, as Stripe may after 24 hours.

import 'reflect-metadata';
import * as Sentry from '@sentry/node';
import { Logger } from '@nestjs/common';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  HOUR,
  harness,
  refundRow,
  seedPurchase,
  staleOwedRefund,
} from './support/refund-reversal-harness';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: jest.fn(),
}));

const captureMessage = jest.mocked(Sentry.captureMessage);

beforeEach(() => captureMessage.mockClear());

describe('B-641-7 — one shared 23-hour admission for every caller', () => {
  it('a late charge.refund.updated after the key expired sends nothing and moves the refund to review', async () => {
    const h = await staleOwedRefund();
    await h.svc.handle({
      id: 'evt_late',
      type: 'charge.refund.updated',
      data: { object: { id: 're_r-late', charge: 'ch_p-late', amount: 2450, status: 'succeeded' } },
    });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.stripeTotal('tr_p-late')).toBe(122);
    expect(h.refund('r-late').transfer_reversed).toBe(false);
    expect(h.refund('r-late').transfer_reversal_review_at).toBeInstanceOf(Date);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('an admin re-entry of the same refund after the key expired sends nothing', async () => {
    const h = await staleOwedRefund();
    await h.svc.createAdminRefund({
      purchase_id: 'p-late',
      amount_cents: 2450,
      reason: 'requested_by_customer',
      initiated_by_user_id: 'owner-1',
    });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(h.stripeTotal('tr_p-late')).toBe(122);
    expect(h.refund('r-late').transfer_reversal_review_at).toBeInstanceOf(Date);
  });

  it('the sweep moves an expired row to review and alerts once, however many runs see it', async () => {
    const h = await staleOwedRefund();
    const first = await h.svc.retryPendingTransferReversals();
    const second = await h.svc.retryPendingTransferReversals();
    expect(first).toMatchObject({ retried: 0, reversed: 0, needs_review: 1, in_review: 1 });
    expect(second).toMatchObject({ retried: 0, reversed: 0, needs_review: 0, in_review: 1 });
    expect(h.reverseTransfer).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = captureMessage.mock.calls[0];
    expect(message).toBe('head-coach transfer reversal needs operator review');
    // Ids and codes only reach Sentry.
    expect(JSON.stringify(context)).not.toMatch(/coach@example|Coach One|client-1/);
    expect(context).toMatchObject({
      level: 'error',
      tags: { code: 'REFUND_TRANSFER_REVERSAL_REVIEW' },
      extra: { charge_refund_id: 'r-late', purchase_id: 'p-late' },
    });
  });

  it('a refund that was never sent is admitted however old its success is, and stamps its first attempt', async () => {
    const h = harness();
    const at = new Date(Date.now() - 40 * HOUR);
    seedPurchase(h.db, 'p-new', at);
    h.db.state.chargeRefund.push(
      refundRow('r-new', 'p-new', at, { transfer_reversal_first_attempt_at: null }),
    );
    const out = await h.svc.retryPendingTransferReversals();
    expect(out).toMatchObject({ retried: 1, reversed: 1, needs_review: 0 });
    expect(h.stripeTotal('tr_p-new')).toBe(122);
    expect(h.headCoach('p-new')).toBe(122);
    expect(h.refund('r-new').transfer_reversal_first_attempt_at).toBeInstanceOf(Date);
  });

  it('two sweeps on two instances overlapping on one owed refund reverse it once', async () => {
    const h = harness();
    const at = new Date(Date.now() - 2 * HOUR);
    seedPurchase(h.db, 'p-2', at);
    h.db.state.chargeRefund.push(refundRow('r-2', 'p-2', at));
    await Promise.all([
      h.svc.retryPendingTransferReversals(),
      h.svc.retryPendingTransferReversals(),
    ]);
    expect(h.stripeTotal('tr_p-2')).toBe(122);
    expect(h.headCoach('p-2')).toBe(122);
    expect(h.refund('r-2').transfer_reversed).toBe(true);
  });
});

describe('B-641-8 — expired rows never starve fresh recoverable refunds', () => {
  it('a fresh owed refund behind more than one batch of expired rows is reversed in the first run', async () => {
    const h = harness();
    const old = new Date(Date.now() - 30 * HOUR);
    for (let i = 0; i < 60; i++) {
      const pid = `p-old-${String(i).padStart(2, '0')}`;
      seedPurchase(h.db, pid, old);
      h.db.state.chargeRefund.push(
        refundRow(`r-old-${String(i).padStart(2, '0')}`, pid, new Date(old.getTime() + i)),
      );
    }
    const fresh = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-fresh', fresh);
    h.db.state.chargeRefund.push(refundRow('r-fresh', 'p-fresh', fresh));

    const out = await h.svc.retryPendingTransferReversals();
    expect(out).toMatchObject({ reversed: 1, needs_review: 60, in_review: 60 });
    expect(h.stripeTotal('tr_p-fresh')).toBe(122);
    expect(h.refund('r-fresh').transfer_reversed).toBe(true);
    // No expired row was resent.
    expect(h.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(60);

    // The next run repeats nothing.
    const again = await h.svc.retryPendingTransferReversals();
    expect(again).toMatchObject({ retried: 0, reversed: 0, needs_review: 0, in_review: 60 });
    expect(captureMessage).toHaveBeenCalledTimes(60);
  });

  it('more than one batch of fresh owed refunds is reached in one run', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 120; i++) {
      const pid = `p-f-${String(i).padStart(3, '0')}`;
      seedPurchase(h.db, pid, at);
      h.db.state.chargeRefund.push(
        refundRow(`r-f-${String(i).padStart(3, '0')}`, pid, new Date(at.getTime() + i)),
      );
    }
    const out = await h.svc.retryPendingTransferReversals(new Date(), 50);
    expect(out).toMatchObject({ retried: 120, reversed: 120, needs_review: 0 });
  });

  it('pages past rows that leave the owed set and rows that stay owed, each retried once per run', async () => {
    // Every third Stripe call fails, so a page mixes rows that leave the set
    // (reversed) with rows that stay owed (pending). A cursor on a row that
    // left the filter returned an empty page at 183ed462; the last-attempt
    // filter reaches all 120 and never retries a row twice in one run.
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < 120; i++) {
      const pid = `p-m-${String(i).padStart(3, '0')}`;
      seedPurchase(h.db, pid, at);
      h.db.state.chargeRefund.push(
        refundRow(`r-m-${String(i).padStart(3, '0')}`, pid, new Date(at.getTime() + i)),
      );
    }
    const real = h.reverseTransfer.getMockImplementation();
    h.reverseTransfer.mockImplementation(async (args) => {
      const n = Number(args.idempotencyKey.slice(-3));
      if (n % 3 === 2) throw Object.assign(new Error('Stripe unavailable'), { code: 'api_error' });
      return (real as NonNullable<typeof real>)(args);
    });
    const out = await h.svc.retryPendingTransferReversals(new Date(), 50);
    expect(out).toMatchObject({ retried: 120, reversed: 80, needs_review: 0 });
    const keys = h.reverseTransfer.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toHaveLength(120);
    expect(new Set(keys).size).toBe(120);
  });
});

// FIX ROUND 6 (B-COACH-5, agent 115) — Sol REQUEST CHANGES @ 02cd3f88.
describe('B-641-8 (narrowed) — persistent failures never hold later refunds back across runs', () => {
  function backlog(failing: number) {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    for (let i = 0; i < failing; i++) {
      const id = String(i).padStart(2, '0');
      seedPurchase(h.db, `p-a-${id}`, at);
      h.db.state.chargeRefund.push(refundRow(`r-a-${id}`, `p-a-${id}`, new Date(at.getTime() + i)));
    }
    // Newest and last by id, so neither creation order nor id puts it first.
    seedPurchase(h.db, 'p-z-fresh', new Date(at.getTime() + 100));
    h.db.state.chargeRefund.push(refundRow('r-z-fresh', 'p-z-fresh', new Date(at.getTime() + 100)));
    const real = h.reverseTransfer.getMockImplementation();
    h.reverseTransfer.mockImplementation(async (args) => {
      if (args.transfer_id !== 'tr_p-z-fresh') throw new Error('Synthetic provider failure');
      return (real as NonNullable<typeof real>)(args);
    });
    return h;
  }

  it('Sol probe: 20 failing rows fill a run of 20 one-row pages; the next run reaches the fresh refund', async () => {
    const h = backlog(20);
    const first = await h.svc.retryPendingTransferReversals(new Date(), 1);
    expect(first).toMatchObject({ retried: 20, reversed: 0 });
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + 15 * 60_000), 1);
    expect({
      external: h.stripeTotal('tr_p-z-fresh'),
      local: h.headCoach('p-z-fresh'),
      done: h.refund('r-z-fresh').transfer_reversed,
    }).toEqual({ external: 122, local: 122, done: true });
  });

  it('more failures than the page budget: every owed row is tried within a bounded number of runs', async () => {
    // 45 failing rows, 20 tries a run: runs take 20, 20, then the rest and
    // the fresh row, never the same 20 again while others wait.
    const h = backlog(45);
    const tried = new Set<string>();
    for (let run = 0; run < 3; run++) {
      h.reverseTransfer.mockClear();
      await h.svc.retryPendingTransferReversals(new Date(Date.now() + run * 15 * 60_000), 1);
      for (const c of h.reverseTransfer.mock.calls) tried.add(c[0].transfer_id);
    }
    expect(tried.size).toBe(46);
    expect(h.refund('r-z-fresh').transfer_reversed).toBe(true);
    expect(h.stripeTotal('tr_p-z-fresh')).toBe(122);
  });
});

describe('B-641-11 — reversal failure logs carry ids and closed codes only', () => {
  async function failOnce(err: Error): Promise<string> {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-log', at);
    h.db.state.chargeRefund.push(refundRow('r-log', 'p-log', at));
    h.reverseTransfer.mockRejectedValueOnce(err);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await h.svc.retryPendingTransferReversals();
      return warn.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      warn.mockRestore();
    }
  }

  it('Sol probe: an arbitrary Error.name never reaches the logger', async () => {
    const error = new Error('synthetic non-code');
    error.name = 'AUDIT_FREE_TEXT_CANARY_contact_at_example_invalid';
    const logged = await failOnce(error);
    expect(logged).toContain('refund=r-log');
    // Not a Stripe answer: the reversal operation reports the outcome unknown.
    expect(logged).toContain('code=SFEE_REVERSAL_UNCERTAIN');
    expect(logged).not.toContain('AUDIT_FREE_TEXT_CANARY');
  });

  it('an unknown Stripe code or a bad status is logged as a closed fallback', async () => {
    const logged = await failOnce(
      new StripeConnectApiError(
        'Card holder jane@example.test',
        402,
        'audit_free_text_canary_contact_at_example_invalid',
        'invalid_request_error',
      ),
    );
    // A definitive refusal (400/402/404): the operation's line carries the
    // status and the cataloged code ('other' when unknown).
    expect(logged).toMatch(/http=402 type=invalid_request_error code=other/);
    expect(logged).toContain('refund=r-log code=stripe_refused');
    expect(logged).not.toMatch(/canary|example/);
    expect(
      await failOnce(new StripeConnectApiError('x', 400, 'balance_insufficient', null)),
    ).toMatch(/http=400 .*code=balance_insufficient/);
    // C-674-5: anything else (bad status, 5xx, the client timeout) is unknown.
    const timeout = new StripeConnectApiError('x', 503, 'request_timeout', 'api_connection_error');
    for (const err of [
      new StripeConnectApiError('x', 99999, 'rate_limit', null),
      new StripeConnectApiError('x', 500, null, null),
      timeout,
    ]) {
      expect(await failOnce(err)).toContain('refund=r-log code=SFEE_REVERSAL_UNCERTAIN');
    }
  });
});
