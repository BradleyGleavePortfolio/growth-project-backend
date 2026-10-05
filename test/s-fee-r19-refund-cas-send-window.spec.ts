// S-FEE round 19 (B-FEES19-119, agent 119): failing-before tests for the open findings at
// #684 9fb9c48f. Every amount is exact (4,900 charge, 172 Stripe fee, coach net 4,630).
//   B-684-12 (both lenses)  a refund status write is a compare-and-set: a writer paused between
//                           its read and its write never overwrites a newer outcome
//   Sol B-684-3             no push / email provider call starts past the run deadline or the
//                           notice claim, after every awaited read up to the provider
import type { ClientPurchase } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { noticeSendSignal, PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
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

type RefundFixture = { id: string; status: string; amount: number; currency: string } & Row;

function setup(opts: { email?: 'real' } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  const user = new Table([{ id: 'coach_1', email: 'payee@example.invalid', name: null }], {
    prefix: 'u',
  });
  const emailLog = new Table([], { prefix: 'em', unique: ['idempotency_key'] });
  Object.assign(prisma, { user, emailSendLog: emailLog });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(
    asPrisma(prisma),
    stripe,
    new FeePolicyService(asPrisma(prisma)),
    ledger,
    transfers,
  );
  const fns = {
    createNotification: jest.fn(async (..._a: unknown[]) => ({ id: 'n_1' })),
    channelGate: jest.fn(async (..._a: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._a: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._a: unknown[]) => ({ status: 'sent' })),
  };
  const stub: object = fns;
  const transport = { send: jest.fn(async (..._a: unknown[]) => ({ providerMessageId: 'msg_1' })) };
  const config: object = { get: () => undefined };
  const realEmail = new EmailService(asPrisma(prisma), config as ConfigService);
  Object.assign(realEmail, { transport, transportKind: 'resend' });
  const email = opts.email === 'real' ? realEmail : (stub as EmailService);
  const notices = new PayoutNoticeService(asPrisma(prisma), stub as NotificationsService, email);
  const refunds = new RefundDisputeHandlerService(
    asPrisma(prisma),
    stripe,
    ledger,
    transfers,
    new PayoutReadinessService(asPrisma(prisma), stripe),
    stub as NotificationsService,
    undefined,
    undefined,
    settlements,
    notices,
  );
  const router = new CheckoutWebhookHandlerService(
    asPrisma(prisma),
    stripe,
    undefined,
    undefined,
    refunds,
  );
  const purchase = {
    id: 'cp_1',
    coach_user_id: 'coach_1',
    client_user_id: 'client_1',
    package_id: 'pkg_1',
    amount_cents: 4_900,
    currency: 'usd',
    status: 'paid',
    source: null,
    entitlement_active: true,
    billing_type: 'one_time',
    stripe_payment_intent_id: null,
    stripe_subscription_id: null,
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  const list = (data: RefundFixture[]) => stripe.refundsByCharge.set('ch_1', data);
  return {
    prisma,
    db,
    stripe,
    settlements,
    notices,
    refunds,
    router,
    fns,
    list,
    user,
    emailLog,
    transport,
  };
}
type Ctx = ReturnType<typeof setup>;

const usd = (id: string, amount: number, status = 'succeeded'): RefundFixture => ({
  id,
  status,
  amount,
  currency: 'usd',
});
const refunded = (data: RefundFixture[]) => ({
  id: 'evt_refunded',
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_1',
      amount: 4_900,
      amount_refunded: data.reduce((n, r) => n + (r.status === 'succeeded' ? r.amount : 0), 0),
      refunds: { data, has_more: false },
    },
  },
});
const update = (type: string, status: string) => ({
  id: `evt_${type}_${status}`,
  type,
  data: { object: { id: 're_1', object: 'refund', charge: 'ch_1', amount: 4_900, status } },
});

async function settledWithPending(c: Ctx) {
  await c.settlements.settleCharge({
    purchase: c.db.purchases[0] as ClientPurchase,
    charge_id: 'ch_1',
  });
  expect(c.stripe.netTo('acct_1')).toBe(4_630);
  c.list([usd('re_1', 4_900, 'pending')]);
  await c.router.handle(refunded([usd('re_1', 4_900, 'pending')]));
}

// Runs `between` once, right before the first refund-row write of `status` (the paused writer
// has read the row and decided; its SQL has not run).
function pauseWrite(
  c: Ctx,
  method: 'update' | 'create',
  status: string,
  between: () => Promise<unknown>,
) {
  const tbl = c.prisma.chargeRefund;
  const real = tbl[method].getMockImplementation() as (a: { data: Row }) => Promise<Row>;
  let fired = false;
  tbl[method].mockImplementation(async (args: { where?: Row; data: Row }) => {
    if (!fired && args?.data?.status === status) {
      fired = true;
      await between();
    }
    return real(args);
  });
}

const outcome = (c: Ctx) => ({
  status: c.db.refunds[0].status,
  applied: c.db.refunds[0].ledger_reversed === true,
  net: c.stripe.netTo('acct_1'),
  flagged: c.db.settlements[0].reconcile_reason ?? null,
  access: c.db.purchases[0].entitlement_active,
});

afterEach(() => jest.restoreAllMocks());

describe('B-684-12: a refund status write never overwrites a newer outcome', () => {
  it.each([
    ['refund.updated', 'failed'],
    ['charge.refund.updated', 'canceled'],
  ])(
    'a %s succeeded writer paused before its write; %s completes first: nothing moves',
    async (type, terminal) => {
      const c = setup();
      await settledWithPending(c);
      c.list([usd('re_1', 4_900)]);
      pauseWrite(c, 'update', 'succeeded', async () => {
        c.list([usd('re_1', 4_900, terminal)]);
        await c.router.handle(update('refund.updated', terminal));
      });
      await c.router.handle(update(type, 'succeeded'));
      expect(outcome(c)).toEqual({
        status: terminal,
        applied: false,
        net: 4_630,
        flagged: null,
        access: true,
      });
      expect(c.db.purchases[0].status).toBe('paid');
    },
  );

  it('a charge.refunded snapshot (succeeded) paused; the failure completes first: refunded_cents stays 0', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900, 'failed')]);
    pauseWrite(c, 'update', 'succeeded', () => c.router.handle(update('refund.updated', 'failed')));
    await c.router.handle(refunded([usd('re_1', 4_900)]));
    expect(outcome(c)).toMatchObject({
      status: 'failed',
      applied: false,
      net: 4_630,
      flagged: null,
    });
    expect(c.db.settlements[0].refunded_cents).toBe(0);
  });

  it('the failed writer paused; the succeeded one applies first: failed is written and flagged once', async () => {
    const c = setup();
    await settledWithPending(c);
    pauseWrite(c, 'update', 'failed', async () => {
      c.list([usd('re_1', 4_900)]);
      await c.router.handle(update('refund.updated', 'succeeded'));
      c.list([usd('re_1', 4_900, 'failed')]);
    });
    await c.router.handle(update('refund.updated', 'failed'));
    expect(outcome(c)).toMatchObject({
      status: 'failed',
      applied: true,
      net: 0,
      flagged: 'SFEE_REFUND_FAILED_AFTER_APPLY',
    });
    expect(c.stripe.reversals).toHaveLength(1);
  });

  it('a stale pending writer paused; the refund succeeds and applies first: it stays succeeded, applied once', async () => {
    const c = setup();
    await settledWithPending(c);
    pauseWrite(c, 'update', 'pending', async () => {
      c.list([usd('re_1', 4_900)]);
      await c.router.handle(update('refund.updated', 'succeeded'));
    });
    await c.router.handle(refunded([usd('re_1', 4_900, 'pending')]));
    expect(outcome(c)).toMatchObject({ status: 'succeeded', applied: true, net: 0 });
    expect(c.stripe.reversals).toHaveLength(1);
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
  });

  it('insert race: a succeeded insert loses to a failed insert (P2002) and records failed, moving nothing', async () => {
    const c = setup();
    await c.settlements.settleCharge({
      purchase: c.db.purchases[0] as ClientPurchase,
      charge_id: 'ch_1',
    });
    const args = (status: string) => ({
      purchase: c.db.purchases[0] as ClientPurchase,
      stripe_refund_id: 're_1',
      stripe_charge_id: 'ch_1',
      amount_cents: 4_900,
      status,
      reason: null,
    });
    c.list([usd('re_1', 4_900, 'failed')]);
    pauseWrite(c, 'create', 'succeeded', () => c.refunds.upsertAndApplyRefund(args('failed')));
    const res = await c.refunds.upsertAndApplyRefund(args('succeeded'));
    expect(res.ledger_just_reversed).toBe(false);
    expect(c.db.refunds).toHaveLength(1);
    expect(outcome(c)).toMatchObject({
      status: 'failed',
      applied: false,
      net: 4_630,
      flagged: null,
    });
  });

  it('a status that keeps changing under the writer fails closed after bounded retries; nothing moves', async () => {
    const c = setup();
    await settledWithPending(c);
    const tbl = c.prisma.chargeRefund;
    let flips = 0;
    tbl.update.mockImplementation(async () => {
      flips += 1;
      c.db.refunds[0].status = flips % 2 ? 'requires_action' : 'pending';
      throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
    });
    c.list([usd('re_1', 4_900)]);
    await expect(c.router.handle(update('refund.updated', 'succeeded'))).rejects.toMatchObject({
      code: 'SFEE_REFUND_STATE_UNAVAILABLE',
    });
    expect(flips).toBe(5);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('without the settlement path a late succeeded never rewrites a failed refund (legacy writer)', async () => {
    const c = setup();
    const legacy = new RefundDisputeHandlerService(
      asPrisma(c.prisma),
      c.stripe,
      new SplitLedgerService(asPrisma(c.prisma)),
      new TransferOrchestratorService(
        asPrisma(c.prisma),
        c.stripe,
        new SplitLedgerService(asPrisma(c.prisma)),
      ),
      new PayoutReadinessService(asPrisma(c.prisma), c.stripe),
      c.fns as object as NotificationsService,
    );
    c.db.refunds.push({
      id: 'rf_1',
      stripe_refund_id: 're_1',
      stripe_charge_id: 'ch_1',
      purchase_id: 'cp_1',
      amount_cents: 4_900,
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
      ledger_reversed: false,
    });
    await legacy.handle({
      id: 'evt_legacy',
      type: 'refund.updated',
      data: { object: { id: 're_1', status: 'succeeded', failure_reason: null } },
    });
    expect(c.db.refunds[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
    });
  });
});

describe('Sol B-684-3: no provider call starts past the run deadline or the notice claim', () => {
  async function notice(c: Ctx, started: number, patch: Row = {}) {
    await c.prisma.payoutAdjustmentNotice.create({
      data: {
        id: 'pan_1',
        idempotency_key: 'pan_key_1',
        payee_user_id: 'coach_1',
        settlement_id: 'cs_1',
        stripe_charge_id: 'ch_1',
        purchase_id: 'cp_1',
        event: 'refund',
        title: 'A client was refunded',
        body: 'A client got $1.00 back.',
        created_at: new Date(started - 120_000),
        ...patch,
      },
    });
  }
  const clockAt = (started: number) => {
    const clock = { now: started };
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    return clock;
  };

  it('the email-attempt write returns past the deadline: no mail, attempt returned, next run mails once', async () => {
    const c = setup();
    const started = Date.now();
    const clock = clockAt(started);
    await notice(c, started, { inapp_status: 'sent', push_status: 'off' });
    const tbl = c.prisma.payoutAdjustmentNotice;
    const real = tbl.updateMany.getMockImplementation() as (a: {
      where: Row;
      data: Row;
    }) => Promise<{ count: number }>;
    tbl.updateMany.mockImplementation(async (args: { where: Row; data: Row }) => {
      const out = await real(args);
      if (args.data.email_attempts === 1) clock.now = started + 660_000;
      return out;
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(c.fns.send).not.toHaveBeenCalled();
    expect(c.db.notices?.[0]).toMatchObject({
      email_status: 'pending',
      email_attempts: 0,
      dispatch_attempts: 0,
      dispatch_claimed_at: null,
    });
    tbl.updateMany.mockImplementation(real);
    clock.now = started + 700_000;
    await c.notices.dispatchPending(new Date(clock.now), 25, clock.now + 480_000);
    expect(c.fns.send).toHaveBeenCalledTimes(1);
    expect(c.fns.send.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'pan_key_1' });
  });

  it('another worker took the email attempt number: this worker sends nothing', async () => {
    const c = setup();
    const started = Date.now();
    clockAt(started);
    await notice(c, started, { inapp_status: 'sent', push_status: 'off' });
    const tbl = c.prisma.payoutAdjustmentNotice;
    const real = tbl.updateMany.getMockImplementation() as (a: {
      where: Row;
      data: Row;
    }) => Promise<{ count: number }>;
    tbl.updateMany.mockImplementation(async (args: { where: Row; data: Row }) => {
      if (args.data.email_attempts === 1) c.db.notices![0].email_attempts = 1;
      return real(args);
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(c.fns.send).not.toHaveBeenCalled();
    expect(c.db.notices?.[0]).toMatchObject({ email_status: 'pending', dispatched_at: null });
  });

  it('the real push token read returns past the claim: Expo is never called, the push waits, next run pushes once', async () => {
    const c = setup();
    const started = Date.now();
    const clock = clockAt(started);
    await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
    const expoSend = jest.fn(async (..._a: unknown[]) => [{ status: 'ok', id: 'tk_1' }]);
    let slow = true;
    const push: NotificationsService = Object.assign(
      Object.create(NotificationsService.prototype),
      {
        prisma: {
          user: {
            findUnique: async () => {
              if (slow) clock.now = started + 660_000;
              return { expo_push_token: 'ExponentPushToken[synthetic-r19-token]' };
            },
          },
        },
        expo: {
          chunkPushNotifications: (m: unknown[]) => [m],
          sendPushNotificationsAsync: expoSend,
          chunkPushNotificationReceiptIds: (ids: unknown[]) => [ids],
          getPushNotificationReceiptsAsync: async () => ({}),
        },
        logger: { error: jest.fn(), warn: jest.fn() },
      },
    );
    c.fns.pushToUser.mockImplementation(async (...a: unknown[]) =>
      push.pushToUser(
        String(a[0]),
        String(a[1]),
        String(a[2]),
        a[3] as Record<string, unknown>,
        a[4] as AbortSignal,
      ),
    );
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(expoSend).not.toHaveBeenCalled();
    expect(c.fns.pushToUser.mock.calls[0][4]).toBeInstanceOf(AbortSignal);
    expect(c.db.notices?.[0]).toMatchObject({
      push_status: 'pending',
      dispatch_attempts: 0,
      dispatch_claimed_at: null,
    });
    slow = false;
    clock.now = started + 700_000;
    await c.notices.dispatchPending(new Date(clock.now), 25, clock.now + 480_000);
    expect(expoSend).toHaveBeenCalledTimes(1);
    expect(c.db.notices?.[0].push_status).toBe('sent');
  });

  it('EmailService: a send-log insert that returns past the claim never reaches the provider; the next attempt mails once', async () => {
    const c = setup({ email: 'real' });
    const started = Date.now();
    const clock = clockAt(started);
    await notice(c, started, { inapp_status: 'sent', push_status: 'off' });
    const real = c.emailLog.create.getMockImplementation() as (a: unknown) => Promise<Row>;
    let slow = true;
    c.emailLog.create.mockImplementation(async (args: unknown) => {
      const row = await real(args);
      if (slow) clock.now = started + 660_000;
      return row;
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480_000);
    expect(c.transport.send).not.toHaveBeenCalled();
    expect(c.emailLog.rows[0]).toMatchObject({
      idempotency_key: 'pan_key_1',
      status: 'failed',
      error: 'aborted before send',
    });
    expect(c.db.notices?.[0]).toMatchObject({
      email_status: 'pending',
      email_attempts: 1,
      dispatch_attempts: 0,
    });
    slow = false;
    clock.now = started + 700_000;
    await c.notices.dispatchPending(new Date(clock.now), 25, clock.now + 480_000);
    expect(c.transport.send).toHaveBeenCalledTimes(1);
    expect(c.transport.send.mock.calls[0][0]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(c.emailLog.rows.map((r) => [r.idempotency_key, r.status])).toEqual([
      ['pan_key_1', 'failed'],
      ['pan_key_1:e2', 'sent'],
    ]);
    expect(c.db.notices?.[0]).toMatchObject({
      email_status: 'sent',
      dispatched_at: expect.any(Date),
    });
  });

  it('the send signal aborts on its timer and on any read past its limit, with the given reason', () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const reason = new Error('window');
      const timed = noticeSendSignal(1_000_500, () => reason);
      const onAbort = jest.fn();
      timed.signal.addEventListener('abort', onAbort);
      expect(timed.signal.aborted).toBe(false);
      jest.advanceTimersByTime(500);
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(timed.signal.reason).toBe(reason);
      const read = noticeSendSignal(1_002_000, () => reason);
      jest.spyOn(Date, 'now').mockReturnValue(1_002_000);
      expect(read.signal.aborted).toBe(true);
      read.release();
      timed.release();
    } finally {
      jest.useRealTimers();
    }
  });
});
