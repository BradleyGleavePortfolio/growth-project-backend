// S-FEE round 7 — audit findings at c1d69c7f (Sol comment 5962121921):
//   B-627-8  an aged, uncertain won-dispute reinstatement could pay the same
//            money twice: a lost Stripe response or a lost local receipt left
//            the transfer row pending, and the next attempt re-sent the create
//            with the same idempotency key. Stripe may prune a key after
//            24 h, after which the same key makes a NEW transfer, and
//            reinstatements have no source_transaction to cap them.
//            Fix: the row is a durable operation record (marker set before
//            the create, cleared once the result is known); a sent create is
//            looked up at Stripe (metadata.tgp_transfer_op) before anything is
//            re-sent: found -> receipt repaired; unknown -> nothing sent,
//            alerted, pending; only a complete listing that proves it absent
//            allows a re-send.
//   C-627-8 (Sol) the in-app inbox row and the notice's in-app receipt were
//            separate commits: a failed receipt write repeated the inbox row.
//            Fix: one transaction.
// The fake keeps Stripe's durable transfers apart from its expiring key cache
// (FakeStripe.transfers vs transferKeyCache). Each B-627-8 test fails on
// c1d69c7f (second transfer, or the re-send / failed marking it asserts
// against). No live Stripe or DB.
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Prisma, type ClientPurchase } from '@prisma/client';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { EmailService } from '../src/email/email.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import {
  FakeStripe,
  Table,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

const COACH = 'coach-1';
const HEAD = 'head-1';
const HOUR = 3_600_000;

let errorLog: jest.SpyInstance;
let warnLog: jest.SpyInstance;
beforeEach(() => {
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const lines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map((c) => String(c[0]));

function setup(opts: { headCoach?: boolean } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(
    asPrisma(prisma),
    stripe,
    new FeePolicyService(asPrisma(prisma)),
    ledger,
    transfers,
  );
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  if (opts.headCoach) {
    db.assignments.push({
      sub_coach_id: COACH,
      head_coach_id: HEAD,
      archived_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    });
    db.accounts.push({ coach_user_id: HEAD, stripe_account_id: 'acct_head' });
  }
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
  // $100 sale, $3.20 processing fee, then a full dispute with a $15 fee.
  const sellAndDispute = async () => {
    stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 10_000, fee: 320 }));
    await svc.settleCharge({ purchase, charge_id: 'ch_1' });
    await svc.applyAdjustments({
      purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 10_000, fee_cents: 1_500 },
    });
  };
  // The dispute is won and the dispute fee returned: the payees' shares are
  // reinstated by new transfers that have no source charge.
  const win = () =>
    svc.applyAdjustments({
      purchase,
      charge_id: 'ch_1',
      dispute: { withdrawn_cents: 0, fee_cents: 0 },
    });
  const reinstateRows = () =>
    db.transfers.filter((t) => t.kind === 'coach_reinstate' || t.kind === 'head_coach_reinstate');
  const stripeReinstatements = () =>
    stripe.transfers.filter((t) => !t.source_transaction && /reinstate/.test(t.metadata.tgp_kind));
  const createsFor = (key: string) =>
    stripe.createTransfer.mock.calls.filter(([a]) => a.idempotencyKey === key).length;
  // Lose the local receipt (P2024) the first time each listed row is marked
  // succeeded, after Stripe already moved the money.
  const loseReceiptOnce = (kinds: string[]) => {
    const update = prisma.connectTransfer.update.getMockImplementation()!;
    const lost = new Set<string>();
    prisma.connectTransfer.update.mockImplementation(async (args) => {
      const row = db.transfers.find((t) => t.id === args.where.id);
      if (
        row &&
        kinds.includes(row.kind) &&
        args.data.status === 'succeeded' &&
        !lost.has(row.id)
      ) {
        lost.add(row.id);
        throw new Prisma.PrismaClientKnownRequestError('transfer receipt connection unavailable', {
          code: 'P2024',
          clientVersion: 'test',
        });
      }
      return update(args);
    });
  };
  // The sweeper, `hours` from now.
  const sweepAt = async (hours: number) => {
    const due = await transfers.findDueTransfers(new Date(Date.now() + hours * HOUR));
    for (const t of due) await transfers.attempt(t.id);
    return due;
  };
  return {
    prisma,
    db,
    stripe,
    transfers,
    svc,
    purchase,
    sellAndDispute,
    win,
    reinstateRows,
    stripeReinstatements,
    createsFor,
    loseReceiptOnce,
    sweepAt,
  };
}

const legs = [
  { name: 'coach only', headCoach: false, expect: { coach_reinstate: 9_480 } },
  {
    name: 'coach + head coach',
    headCoach: true,
    expect: { coach_reinstate: 8_980, head_coach_reinstate: 500 },
  },
] as const;

describe('B-627-8 a lost reinstatement result is looked up, never paid twice', () => {
  describe.each(legs)('$name', ({ headCoach, expect: amounts }) => {
    const kinds = Object.keys(amounts);
    const total = Object.values(amounts).reduce((n: number, a: number) => n + a, 0);

    it.each([{ expired: true }, { expired: false }])(
      'receipt lost after Stripe moved the money; retry 25 h later (key expired=$expired) records it, sends nothing',
      async ({ expired }) => {
        const c = setup({ headCoach });
        await c.sellAndDispute();
        c.loseReceiptOnce(kinds);
        await c.win();
        const rows = c.reinstateRows();
        expect(rows.map((r) => r.kind).sort()).toEqual([...kinds].sort());
        for (const r of rows) {
          expect(r.status).toBe('pending');
          expect(r.stripe_transfer_id).toBeNull();
          expect(r.stripe_send_unresolved_at).toBeInstanceOf(Date);
          expect(c.createsFor(r.idempotency_key)).toBe(1);
        }
        expect(c.stripeReinstatements()).toHaveLength(kinds.length);
        expect(
          lines(errorLog).filter((l) => /^SFEE_TRANSFER_RECEIPT_PENDING alert=true/.test(l)),
        ).toHaveLength(kinds.length);

        if (expired) c.stripe.expireIdempotencyKeys();
        const due = await c.sweepAt(25);
        expect(due.map((d) => d.id).sort()).toEqual(rows.map((r) => r.id).sort());

        expect(c.stripeReinstatements()).toHaveLength(kinds.length);
        expect(c.stripeReinstatements().reduce((n, t) => n + t.amount, 0)).toBe(total);
        for (const r of c.reinstateRows()) {
          expect(c.createsFor(r.idempotency_key)).toBe(1);
          expect(r.status).toBe('succeeded');
          expect(r.stripe_send_unresolved_at).toBeNull();
          const external = c.stripe.transfers.find((t) => t.id === r.stripe_transfer_id)!;
          expect(external.amount).toBe(r.amount_cents);
          expect(external.metadata.tgp_transfer_op).toBe(r.idempotency_key);
          expect(r.amount_cents).toBe(amounts[r.kind as keyof typeof amounts]);
        }
      },
    );

    it.each([{ expired: true }, { expired: false }])(
      'response lost and Stripe listing down at the time; retry 25 h later (key expired=$expired) finds it, sends nothing',
      async ({ expired }) => {
        const c = setup({ headCoach });
        await c.sellAndDispute();
        c.stripe.transferResponsesLost = kinds.length;
        c.stripe.failListTransfers = true;
        await c.win();
        for (const r of c.reinstateRows()) {
          expect(r.status).toBe('pending');
          expect(r.stripe_transfer_id).toBeNull();
          expect(String(r.last_error)).toMatch(/^SFEE_TRANSFER_UNCERTAIN: /);
        }
        expect(c.stripeReinstatements()).toHaveLength(kinds.length);

        c.stripe.failListTransfers = false;
        if (expired) c.stripe.expireIdempotencyKeys();
        await c.sweepAt(25);

        expect(c.stripeReinstatements()).toHaveLength(kinds.length);
        expect(c.stripeReinstatements().reduce((n, t) => n + t.amount, 0)).toBe(total);
        for (const r of c.reinstateRows()) {
          expect(c.createsFor(r.idempotency_key)).toBe(1);
          expect(r.status).toBe('succeeded');
        }
        expect(c.stripe.netTo('acct_coach')).toBe(amounts.coach_reinstate);
      },
    );

    it('response lost, Stripe listing up: reconciled at once by the Stripe object, never re-sent', async () => {
      const c = setup({ headCoach });
      await c.sellAndDispute();
      c.stripe.transferResponsesLost = kinds.length;
      await c.win();
      for (const r of c.reinstateRows()) {
        expect(r.status).toBe('succeeded');
        expect(c.createsFor(r.idempotency_key)).toBe(1);
      }
      c.stripe.expireIdempotencyKeys();
      await c.sweepAt(25);
      expect(c.stripeReinstatements()).toHaveLength(kinds.length);
      expect(lines(errorLog).some((l) => /SFEE_TRANSFER_UNCERTAIN/.test(l))).toBe(false);
    });
  });

  it('listing still unavailable or incomplete: nothing is sent, the row stays pending and alerts, then recovers once', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.loseReceiptOnce(['coach_reinstate']);
    await c.win();
    const [row] = c.reinstateRows();
    c.stripe.expireIdempotencyKeys();

    c.stripe.failListTransfers = true;
    await c.sweepAt(25);
    c.stripe.failListTransfers = false;
    // has_more with an empty page: an incomplete listing, never "absent".
    c.stripe.transferListAlwaysHasMore = true;
    c.stripe.transferListPageSize = 0;
    await c.sweepAt(50);

    expect(c.createsFor(row.idempotency_key)).toBe(1);
    expect(c.stripeReinstatements()).toHaveLength(1);
    const pending = c.db.transfers.find((t) => t.id === row.id)!;
    expect(pending.status).toBe('pending');
    expect(pending.stripe_send_unresolved_at).toBeInstanceOf(Date);
    expect(String(pending.last_error)).toMatch(
      /^SFEE_TRANSFER_UNCERTAIN: transfer lookup unavailable/,
    );
    const uncertain = lines(errorLog).filter((l) =>
      /^SFEE_TRANSFER_UNCERTAIN alert=true transfer=.* op=.* amount=9480 .*not re-sent/.test(l),
    );
    expect(uncertain).toHaveLength(2);
    expect(lines(errorLog).some((l) => /SFEE_TRANSFER_FAILED/.test(l))).toBe(false);

    // Stripe can be read in full again: the existing transfer is recorded.
    c.stripe.transferListAlwaysHasMore = false;
    c.stripe.transferListPageSize = 100;
    await c.sweepAt(80);
    const done = c.db.transfers.find((t) => t.id === row.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.stripe_transfer_id).toBe(c.stripeReinstatements()[0].id);
    expect(c.createsFor(row.idempotency_key)).toBe(1);
  });

  it('an unresolved create at its attempt budget is never marked failed while it may exist', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.loseReceiptOnce(['coach_reinstate']);
    await c.win();
    const [row] = c.reinstateRows();
    const live = c.db.transfers.find((t) => t.id === row.id)!;
    live.max_attempts = 1; // the one send already used the whole budget
    c.stripe.failListTransfers = true;
    c.stripe.expireIdempotencyKeys();
    await c.sweepAt(25);
    expect(live.status).toBe('pending');
    expect(lines(errorLog).some((l) => /SFEE_TRANSFER_FAILED/.test(l))).toBe(false);
    c.stripe.failListTransfers = false;
    await c.sweepAt(50);
    expect(live.status).toBe('succeeded');
    expect(c.stripeReinstatements()).toHaveLength(1);
  });

  it('control: proven absent (request never reached Stripe) is re-sent once, even after key expiry', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.stripe.transferNetworkFailures = 1;
    await c.win();
    const [row] = c.reinstateRows();
    expect(row.status).toBe('pending');
    expect(row.stripe_send_unresolved_at).toBeInstanceOf(Date);
    expect(c.stripeReinstatements()).toHaveLength(0);
    // Not final, and not an alert: a plain retry with backoff.
    expect(String(row.last_error)).toMatch(/^SFEE_TRANSFER_FAILED: /);
    expect(lines(warnLog).some((l) => /re-checked before any re-send/.test(l))).toBe(true);

    c.stripe.expireIdempotencyKeys();
    await c.sweepAt(25);
    const done = c.db.transfers.find((t) => t.id === row.id)!;
    expect(done.status).toBe('succeeded');
    expect(c.createsFor(row.idempotency_key)).toBe(2);
    expect(c.stripeReinstatements()).toHaveLength(1);
    expect(c.stripeReinstatements()[0].amount).toBe(9_480);
  });

  it('control: within the key lifetime a re-send collapses on the same key (cached)', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.stripe.transferNetworkFailures = 1;
    await c.win();
    const [row] = c.reinstateRows();
    await c.sweepAt(0.1);
    expect(c.db.transfers.find((t) => t.id === row.id)!.status).toBe('succeeded');
    expect(c.stripeReinstatements()).toHaveLength(1);
  });

  it('control: absent at the attempt budget is a proven final failure (repay alert is safe)', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.stripe.transferNetworkFailures = 1;
    await c.win();
    const [row] = c.reinstateRows();
    const live = c.db.transfers.find((t) => t.id === row.id)!;
    live.max_attempts = 1;
    await c.sweepAt(25);
    expect(live.status).toBe('failed');
    expect(live.stripe_send_unresolved_at).toBeNull();
    expect(c.stripeReinstatements()).toHaveLength(0);
  });

  it('two workers on the same aged unresolved row: one re-send at most', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.stripe.transferNetworkFailures = 1;
    await c.win();
    const [row] = c.reinstateRows();
    c.stripe.expireIdempotencyKeys();
    await Promise.all([c.transfers.attempt(row.id), c.transfers.attempt(row.id)]);
    expect(c.createsFor(row.idempotency_key)).toBe(2); // the lost one + exactly one re-send
    expect(c.stripeReinstatements()).toHaveLength(1);
  });

  it('the lookup reads the row destination and transfer group from the row creation time', async () => {
    const c = setup();
    await c.sellAndDispute();
    c.loseReceiptOnce(['coach_reinstate']);
    await c.win();
    const [row] = c.reinstateRows();
    c.stripe.listTransfers.mockClear();
    await c.sweepAt(25);
    expect(c.stripe.listTransfers).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: 'acct_coach',
        transfer_group: 'purchase_purchase-1',
        created_gte: Math.floor(row.created_at.getTime() / 1000) - 3600,
        limit: 100,
      }),
    );
  });
});

describe('C-627-8 (Sol) the in-app inbox row and its notice receipt commit together', () => {
  it('a failed in-app receipt write rolls the inbox row back: one inbox row per notice', async () => {
    const c = setup();
    const inboxRows: Row[] = [];
    const logRows: Row[] = [];
    const p = Object.assign(c.prisma, {
      notification: new Table(inboxRows, { prefix: 'notification' }),
      notificationPreferences: new Table([], { prefix: 'preferences' }),
      user: new Table([{ id: COACH, name: 'Coach', email: 'coach@example.invalid' }], {
        prefix: 'user',
      }),
      emailSendLog: new Table(logRows, { unique: ['idempotency_key'], prefix: 'email' }),
    });
    // Interactive transactions roll back on a throw, like Postgres.
    p.$transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
      const inbox = inboxRows.map((r) => ({ ...r }));
      const notices = (c.db.notices ?? []).map((r) => ({ ...r }));
      try {
        return await fn(p);
      } catch (err) {
        inboxRows.splice(0, inboxRows.length, ...inbox);
        c.db.notices!.splice(0, c.db.notices!.length, ...notices);
        throw err;
      }
    });
    const notifications = new NotificationsService(asPrisma(p));
    jest
      .spyOn(notifications, 'pushToUser')
      .mockResolvedValue({ delivered: true, code: 'delivered' });
    const email = new EmailService(asPrisma(p), new ConfigService({ EMAIL_TRANSPORT: 'log' }));
    const notices = new PayoutNoticeService(asPrisma(p), notifications, email);
    c.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 10_000, fee: 320 }));
    await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
    c.stripe.charges.get('ch_1')!.amount_refunded = 10_000;
    await c.svc.applyAdjustments({
      purchase: c.purchase,
      charge_id: 'ch_1',
      refunded_cents: 10_000,
    });

    const update = p.payoutAdjustmentNotice.updateMany.getMockImplementation()!;
    let receiptFailed = false;
    p.payoutAdjustmentNotice.updateMany.mockImplementation(async (args) => {
      if (!receiptFailed && args.data.inapp_status === 'sent') {
        receiptFailed = true;
        throw new Prisma.PrismaClientKnownRequestError('receipt connection unavailable', {
          code: 'P2024',
          clientVersion: 'test',
        });
      }
      return update(args);
    });
    await notices.dispatchForCharge('ch_1').catch(() => undefined);
    expect(inboxRows.filter((r) => r.channel === 'inapp')).toHaveLength(0);
    await notices.dispatchPending(new Date(Date.now() + 10 * 60_000));
    expect(inboxRows.filter((r) => r.channel === 'inapp')).toHaveLength(1);
    const notice = c.db.notices![0];
    expect(notice.inapp_status).toBe('sent');
    expect(notice.inapp_notification_id).toBe(inboxRows.find((r) => r.channel === 'inapp')!.id);
    expect(notice.dispatched_at).not.toBeNull();
  });
});
