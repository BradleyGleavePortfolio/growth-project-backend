import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CheckoutWebhookHandlerService } from '../../src/checkout/checkout-webhook-handler.service';
import { DunningService } from '../../src/checkout/dunning.service';
import { DunningV2Service } from '../../src/checkout/dunning-v2/dunning-v2.service';
import { DunningV2Dispatcher } from '../../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../../src/checkout/dunning-v2/dunning-v2.renderer';
import { DunningV2Telemetry } from '../../src/checkout/dunning-v2/dunning-v2.telemetry';
import { DunningLockoutGuard } from '../../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../../src/checkout/dunning-v2/dunning-v2.cadence';
import { ClientEntitlementGuard } from '../../src/common/guards/client-entitlement.guard';
import { ConnectService } from '../../src/connect/connect.service';
import { FakePrisma } from './dunning-v2-fake-prisma';

/**
 * PF-7-BE harness: the REAL webhook handler, v1 + v2 dunning, dispatcher,
 * guards and ConnectService over the in-memory FakePrisma; Stripe, push,
 * email and coach alerts are recording mocks. The hold service is loaded by
 * path so this file also compiles against main (the first test is red there).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stub = (v: unknown): any => v;

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const T0 = new Date('2026-10-05T16:00:00.000Z');
export const at = (ms: number) => new Date(T0.getTime() + ms);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

const FIXTURES = join(__dirname, '..', 'fixtures', 'stripe', 'dunning-v2');
let eventSeq = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fixture(name: string, object: Record<string, unknown> = {}): any {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  eventSeq += 1;
  return {
    ...raw,
    id: `${raw.id}_pf7_${eventSeq}`,
    data: { ...raw.data, object: { ...raw.data.object, ...object } },
  };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The coach's account as Stripe reports it now (what a fresh read sees). */
export interface StripeAccountState {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  disabled_reason: string | null;
  unreachable?: boolean;
}

export const READY: StripeAccountState = {
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  disabled_reason: null,
};
export const RESTRICTED: StripeAccountState = {
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: true,
  disabled_reason: 'requirements.past_due',
};

class FakeController {
  handler(): void {}
}

function ctxFor(path: string, user?: { id: string; role: string }, method = 'GET') {
  const req = { path, user, method };
  return stub({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => FakeController.prototype.handler,
    getClass: () => FakeController,
  });
}

function loadHold(): { CoachAccountHoldService: new (...args: unknown[]) => unknown } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../src/checkout/dunning-v2/coach-account-hold.service');
  } catch {
    return null;
  }
}

export function buildWorld(opts: { saved?: StripeAccountState; stripeNow?: StripeAccountState } = {}) {
  const fake = new FakePrisma();
  const prisma = fake.client();
  const account = { value: { ...(opts.stripeNow ?? READY) } };
  const stripe = {
    retrieveSubscription: jest.fn(async (id: string) => ({
      id,
      status: 'past_due',
      current_period_end: sec(at(30 * DAY)),
      canceled_at: null,
    })),
    retrieveInvoice: jest.fn(async (id: string) => ({ id, status: 'open', amount_remaining: 15000 })),
    retrievePaymentMethod: jest.fn(async () => ({ card: { last4: '4242' } })),
    cancelSubscription: jest.fn(async () => ({ status: 'canceled' })),
    pauseSubscriptionCollection: jest.fn(async () => ({ status: 'active' })),
    listOpenInvoices: jest.fn(async () => [{ id: 'in_dv2_renewal_1', status: 'open' }]),
    retryInvoiceOffSession: jest.fn(async (args: { invoiceId: string; idempotencyKey: string }) => ({
      id: args.invoiceId,
      status: 'paid',
    })),
    retrieveAccount: jest.fn(async (id: string) => {
      if (account.value.unreachable) throw new Error('stripe unreachable');
      const a = account.value;
      return {
        id,
        country: 'US',
        default_currency: 'usd',
        charges_enabled: a.charges_enabled,
        payouts_enabled: a.payouts_enabled,
        details_submitted: a.details_submitted,
        requirements: a.disabled_reason ? { disabled_reason: a.disabled_reason } : null,
      };
    }),
  };
  const push = jest.fn(async () => true);
  const email = jest.fn(async () => ({ status: 'sent' }));
  const coachAlert = jest.fn(async () => undefined);
  const notifications = {
    pushToUser: push,
    pushToCoach: jest.fn(async () => true),
    createNotification: jest.fn(async (n: { user_id: string; kind: string; body: string }) =>
      fake.seed('notification', { ...n, read_at: null, created_at: new Date() }),
    ),
  };
  const telemetry = new DunningV2Telemetry();
  const dispatcher = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    telemetry,
    stub(notifications),
    stub({ send: email }),
    stub({ emit: coachAlert }),
  );
  const v2 = new DunningV2Service(prisma, telemetry, dispatcher, stub(stripe));
  const v1 = new DunningService(prisma, stub(stripe));
  const handler = new CheckoutWebhookHandlerService(
    prisma,
    stub(stripe),
    undefined,
    v1,
    undefined,
    undefined,
    undefined,
    v2,
  );
  const connect = new ConnectService(prisma, stub(stripe));
  const mod = loadHold();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hold: any = mod
    ? new mod.CoachAccountHoldService(
        prisma,
        stub(stripe),
        v2,
        connect,
        stub({ emit: coachAlert }),
        stub({ send: email }),
      )
    : null;
  if (hold) Reflect.set(handler, 'coachHold', hold);
  const lockGuard = new DunningLockoutGuard(prisma);
  const entitlementGuard = new ClientEntitlementGuard(prisma, new Reflector());

  fake.seed('user', { id: 'coach-1', name: 'Morgan Coach', email: 'coach@tgp.invalid', role: 'coach' });
  fake.seed('user', { id: 'client-1', name: 'Avery Client', email: 'client@tgp.invalid', role: 'student' });
  fake.seed('user', { id: 'client-3', name: 'Rowan Second', email: 'second@tgp.invalid', role: 'student' });
  fake.seed('coachPackage', {
    id: 'pkg-1',
    coach_user_id: 'coach-1',
    billing_type: 'recurring',
    interval: 'month',
    duration_days: null,
    price_cents: 15000,
  });
  fake.seed('connectCustomer', {
    id: 'cc-1',
    client_user_id: 'client-1',
    stripe_customer_id: 'cus_dv2_client',
    default_card_last4: '0341',
  });
  fake.seed('notificationPreferences', { id: 'np-1', user_id: 'client-1', timezone: 'America/Los_Angeles' });
  fake.seed('notificationPreferences', { id: 'np-c', user_id: 'coach-1', timezone: 'America/Los_Angeles' });
  const saved = opts.saved ?? READY;
  fake.seed('connectAccount', {
    id: 'ca-1',
    coach_user_id: 'coach-1',
    stripe_account_id: 'acct_pf7_coach',
    country: 'US',
    default_currency: 'usd',
    charges_enabled: saved.charges_enabled,
    payouts_enabled: saved.payouts_enabled,
    details_submitted: saved.details_submitted,
    disabled_reason: saved.disabled_reason,
    deauthorized_at: null,
  });
  for (const [id, client, sub] of [
    ['purchase-1', 'client-1', 'sub_dv2_client'],
    ['purchase-3', 'client-3', 'sub_pf7_second'],
  ] as const) {
    fake.seed('clientPurchase', {
      id,
      client_user_id: client,
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      status: 'active',
      entitlement_active: true,
      billing_type: 'recurring',
      amount_cents: 15000,
      currency: 'usd',
      stripe_subscription_id: sub,
      stripe_payment_intent_id: `pi_${id}`,
      access_expires_at: at(0),
      current_period_end: at(0),
    });
  }

  const client = { id: 'client-1', role: 'student' };
  return {
    fake,
    prisma,
    handler,
    v2,
    hold,
    stripe,
    account,
    push,
    email,
    coachAlert,
    async fail(sub = 'sub_dv2_client', attempt = 1) {
      await handler.handle(
        fixture('invoice.payment_failed', {
          subscription: sub,
          attempt_count: attempt,
          id: sub === 'sub_dv2_client' ? 'in_dv2_renewal_1' : 'in_pf7_second',
        }),
      );
      await flush();
    },
    state(purchaseId = 'purchase-1') {
      return fake.find('dunningState', { purchase_id: purchaseId });
    },
    purchase(purchaseId = 'purchase-1') {
      return fake.find('clientPurchase', { id: purchaseId });
    },
    clientPushes() {
      return push.mock.calls.filter((c) => (c as unknown[])[0] === 'client-1').length;
    },
    clientEmails() {
      return email.mock.calls.filter(
        (c) => ((c as unknown[])[0] as { to?: string }).to === 'client@tgp.invalid',
      ).length;
    },
    async entitled(): Promise<'allowed' | 402> {
      try {
        await entitlementGuard.canActivate(ctxFor('/api/v1/workouts', client));
        return 'allowed';
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 402) return 402;
        throw err;
      }
    },
    async lockVerdict(path = '/api/v1/workouts'): Promise<'allowed' | 'LOCKED_DUNNING'> {
      try {
        await lockGuard.canActivate(ctxFor(path, client));
        return 'allowed';
      } catch (err) {
        if (err instanceof ForbiddenException) {
          const body = err.getResponse() as { code?: string };
          if (body.code === LOCKED_DUNNING_CODE) return 'LOCKED_DUNNING';
        }
        throw err;
      }
    },
  };
}

export type HoldWorld = ReturnType<typeof buildWorld>;
