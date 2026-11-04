import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runInNewContext } from 'vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { User } from '@prisma/client';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';

// Independent review evidence, not a product fix. These fixture files are
// unmodified git-archive copies from mobile main 6e90289f and paired
// mobile #925 at 4c1dfb7e. Execute the actual pure reader
// and copy function, not a reimplementation or a guessed phone shape.
const phoneCache = new Map<string, Record<string, unknown>>();
function phoneModule(relative: string, phone: string): Record<string, unknown> {
  const file = join(__dirname, `ls1216-mobile-${phone}/src`, relative);
  const cached = phoneCache.get(file);
  if (cached) return cached;
  const source = readFileSync(file, 'utf8');
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  });
  const exports: Record<string, unknown> = {};
  phoneCache.set(file, exports);
  runInNewContext(
    outputText,
    {
      exports,
      require: (specifier: string) => {
        const dependency = resolve(dirname(file), `${specifier}.ts`);
        const root = join(__dirname, `ls1216-mobile-${phone}/src`);
        if (dependency.startsWith(root) && existsSync(dependency)) {
          return phoneModule(dependency.slice(root.length + 1), phone);
        }
        // Unexercised HTTP, setup-error, and requirement-label dependencies
        // are inert. All reader, state, date and money logic is original.
        return {};
      },
      Date,
      Intl,
    },
    { filename: file },
  );
  return exports;
}

const COACH = 'ls1216-review-coach';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const at = new Date('2026-10-30T09:00:00Z');

interface Options {
  cancelAtPeriodEnd?: boolean;
  paused?: boolean;
  readFailure?: boolean;
  refundedCents?: number;
}

function world(status: string, held: boolean, paidBefore: boolean, options: Options = {}) {
  const row = {
    id: 'p1', coach_user_id: COACH, client_user_id: CLIENT, package_id: 'pkg',
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring', status,
    stripe_subscription_id: 'sub_1', created_at: at, current_period_end: at,
    access_expires_at: at, cancel_at_period_end: options.cancelAtPeriodEnd ?? false, entitlement_active: true,
    package: { name: 'Monthly coaching' },
    dunning: {
      status: 'active', step_index: -1,
      last_failure_reason: held ? 'coach_account_not_ready' : 'card_declined',
    },
    refunds: options.refundedCents ? [{
      id: 'review-refund', stripe_charge_id: 'ch_earlier',
      amount_cents: options.refundedCents, status: 'succeeded',
      initiated_by_user_id: COACH, created_at: at,
    }] : [],
    settlements: paidBefore ? [{
      stripe_charge_id: 'ch_earlier', currency: 'usd', gross_cents: 14900,
      refunded_cents: options.refundedCents ?? 0, dispute_withdrawn_cents: 0,
      created_at: new Date('2026-09-30T09:00:00Z'),
    }] : [],
  };
  const stripe = {
    retrieveSubscription: jest.fn(async () => {
      if (options.readFailure) throw new Error('review-only unreadable subscription');
      return { id: 'sub_1', status, pause_collection: options.paused ? { behavior: 'void' } : null };
    }),
  };
  const prisma = {
    clientPurchase: { findMany: jest.fn(async () => [row]) },
    user: { findMany: jest.fn(async () => []) },
  };
  const feePolicy = { resolveHeadCoachId: jest.fn(async () => null) };
  const service: CoachClientPaymentsService = Reflect.construct(
    CoachClientPaymentsService,
    [prisma, stripe, {}, {}, feePolicy, { write: jest.fn() }],
  );
  return { service };
}

async function visibleLine(status: string, held: boolean, paidBefore: boolean, phone: string, options: Options = {}) {
  const phoneApi = phoneModule('api/coachClientPaymentsApi.ts', phone);
  const phoneCopy = phoneModule('lib/money/clientPaymentsCopy.ts', phone);
  const { service } = world(status, held, paidBefore, options);
  const actor = { id: COACH, role: 'coach' } as User;
  const [raw] = (await service.list(actor, CLIENT)).plans;
  const parsed: unknown = Reflect.apply(
    Reflect.get(phoneApi, 'toPlan'), null, [JSON.parse(JSON.stringify(raw))],
  );
  const line: unknown = Reflect.apply(
    Reflect.get(phoneCopy, 'planStateLine'), null, [parsed, 'Sam'],
  );
  return { raw, parsed, line };
}

describe.each(['main', 'paired'])('LS-1216 B1 phone=%s: coach hold must not become the current phone failure claim', (phone) => {
  it.each([
    ['past_due', false], ['unpaid', false],
    ['past_due', true], ['unpaid', true],
  ])('held status=%s paidBefore=%s: no client payment failure sentence', async (status, paidBefore) => {
    const { raw, parsed, line } = await visibleLine(String(status), true, Boolean(paidBefore), phone);
    expect(Reflect.get(raw, 'waiting_on')).toBe('coach_account');
    expect(raw).toMatchObject({
      status, billing: 'running', actions: { pause: false, cancel: true },
    });
    expect(line).not.toContain('The latest payment did not go through');
    expect(line).toBe('Waiting on your Stripe account.');
    expect(parsed).toMatchObject({
      purchaseId: raw.purchase_id, packageName: raw.package_name, billingType: raw.billing_type,
      status: raw.status, amountCents: raw.amount_cents, currency: raw.currency,
      currentPeriodEnd: raw.current_period_end, accessExpiresAt: raw.access_expires_at,
      cancelAtPeriodEnd: raw.cancel_at_period_end, billing: raw.billing,
      waitingOn: 'coach_account', actions: raw.actions,
    });
    expect(Reflect.get(parsed as object, 'payments')).toHaveLength(paidBefore ? 1 : 0);
  });

  it.each(['past_due', 'unpaid'])('real card failure %s: keep existing claim', async (status) => {
    const { raw, line } = await visibleLine(status, false, true, phone);
    expect(Reflect.get(raw, 'waiting_on')).toBeNull();
    expect(line).toContain('The latest payment did not go through');
  });
});

describe('LS-1216 regression phone=paired: actual nested parser and existing billing precedence', () => {
  it('keeps every nested payment and refund field, and the held cancellation still ends now', async () => {
    const { raw, parsed, line } = await visibleLine('past_due', true, true, 'paired', { refundedCents: 1000 });
    const payment = raw.payments[0];
    expect(Reflect.get(parsed as object, 'payments')).toEqual([{
      chargeId: payment.charge_id, amountCents: payment.amount_cents,
      refundedCents: payment.refunded_cents, refundableCents: payment.refundable_cents,
      currency: payment.currency, paidAt: payment.paid_at,
      refunds: payment.refunds.map((refund) => ({ amountCents: refund.amount_cents, status: refund.status })),
    }]);
    expect(payment).toMatchObject({ amount_cents: 14900, refunded_cents: 1000, refundable_cents: 13900 });
    expect(line).toBe('Waiting on your Stripe account.');
    const copy = phoneModule('lib/money/clientPaymentsCopy.ts', 'paired');
    const confirm = Reflect.apply(Reflect.get(copy, 'confirmCopy'), null, ['cancel', parsed, 'Sam']);
    expect(confirm.body).toContain('The plan ends now and unpaid invoices are voided');
    expect(confirm.body).toContain("Sam's access to Monthly coaching ends.");
    expect(confirm.body).not.toContain('failed');
  });

  it.each([
    ['past_due', { paused: true }, 'paused', 'Billing is paused. Nothing is charged while it is paused, and Sam keeps access.'],
    ['past_due', { readFailure: true }, 'unknown', 'The billing state could not be read just now. Pull down to refresh.'],
    ['canceled', {}, 'ended', 'This plan has ended. Nothing more is charged.'],
  ])('status=%s options=%j preserves billing=%s', async (status, options, billing, expected) => {
    const { raw, line } = await visibleLine(String(status), true, true, 'paired', options as Options);
    expect(Reflect.get(raw, 'billing')).toBe(billing);
    expect(line).toBe(expected);
    expect(line).not.toContain('failed');
  });

  it('keeps a scheduled cancellation ahead of the hold marker', async () => {
    const { raw, line } = await visibleLine('past_due', true, true, 'paired', { cancelAtPeriodEnd: true });
    expect(Reflect.get(raw.actions, 'cancel')).toBe(false);
    expect(Reflect.get(raw, 'waiting_on')).toBe('coach_account');
    expect(line).toContain('Canceled. Sam keeps access until');
    expect(line).toContain('nothing more is charged.');
    expect(line).not.toContain('Waiting');
  });
});
