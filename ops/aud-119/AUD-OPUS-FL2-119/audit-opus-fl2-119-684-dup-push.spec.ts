// Opus FL2-119 probe (never merge): C-684-13 evidence. An abort that lands after Expo accepted
// the push reports aborted, so the notice re-pushes on the next run (at least once, duplicate).
import type { ClientPurchase } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
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

afterEach(() => jest.restoreAllMocks());

describe('Opus FL2-119 C-684-13: abort after Expo accepted', () => {
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
  it('Expo accepts, then the send window closes before pushToUser returns: the next run pushes again', async () => {
    const c = setup();
    const started = Date.now();
    const clock = { now: started };
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
    let slow = true;
    const expoSend = jest.fn(async (..._a: unknown[]) => {
      if (slow) clock.now = started + 660_000; // accepted, but returns after the claim ended
      return [{ status: 'ok', id: 'tk_1' }];
    });
    const push: NotificationsService = Object.assign(
      Object.create(NotificationsService.prototype),
      {
        prisma: {
          user: {
            findUnique: async () => ({ expo_push_token: 'ExponentPushToken[synthetic-fl2-token]' }),
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
    expect(expoSend).toHaveBeenCalledTimes(1);
    expect(c.db.notices?.[0].push_status).toBe('pending');
    slow = false;
    clock.now = started + 700_000;
    await c.notices.dispatchPending(new Date(clock.now), 25, clock.now + 480_000);
    // Documents the C: the coach's device receives the same payout push twice.
    expect(expoSend).toHaveBeenCalledTimes(2);
    expect(c.db.notices?.[0].push_status).toBe('sent');
  });
});
