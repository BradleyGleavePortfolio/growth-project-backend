import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BillingService } from '../src/billing/billing.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { EmailTemplateKey } from '../src/email/email.types';
import { CheckoutRecoveryService } from '../src/storefront/checkout-recovery.service';
import { GuestCheckoutReconciliationService } from '../src/storefront/guest-checkout-reconciliation.service';
import {
  GUEST_CHECKOUT_METADATA_KEY,
  GuestCheckoutService,
} from '../src/storefront/guest-checkout.service';
import { SWITCH_V1_MESSAGE, buyerVerdict } from '../src/storefront/buyer-check';
import { CheckoutIpRateLimiterService } from '../src/storefront/checkout-rate-limiter.service';
import { StorefrontPublicController } from '../src/storefront/storefront-public.controller';

// GUEST-ELIGIBILITY (agent 170; audit LS-1140 item 2; owner #170-2, #169-8,
// #SWITCH-V1). Every buyer case through the code routes' service, the real
// createIntent gate, and the real webhook dispatcher -> conversion.

type Row = Record<string, any>;
const TOKEN = 'tok1234567890abcDEFGH';
const OTHER_TOKEN = 'tokOTHER7890abcDEFGH';
const COACH = 'coach-1';
const SECRET = 'x'.repeat(48);
const KEY = '550e8400-e29b-41d4-a716-446655440000';
const config = { get: (k: string) => (k === 'CHECKOUT_RECOVERY_SECRET' ? SECRET : undefined) };

const ACCOUNTS: Record<string, Row> = {
  'nocoach@example.com': { id: 'u-nc', name: 'Nia Cole Park', role: 'student', coach_id: null },
  'mine@example.com': { id: 'u-me', name: 'Sam Lee', role: 'student', coach_id: COACH },
  'other@example.com': { id: 'u-ot', name: 'Ola Diaz', role: 'student', coach_id: 'coach-2' },
  'house@example.com': { id: 'u-ho', name: 'Hal Moe', role: 'student', coach_id: 'coach-house' },
  'coach@example.com': { id: 'u-co', name: 'Cam Roe', role: 'coach', coach_id: null },
  'sub@example.com': { id: 'u-sc', name: 'Sue Bo', role: 'sub_coach', coach_id: COACH },
  'staff@example.com': { id: 'u-ow', name: 'Ozzy Wu', role: 'owner', coach_id: null },
};

function world(packageCoach = COACH) {
  const sent: Row[] = [];
  const db: Row = {
    accounts: { ...ACCOUNTS },
    sendCount: 0,
    coachPackage: { findUnique: jest.fn(async () => ({ coach_id: packageCoach })) },
    user: {
      findFirst: jest.fn(async (a: Row) => {
        const hit = db.accounts[String(a.where.email.equals).toLowerCase()];
        return hit ? { ...hit } : null;
      }),
    },
    emailSendLog: { count: jest.fn(async () => db.sendCount) },
  };
  const email = { send: jest.fn(async (m: Row) => void sent.push(m)) };
  const recovery = new CheckoutRecoveryService(db as never, config as never, email as never);
  const lastCode = () => String(sent[sent.length - 1]?.data?.code);
  return { db, sent, email, recovery, lastCode };
}

async function rejection(p: Promise<unknown>): Promise<Row> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), ...(err.getResponse() as Row) };
    throw err;
  }
  return { status: 'NO_ERROR' };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

/** check-email then verify-code, as the page does. */
async function prove(w: ReturnType<typeof world>, email: string, token = TOKEN) {
  expect(await w.recovery.checkBuyerEmail(token, email)).toEqual({ account: 'existing' });
  await flush();
  return w.recovery.verifyBuyerCode(token, email, w.lastCode());
}

const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
afterAll(() => [warn, error, log].forEach((s) => s.mockRestore()));

describe('GUEST-ELIGIBILITY — who may buy on the web page', () => {
  it.each([
    ['new email', null, 'new'],
    ['existing, no coach', ACCOUNTS['nocoach@example.com'], 'no_coach'],
    ['client of this coach', ACCOUNTS['mine@example.com'], 'same_coach'],
    ['client of another coach', ACCOUNTS['other@example.com'], 'other_coach'],
    ['coach', ACCOUNTS['coach@example.com'], 'not_client'],
    ['sub-coach', ACCOUNTS['sub@example.com'], 'not_client'],
    ['owner / staff', ACCOUNTS['staff@example.com'], 'not_client'],
  ])('%s -> %s', (_label, account, verdict) => {
    expect(buyerVerdict(account as never, COACH)).toBe(verdict);
  });

  it("house coach's package: the same one-coach rule (another coach's client is refused)", () => {
    expect(buyerVerdict(ACCOUNTS['other@example.com'] as never, 'coach-house')).toBe('other_coach');
    expect(buyerVerdict(ACCOUNTS['house@example.com'] as never, 'coach-house')).toBe('same_coach');
  });
});

describe('GUEST-ELIGIBILITY — the email code (check-email, verify-code)', () => {
  it('a new email: { account: new }, no email, same response shape as existing', async () => {
    const w = world();
    const res = await w.recovery.checkBuyerEmail(TOKEN, 'fresh@example.com');
    await flush();
    expect(res).toEqual({ account: 'new' });
    expect(w.email.send).not.toHaveBeenCalled();
    const existing = await w.recovery.checkBuyerEmail(TOKEN, 'other@example.com');
    expect(Object.keys(existing)).toEqual(Object.keys(res)); // no name, coach or package before the code
  });

  it('an existing email gets a 6-digit code by email (template, first name, idempotency key)', async () => {
    const w = world();
    await w.recovery.checkBuyerEmail(TOKEN, 'NoCoach@Example.com');
    await flush();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      to: 'nocoach@example.com',
      template: EmailTemplateKey.BUYER_EMAIL_CODE,
      data: { first_name: 'Nia' },
    });
    expect(w.lastCode()).toMatch(/^\d{6}$/);
    expect(w.sent[0].idempotencyKey).toMatch(/^buyer-code:[0-9a-f]{32}:\d+$/);
    expect(JSON.stringify(w.sent[0].idempotencyKey)).not.toContain('nocoach');
  });

  it('right code: first name only + summary kind + a proof; the code is single use', async () => {
    const w = world();
    const ok = await prove(w, 'nocoach@example.com');
    expect(ok).toMatchObject({ verified: true, first_name: 'Nia', summary: 'no_coach' });
    expect(typeof ok.buyer_token).toBe('string');
    const again = await rejection(w.recovery.verifyBuyerCode(TOKEN, 'nocoach@example.com', w.lastCode()));
    expect(again).toMatchObject({ status: 400, error: 'BUYER_CODE_INVALID' });
  });

  it('client of this coach: summary same_coach (the one-coach policy summary)', async () => {
    expect(await prove(world(), 'mine@example.com')).toMatchObject({ first_name: 'Sam', summary: 'same_coach' });
  });

  it('wrong code is refused; five tries burn the code, even the right one after', async () => {
    const w = world();
    await w.recovery.checkBuyerEmail(TOKEN, 'mine@example.com');
    await flush();
    const right = w.lastCode();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      expect(await rejection(w.recovery.verifyBuyerCode(TOKEN, 'mine@example.com', wrong))).toMatchObject({
        error: 'BUYER_CODE_INVALID',
      });
    }
    expect(await rejection(w.recovery.verifyBuyerCode(TOKEN, 'mine@example.com', right))).toMatchObject({
      error: 'BUYER_CODE_INVALID',
    });
  });

  it('a code expires after 10 minutes', async () => {
    const w = world();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await w.recovery.checkBuyerEmail(TOKEN, 'mine@example.com');
    await flush();
    clock.mockReturnValue(now + 10 * 60_000 + 1);
    expect(await rejection(w.recovery.verifyBuyerCode(TOKEN, 'mine@example.com', w.lastCode()))).toMatchObject({
      error: 'BUYER_CODE_INVALID',
    });
    clock.mockRestore();
  });

  it('a code for one package does not open another package', async () => {
    const w = world();
    await w.recovery.checkBuyerEmail(TOKEN, 'mine@example.com');
    await flush();
    expect(await rejection(w.recovery.verifyBuyerCode(OTHER_TOKEN, 'mine@example.com', w.lastCode()))).toMatchObject({
      error: 'BUYER_CODE_INVALID',
    });
  });

  it('per email: no 4th code email inside the hour (EmailSendLog count), answer unchanged', async () => {
    const w = world();
    w.db.sendCount = 3;
    expect(await w.recovery.checkBuyerEmail(TOKEN, 'mine@example.com')).toEqual({ account: 'existing' });
    await flush();
    expect(w.email.send).not.toHaveBeenCalled();
  });

  it.each([
    ['client of another coach', 'other@example.com', 'BUYER_HAS_COACH', SWITCH_V1_MESSAGE],
    ['coach', 'coach@example.com', 'BUYER_NOT_CLIENT', undefined],
    ['sub-coach', 'sub@example.com', 'BUYER_NOT_CLIENT', undefined],
    ['owner / staff', 'staff@example.com', 'BUYER_NOT_CLIENT', undefined],
  ])('%s: refused only after the right code, no proof', async (_l, email, code, message) => {
    const w = world();
    const res = await rejection(prove(w, email));
    expect(res).toMatchObject({ status: 409, error: code });
    if (message) expect(res.message).toBe(message);
    expect(res).not.toHaveProperty('buyer_token');
  });

  it("house coach's package refuses a client of another coach (#SWITCH-V1)", async () => {
    const res = await rejection(prove(world('coach-house'), 'other@example.com'));
    expect(res).toMatchObject({ status: 409, error: 'BUYER_HAS_COACH', message: SWITCH_V1_MESSAGE });
  });

  it('per IP: the 11th check-email or verify-code in an hour is 429 with Retry-After', async () => {
    const limiter = new CheckoutIpRateLimiterService({ get: () => undefined } as never);
    const recovery = { checkBuyerEmail: jest.fn(async () => ({ account: 'new' })), verifyBuyerCode: jest.fn() };
    const ctl = new StorefrontPublicController({} as never, {} as never, recovery as never, config as never, limiter, {} as never, {} as never);
    const req = { headers: { 'fly-client-ip': '203.0.113.7' } } as never;
    const res = { setHeader: jest.fn() };
    for (let i = 0; i < 10; i += 1) await ctl.checkBuyerEmail(TOKEN, { guest_email: `a${i}@example.com` }, req, res as never);
    expect(await rejection(ctl.checkBuyerEmail(TOKEN, { guest_email: 'b@example.com' }, req, res as never))).toMatchObject({ status: 429, error: 'TOO_MANY_REQUESTS' });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(recovery.checkBuyerEmail).toHaveBeenCalledTimes(10);
    for (let i = 0; i < 10; i += 1) await ctl.verifyBuyerCode(TOKEN, { guest_email: 'b@example.com', code: '000000' }, req, res as never);
    expect(await rejection(ctl.verifyBuyerCode(TOKEN, { guest_email: 'b@example.com', code: '000000' }, req, res as never))).toMatchObject({ status: 429 });
    expect(recovery.verifyBuyerCode).toHaveBeenCalledTimes(10);
  });
});

// The real createIntent (b-guestpay-127 module shape) on a minimal database.
async function buyPage(accounts: Record<string, Row>) {
  const stripe = {
    createPaymentIntent: jest.fn(async () => ({ id: 'pi_guest', client_secret: 'pi_guest_secret' })),
  };
  const account = {
    coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true,
    payouts_enabled: true, details_submitted: true, disabled_reason: null, deauthorized_at: null,
    requirements_due: { currently_due: [], past_due: [], eventually_due: [] },
  };
  const pkg = {
    id: 'pkg-1', coach_id: COACH, name: '12-Week Transformation', description: null,
    amount_cents: 29700, currency: 'usd', billing_type: 'one_time', interval: null, interval_count: 1,
    recurring_amount_cents: null, recurring_interval: null, is_active: true, archived_at: null,
    published_at: new Date('2026-09-01'), share_token: TOKEN, share_link_enabled: true,
    share_link_expires_at: null, share_link_revoked_at: null,
    coach: { id: COACH, name: 'Coach One', deletion_scheduled_at: null, deleted_at: null, profile: null, coach_profile: null, connect_account: account },
  };
  const prisma = {
    coachPackage: { findUnique: jest.fn(async () => pkg) },
    coachLandingPage: { findFirst: jest.fn(async () => null) },
    user: { findFirst: jest.fn(async (a: Row) => accounts[String(a.where.email.equals)] ?? null) },
    guestCheckout: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'gc-1', idempotency_key: KEY })),
      update: jest.fn(async () => ({ id: 'gc-1' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GuestCheckoutService,
      { provide: PrismaService, useValue: prisma },
      { provide: StripeConnectApiService, useValue: stripe },
      { provide: SupabaseService, useValue: {} },
      { provide: ConfigService, useValue: config },
      { provide: NotificationsService, useValue: {} },
      { provide: CheckoutService, useValue: {} },
      { provide: FeePolicyService, useValue: {} },
    ],
  }).compile();
  return { svc: moduleRef.get(GuestCheckoutService), stripe, prisma };
}
const dto = (email: string, buyer_token?: string) => ({
  guest_name: 'Jane Smith', guest_phone: '+14155550100', guest_email: email, idempotency_key: KEY, buyer_token,
});

describe('GUEST-ELIGIBILITY — createIntent refuses before any PaymentIntent', () => {
  it('new email: no check, the PaymentIntent is minted (#170-2)', async () => {
    const { svc, stripe } = await buyPage({});
    expect(await svc.createIntent(TOKEN, dto('fresh@example.com'))).toMatchObject({ payment_intent_id: 'pi_guest' });
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('existing email without a proof: BUYER_CODE_REQUIRED, no row, no Stripe call', async () => {
    const { svc, stripe, prisma } = await buyPage(ACCOUNTS);
    expect(await rejection(svc.createIntent(TOKEN, dto('mine@example.com')))).toMatchObject({
      status: 403, error: 'BUYER_CODE_REQUIRED',
    });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.guestCheckout.create).not.toHaveBeenCalled();
  });

  it.each(['nocoach@example.com', 'mine@example.com'])('%s with a fresh proof: the PaymentIntent is minted', async (email) => {
    const w = world();
    const { buyer_token } = await prove(w, email);
    const { svc, stripe } = await buyPage(ACCOUNTS);
    await svc.createIntent(TOKEN, dto(email, buyer_token));
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("a proof for another email or another package doesn't count", async () => {
    const w = world();
    const { buyer_token } = await prove(w, 'nocoach@example.com');
    const { svc, stripe } = await buyPage(ACCOUNTS);
    expect(await rejection(svc.createIntent(TOKEN, dto('mine@example.com', buyer_token)))).toMatchObject({ error: 'BUYER_CODE_REQUIRED' });
    const other = await prove(world(), 'mine@example.com', OTHER_TOKEN);
    expect(await rejection(svc.createIntent(TOKEN, dto('mine@example.com', other.buyer_token)))).toMatchObject({ error: 'BUYER_CODE_REQUIRED' });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('eligibility changed after the code (account got another coach): #SWITCH-V1, no PaymentIntent', async () => {
    const w = world();
    const { buyer_token } = await prove(w, 'nocoach@example.com');
    const { svc, stripe } = await buyPage({ 'nocoach@example.com': { ...ACCOUNTS['nocoach@example.com'], coach_id: 'coach-2' } });
    expect(await rejection(svc.createIntent(TOKEN, dto('nocoach@example.com', buyer_token)))).toMatchObject({
      status: 409, error: 'BUYER_HAS_COACH', message: SWITCH_V1_MESSAGE,
    });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('an expired proof (past 30 minutes) is refused', async () => {
    const w = world();
    const { buyer_token } = await prove(w, 'mine@example.com');
    const { svc } = await buyPage(ACCOUNTS);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(Date.now() + 31 * 60_000);
    try {
      expect(await rejection(svc.createIntent(TOKEN, dto('mine@example.com', buyer_token)))).toMatchObject({ error: 'BUYER_CODE_REQUIRED' });
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Settlement: real BillingService -> GuestCheckoutService on a small in-memory DB ──
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, c]) => {
    const v = row[k];
    if (c === null) return v == null;
    if (c instanceof Date) return v instanceof Date && v.getTime() === c.getTime();
    if (typeof c === 'object') {
      const t = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c && v === c.not) return false;
      if ('gt' in c && !(v != null && t(v) > t(c.gt))) return false;
      if ('lt' in c && !(v != null && t(v) < t(c.lt))) return false;
      if ('equals' in c && String(v).toLowerCase() !== String(c.equals).toLowerCase()) return false;
      return true;
    }
    return v === c;
  });
}

function settlementWorld() {
  const tables: Record<string, Row[]> = {
    stripeProcessedEvent: [], guestCheckout: [], user: [], clientPurchase: [], connectAccount: [],
    clientOnboardingIntake: [], notification: [],
  };
  const pkg = { id: 'pkg-1', coach_id: COACH, name: '12-Week Transformation', amount_cents: 29700, currency: 'usd', billing_type: 'one_time', coach: { id: COACH, name: 'Coach One' } };
  let seq = 0;
  const model = (name: string) => ({
    findUnique: async (a: Row) => {
      const r = tables[name].find((x) => matches(x, a.where));
      return r ? { ...r, ...(name === 'guestCheckout' && a.include?.package ? { package: pkg } : {}) } : null;
    },
    findFirst: async (a: Row) => {
      const r = tables[name].find((x) => matches(x, a?.where));
      return r ? { ...r, ...(name === 'guestCheckout' && a?.include?.package ? { package: pkg } : {}) } : null;
    },
    findMany: async (a: Row) => tables[name].filter((x) => matches(x, a?.where)).map((x) => ({ ...x })),
    create: async (a: Row) => {
      const row = { id: `${name}-${++seq}`, ...a.data };
      tables[name].push(row);
      return { ...row };
    },
    updateMany: async (a: Row) => {
      const hit = tables[name].filter((x) => matches(x, a.where));
      hit.forEach((x) => Object.assign(x, a.data));
      return { count: hit.length };
    },
    update: async (a: Row) => Object.assign(tables[name].find((x) => matches(x, a.where)) as Row, a.data),
    upsert: async (a: Row) => {
      const r = tables[name].find((x) => matches(x, a.where));
      if (r) return { ...Object.assign(r, a.update) };
      const row = { id: `${name}-${++seq}`, ...a.create };
      tables[name].push(row);
      return { ...row };
    },
  });
  const prisma: Row = {};
  for (const n of Object.keys(tables)) prisma[n] = model(n);
  // A thrown callback rolls back in place (row objects keep their identity).
  prisma.$transaction = async (cb: (t: Row) => Promise<unknown>) => {
    const snap = Object.entries(tables).map(([n, rows]) => [n, rows.map((r) => [r, { ...r }])] as const);
    try {
      return await cb(prisma);
    } catch (err) {
      for (const [n, pairs] of snap) {
        tables[n].splice(0, tables[n].length, ...pairs.map(([r, c]) => {
          for (const k of Object.keys(r)) delete r[k];
          return Object.assign(r, c);
        }));
      }
      throw err;
    }
  };
  tables.connectAccount.push({ id: 'ca-1', coach_user_id: COACH, stripe_account_id: 'acct_c' });
  const listUsers: Row[] = [];
  const supabase = {
    getClient: () => ({
      auth: {
        admin: {
          createUser: async (a: Row) =>
            listUsers.some((u) => u.email === a.email)
              ? { data: { user: null }, error: { message: 'A user with this email address has already been registered' } }
              : { data: { user: { id: `sb-new-${++seq}`, email: a.email } }, error: null },
          generateLink: async () => ({ data: { properties: { action_link: 'https://auth.example.com/invite' } }, error: null }),
          listUsers: async () => ({ data: { users: listUsers }, error: null }),
        },
      },
    }),
  };
  const stripe = {
    retrievePaymentIntent: async (id: string) => ({ id, latest_charge: `ch_${id}` }),
    retrieveCharge: async (id: string) => ({ id, receipt_url: null }),
    retrieveSubscription: async (id: string) => ({ id, status: 'active' }),
  };
  const notifications = { createNotification: jest.fn(async () => undefined) };
  // The fan-out keeps today's rule: it refuses another coach's client.
  const fanout = {
    onPurchaseEntitled: jest.fn(async (_p: Row, ctx: Row) => {
      const u = tables.user.find((x) => x.id === ctx.clientId);
      if (u?.coach_id && u.coach_id !== ctx.coachId) throw new Error('CROSS_COACH_REFUSED');
    }),
    flushAlerts: jest.fn(),
    discardPendingAlerts: jest.fn(),
  };
  const guest: GuestCheckoutService = Reflect.construct(GuestCheckoutService, [
    prisma, stripe, supabase, { get: () => undefined }, notifications, {}, {}, undefined, undefined, fanout, undefined,
  ]);
  const welcome: Row[] = [];
  Reflect.set(guest, 'sendWelcomeEmail', async (c: Row, invite: string | null) => void welcome.push({ id: c.id, invite }));
  const billing: BillingService = Reflect.construct(BillingService, [
    prisma, { capture: jest.fn(), identify: jest.fn() }, { write: jest.fn(async () => undefined), list: jest.fn(async () => []) },
    undefined, { handle: jest.fn(async () => ({ claimed: false })), settleGuestPurchase: jest.fn(async () => undefined) },
    undefined, guest,
  ]);
  const reconciler = new GuestCheckoutReconciliationService(prisma as never, guest);
  const seed = (pi: string, email: string): Row => {
    const row: Row = {
      id: `gc-${pi}`, idempotency_key: `idem-${pi}`, guest_email: email, guest_name: 'Guest Buyer',
      package_id: 'pkg-1', stripe_payment_intent_id: pi, stripe_subscription_id: null, stripe_customer_id: 'cus_g',
      landing_page_id: null, status: 'pending', expires_at: new Date(Date.now() + 3_600_000),
      created_at: new Date(Date.now() - 300_000), retry_count: 0, last_retry_at: null, last_error: null,
      receipt_url: null, created_user_id: null,
    };
    tables.guestCheckout.push(row);
    return row;
  };
  const account = (email: string, coachId: string | null) => {
    listUsers.push({ id: `sb-${email}`, email });
    tables.user.push({ id: `user-${email}`, supabase_id: `sb-${email}`, email, name: 'Ola Diaz', role: 'student', coach_id: coachId });
  };
  const paid = (pi: string) =>
    billing.handleEvent({
      id: `evt_${pi}`, type: 'payment_intent.succeeded',
      data: { object: { id: pi, metadata: { [GUEST_CHECKOUT_METADATA_KEY]: `idem-${pi}` }, latest_charge: `ch_${pi}` } },
    } as never);
  return { tables, notifications, welcome, guest, reconciler, seed, account, paid };
}

describe('GUEST-ELIGIBILITY — settlement keeps the one-coach boundary (signed-webhook dispatcher -> conversion)', () => {
  it('new email: converted, invite link sent (the confirm email)', async () => {
    const s = settlementWorld();
    const row = s.seed('pi_new', 'fresh@example.com');
    await s.paid('pi_new');
    expect(row.status).toBe('converted');
    expect(s.welcome).toEqual([{ id: row.id, invite: 'https://auth.example.com/invite' }]);
  });

  it('existing, no coach: converted and attached to this coach', async () => {
    const s = settlementWorld();
    s.account('nocoach@example.com', null);
    const row = s.seed('pi_nc', 'nocoach@example.com');
    await s.paid('pi_nc');
    expect(row.status).toBe('converted');
    expect(s.tables.user[0].coach_id).toBe(COACH);
    expect(s.tables.clientPurchase).toHaveLength(1);
  });

  it('account gained another coach after the check: held for refund, lasting, coach told, never retried', async () => {
    const s = settlementWorld();
    s.account('other@example.com', 'coach-2');
    const row = s.seed('pi_ot', 'other@example.com');
    await s.paid('pi_ot');
    expect(row).toMatchObject({
      status: 'conversion_failed_terminal',
      last_error: 'buyer_has_other_coach',
      retry_count: 5,
    });
    expect(s.tables.clientPurchase).toHaveLength(0);
    expect(s.tables.user[0].coach_id).toBe('coach-2');
    expect(s.notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(s.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: COACH,
        payload: expect.objectContaining({ event: 'guest_purchase_held_for_refund', payment_intent_id: 'pi_ot' }),
      }),
    );
    expect(s.welcome).toEqual([]);
    await s.reconciler.run();
    await s.reconciler.run();
    expect(row.status).toBe('conversion_failed_terminal');
    expect(s.tables.clientPurchase).toHaveLength(0);
    // The named refund path: Stripe refund -> charge.refunded -> 'refunded'.
    await s.guest.handleChargeRefunded('pi_ot', 29700, 29700);
    expect(row.status).toBe('refunded');
  });
});
