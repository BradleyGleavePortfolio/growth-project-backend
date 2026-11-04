import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runInNewContext } from 'vm';
import { transpileModule, JsxEmit, ModuleKind, ScriptTarget } from 'typescript';
import type { User } from '@prisma/client';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// Independent review evidence, not a product fix. These fixture files are
// unmodified git-archive copies from m#925 at
// 4c1dfb7e1b9ef235b02f8fe4c0fe580b99358f3f. Execute the actual pure reader
// and copy function, not a reimplementation or a guessed phone shape.
const phoneCache = new Map<string, Record<string, unknown>>();
let chargeWire: unknown = null;
let screenData: unknown = null;
function phoneModule(relative: string, version = 'ls1216-mobile-main'): Record<string, unknown> {
  const root = join(__dirname, version, 'src');
  const file = join(root, relative);
  const cached = phoneCache.get(file);
  if (cached) return cached;
  const source = readFileSync(file, 'utf8');
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React },
  });
  const exports: Record<string, unknown> = {};
  phoneCache.set(file, exports);
  runInNewContext(
    outputText,
    {
      exports,
      require: (specifier: string) => {
        if (specifier === 'react') return {
          default: { createElement: (type: unknown, props: unknown, ...children: unknown[]) =>
            ({ type, props, children }) },
          useMemo: (make: () => unknown) => make(),
        };
        if (specifier === 'react-native') return Object.fromEntries(
          ['ActivityIndicator', 'ScrollView', 'Text', 'TouchableOpacity', 'View'].map((s) => [s, s]),
        );
        if (specifier === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
        if (specifier.endsWith('ThemeProvider')) return { useTheme: () => ({ colors: {} }) };
        if (specifier === './MoneyScreen') return { makeStyles: () => ({}) };
        if (specifier === './useSection') return { useSection: () => ({ data: screenData }) };
        if (specifier.endsWith('/services/api')) return {
          default: { get: async () => ({ data: chargeWire }) },
        };
        for (const extension of ['.ts', '.tsx']) {
          const dependency = resolve(dirname(file), `${specifier}${extension}`);
          if (dependency.startsWith(root) && existsSync(dependency)) {
            return phoneModule(dependency.slice(root.length + 1), version);
          }
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

const phoneApi = phoneModule('api/coachClientPaymentsApi.ts');
const phoneCopy = phoneModule('lib/money/clientPaymentsCopy.ts');
const COACH = 'ls1216-review-coach';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const at = new Date('2026-10-30T09:00:00Z');

function world(status: string, held: boolean, paidBefore: boolean, withRefund = false) {
  const row = {
    id: 'p1', coach_user_id: COACH, client_user_id: CLIENT, package_id: 'pkg',
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring', status,
    stripe_subscription_id: 'sub_1', created_at: at, current_period_end: at,
    access_expires_at: at, cancel_at_period_end: false, entitlement_active: true,
    package: { name: 'Monthly coaching' },
    dunning: {
      status: 'active', step_index: -1,
      last_failure_reason: held ? 'coach_account_not_ready' : 'card_declined',
    },
    refunds: withRefund ? [{
      id: 'review-refund', stripe_charge_id: 'ch_earlier', amount_cents: 1299,
      status: 'succeeded', created_at: at, initiated_by_user_id: COACH,
    }] : [],
    settlements: paidBefore ? [{
      stripe_charge_id: 'ch_earlier', currency: 'usd', gross_cents: 14900,
      refunded_cents: 0, dispute_withdrawn_cents: 0,
      created_at: new Date('2026-09-30T09:00:00Z'),
    }] : [],
  };
  const stripe = {
    retrieveSubscription: jest.fn(async () => ({
      id: 'sub_1', status, pause_collection: null,
    })),
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
  return { service, stripe, row };
}

async function visibleLine(status: string, held: boolean, paidBefore: boolean) {
  const { service } = world(status, held, paidBefore);
  const actor = { id: COACH, role: 'coach' } as User;
  const [raw] = (await service.list(actor, CLIENT)).plans;
  const parsed: unknown = Reflect.apply(
    Reflect.get(phoneApi, 'toPlan'), null, [JSON.parse(JSON.stringify(raw))],
  );
  const line: unknown = Reflect.apply(
    Reflect.get(phoneCopy, 'planStateLine'), null, [parsed],
  );
  return { raw, parsed, line };
}

describe('LS-1216 B1: coach hold must not become the current phone failure claim', () => {
  it.each([
    ['past_due', false], ['unpaid', false],
    ['past_due', true], ['unpaid', true],
  ])('held status=%s paidBefore=%s: no client payment failure sentence', async (status, paidBefore) => {
    const { raw, line } = await visibleLine(String(status), true, Boolean(paidBefore));
    expect(Reflect.get(raw, 'waiting_on')).toBe('coach_account');
    expect(raw).toMatchObject({
      status, billing: 'running', actions: { pause: false, cancel: true },
    });
    expect(line).not.toContain('The latest payment did not go through');
    expect(line).toBe('Waiting on your Stripe account.');
  });

  it.each(['past_due', 'unpaid'])('real card failure %s: keep existing claim', async (status) => {
    const { raw, line } = await visibleLine(status, false, true);
    expect(Reflect.get(raw, 'waiting_on')).toBeNull();
    expect(line).toContain('The latest payment did not go through');
  });

  it('every m925 plan and nested payment/refund field decodes from the real server reply', async () => {
    const { service } = world('past_due', true, true, true);
    const [raw] = (await service.list({ id: COACH, role: 'coach' } as User, CLIENT)).plans;
    const parsed: unknown = Reflect.apply(
      Reflect.get(phoneApi, 'toPlan'), null, [JSON.parse(JSON.stringify(raw))],
    );
    expect(parsed).toEqual({
      purchaseId: 'p1', packageName: 'Monthly coaching', billingType: 'recurring',
      status: 'past_due', amountCents: 14900, currency: 'usd',
      currentPeriodEnd: at.toISOString(), accessExpiresAt: at.toISOString(),
      cancelAtPeriodEnd: false, billing: 'running', waitingOn: 'coach_account',
      actions: { refund: true, pause: false, resume: false, cancel: true, restart: false },
      payments: [{
        chargeId: 'ch_earlier', amountCents: 14900, refundedCents: 1299,
        refundableCents: 13601, currency: 'usd', paidAt: '2026-09-30T09:00:00.000Z',
        refunds: [{ amountCents: 1299, status: 'succeeded' }],
      }],
    });
  });
});

function textIn(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textIn).join(' ');
  if (node && typeof node === 'object') return textIn(Reflect.get(node, 'children'));
  return '';
}

async function chargeScreen(status: string, paidBefore: boolean, version: string) {
  const { row } = world(status, true, paidBefore);
  const prisma = {
    clientPurchase: { findFirst: jest.fn(async () => ({
      ...row, source: null, client: { id: CLIENT, name: 'Review client' },
      package: { id: 'pkg', name: 'Monthly coaching', interval: 'month', interval_count: 1 },
      refunds: [], disputes: [], splits: paidBefore ? [{ id: 'review-prior-slice' }] : [],
    })) },
    splitLedgerEntry: { findMany: jest.fn(async () => paidBefore ? [{
      kind: 'destination', payee_user_id: COACH, amount_cents: 14900,
      reversed_cents: 0, status: 'posted', purchase_id: row.id, currency: 'usd',
    }] : []) },
    user: { findMany: jest.fn(async () => []) },
  };
  const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
  chargeWire = JSON.parse(JSON.stringify(await service.getChargeBreakdown(COACH, row.id)));
  const api = Reflect.get(phoneModule('api/coachMoneyApi.ts', version), 'coachMoneyApi');
  screenData = await Reflect.apply(Reflect.get(api, 'charge'), api, [row.id]);
  const screen = Reflect.get(
    phoneModule('screens/coach/money/MoneyChargeScreen.tsx', version), 'default',
  );
  const rendered: unknown = Reflect.apply(screen, null, [{
    navigation: { goBack: jest.fn() }, route: { params: { chargeId: row.id } },
  }]);
  return { text: textIn(rendered), data: screenData };
}

describe('LS-1216R2: real backend reply through actual phone charge reader and screen', () => {
  it.each([
    ['past_due', false], ['unpaid', false], ['past_due', true], ['unpaid', true],
  ] as const)('m925 held %s paidBefore=%s: waiting, with truthful history', async (status, paidBefore) => {
    const { text, data } = await chargeScreen(status, paidBefore, 'ls1216-mobile-main');
    expect(data).toMatchObject({
      charge: { state: 'pending', waitingOn: 'coach_account' }, settled: paidBefore,
    });
    expect(text).toContain('1 renewal is waiting on your Stripe account.');
    expect(text).not.toContain('Latest payment failed');
    expect(text).not.toContain('No money moved');
    if (paidBefore) {
      expect(text).toContain('This plan so far');
      expect(text).toContain('Clients paid so far');
      expect(text).not.toContain('No payment has gone through for this yet');
    } else {
      expect(text).toContain('No payment has gone through for this yet');
      expect(text).not.toContain('This plan so far');
    }
  });

  it.each(['past_due', 'unpaid'])('pre-m920 %s documents backend-first history misread', async (status) => {
    const { text, data } = await chargeScreen(status, true, 'ls1216-pre920');
    expect(data).toMatchObject({ charge: { state: 'pending' }, settled: true });
    expect(text).toContain('Not paid yet');
    expect(text).toContain('No payment has gone through for this yet');
    expect(text).not.toContain('This plan so far');
    expect(text).not.toContain('1 renewal is waiting on your Stripe account.');
  });
});
