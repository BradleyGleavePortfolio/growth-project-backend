// C-641-2 — coach-facing payments routes never send the client's Stripe
// secrets (or other internal Stripe fields) to the coach.
//
// The Prisma double below behaves like Prisma: with a `select` it returns
// only the selected fields; WITHOUT one it returns the FULL stored row,
// including the client's cached PaymentIntent client_secret and ephemeral
// key. So a route that forgets its allow-list fails here (this spec fails
// on main before the fix: GET /v1/coach/payments/purchases, /purchases/:id,
// /failed, /earnings and /v1/coach/packages/:id/subscribers all returned
// raw rows).

import 'reflect-metadata';
import { CoachPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { PackagesService } from '../src/packages/packages.service';
import {
  COACH_DUNNING_SELECT,
  COACH_FORBIDDEN_FIELD_PATTERN,
  COACH_LEDGER_SELECT,
  COACH_PURCHASE_SELECT,
  COACH_TRANSFER_SELECT,
} from '../src/checkout/coach-payments.select';

const COACH = 'coach-1';
const CLIENT_SECRET = 'pi_3PLANTED_secret_PLANTEDvalue';
const EPHEMERAL_KEY = 'ek_live_PLANTED_ephemeral';

type Row = Record<string, unknown>;

function project(row: Row, select: Row | undefined, relations: Record<string, () => unknown>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (!v) continue;
    if (typeof v === 'object' && relations[k]) {
      const related = relations[k]();
      const spec = v as { select?: Row };
      out[k] = Array.isArray(related)
        ? related.map((r) => project(r as Row, spec.select, {}))
        : related
          ? project(related as Row, spec.select, {})
          : null;
    } else {
      out[k] = row[k];
    }
  }
  return out;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v && typeof v === 'object') return true; // operators are not under test here
    return row[k] === v;
  });
}

function fullPurchase(over: Row = {}): Row {
  return {
    id: 'p1',
    client_user_id: 'client-1',
    coach_user_id: COACH,
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_checkout_session_id: 'cs_PLANTED',
    stripe_payment_intent_id: 'pi_PLANTED',
    stripe_subscription_id: 'sub_PLANTED',
    stripe_customer_id: 'cus_PLANTED',
    stripe_destination_account: 'acct_PLANTED',
    status: 'past_due',
    entitlement_active: true,
    access_expires_at: null,
    current_period_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    idempotency_key: 'idem_PLANTED',
    stripe_client_secret: CLIENT_SECRET,
    stripe_ephemeral_key: EPHEMERAL_KEY,
    last_error: 'Your card was declined.',
    created_at: new Date('2026-09-01T00:00:00Z'),
    updated_at: new Date('2026-09-02T00:00:00Z'),
    landing_page_id: null,
    contract_envelope_id: null,
    source: null,
    grant_metadata: { note: 'PLANTED' },
    ...over,
  };
}

function buildPrisma() {
  const purchases = [fullPurchase(), fullPurchase({ id: 'p2', status: 'payment_failed' })];
  const ledger: Row[] = [
    {
      id: 'l1',
      purchase_id: 'p1',
      kind: 'destination',
      payee_user_id: COACH,
      payee_stripe_account_id: 'acct_PLANTED',
      amount_cents: 4802,
      currency: 'usd',
      status: 'posted',
      stripe_charge_id: 'ch_1',
      stripe_application_fee_id: 'fee_PLANTED',
      stripe_transfer_id: 'tr_1',
      reversed_cents: 0,
      idempotency_key: 'idem_ledger_PLANTED',
      last_error: null,
      posted_at: new Date(),
      reversed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];
  const transfers: Row[] = [
    {
      id: 't1',
      purchase_id: 'p1',
      ledger_entry_id: 'l1',
      destination_stripe_account_id: 'acct_PLANTED',
      destination_user_id: 'head-1',
      amount_cents: 100,
      currency: 'usd',
      source_stripe_charge_id: 'ch_1',
      stripe_transfer_id: 'tr_2',
      status: 'succeeded',
      idempotency_key: 'idem_transfer_PLANTED',
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];
  const dunning: Row = {
    id: 'd1',
    purchase_id: 'p1',
    status: 'active',
    failure_count: 1,
    step_index: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const purchaseRelations = (p: Row) => ({
    dunning: () => (p.id === 'p1' ? dunning : null),
  });
  const withInclude = (p: Row, include: Row | undefined): Row =>
    include?.dunning ? { ...p, dunning: p.id === 'p1' ? dunning : null } : { ...p };
  return {
    clientPurchase: {
      findMany: jest.fn(async (args: { where?: Row; select?: Row; include?: Row }) =>
        purchases
          .filter((p) => matches(p, args.where))
          .map((p) =>
            args.select
              ? project(p, args.select, purchaseRelations(p))
              : withInclude(p, args.include),
          ),
      ),
      findFirst: jest.fn(async (args: { where?: Row; select?: Row }) => {
        const p = purchases.find((x) => matches(x, args.where));
        return p ? project(p, args.select, purchaseRelations(p)) : null;
      }),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async (args: { where?: Row; select?: Row }) =>
        ledger.filter((r) => matches(r, args.where)).map((r) => project(r, args.select, {})),
      ),
      groupBy: jest.fn(async () => []),
    },
    connectTransfer: {
      findMany: jest.fn(async (args: { where?: Row; select?: Row }) =>
        transfers.filter((r) => matches(r, args.where)).map((r) => project(r, args.select, {})),
      ),
    },
    dunningState: {
      findUnique: jest.fn(async (args: { select?: Row }) => project(dunning, args.select, {})),
    },
    coachPackage: {
      findFirst: jest.fn(async () => ({ id: 'pkg-1', coach_id: COACH })),
    },
  };
}

/** Every key path in a JSON-serialised response whose name looks secret. */
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(COACH_FORBIDDEN_FIELD_PATTERN.test(k) ? [`${path}.${k}`] : []),
      ...forbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

function assertNoSecrets(response: unknown): void {
  const json = JSON.stringify(response);
  expect(json).not.toContain(CLIENT_SECRET);
  expect(json).not.toContain(EPHEMERAL_KEY);
  expect(json).not.toContain('PLANTED');
  expect(forbiddenKeys(JSON.parse(json))).toEqual([]);
}

function controller(prisma: ReturnType<typeof buildPrisma>): CoachPaymentOpsController {
  return Reflect.construct(CoachPaymentOpsController, [prisma, {}, {}, {}, {}]);
}

const req = (role: 'coach' | 'owner' = 'coach') => ({ user: { id: COACH, role } });

describe('C-641-2 — coach payments routes send no client Stripe secrets', () => {
  it('GET /v1/coach/payments/purchases', async () => {
    const prisma = buildPrisma();
    const out = await Reflect.apply(controller(prisma).listOwn, controller(prisma), [req(), {}]);
    expect(out.purchases).toHaveLength(2);
    expect(out.purchases[0]).toMatchObject({ id: 'p1', amount_cents: 4900, status: 'past_due' });
    assertNoSecrets(out);
  });

  it('GET /v1/coach/payments/purchases/:id (coach and owner)', async () => {
    for (const role of ['coach', 'owner'] as const) {
      const prisma = buildPrisma();
      const ctrl = controller(prisma);
      const out = await Reflect.apply(ctrl.getOwn, ctrl, [req(role), 'p1']);
      expect(out.purchase.id).toBe('p1');
      expect(out.split_ledger[0]).toMatchObject({ kind: 'destination', amount_cents: 4802 });
      expect(out.transfers[0]).toMatchObject({ amount_cents: 100, status: 'succeeded' });
      expect(out.dunning).toMatchObject({ status: 'active', failure_count: 1 });
      assertNoSecrets(out);
    }
  });

  it('GET /v1/coach/payments/failed', async () => {
    const prisma = buildPrisma();
    const ctrl = controller(prisma);
    const out = await Reflect.apply(ctrl.failedOnRoster, ctrl, [req()]);
    expect(out.failed.map((p: Row) => p.id)).toEqual(['p1', 'p2']);
    expect(out.failed[0].dunning).toMatchObject({ status: 'active' });
    assertNoSecrets(out);
  });

  it('GET /v1/coach/payments/earnings', async () => {
    const prisma = buildPrisma();
    const ctrl = controller(prisma);
    const out = await Reflect.apply(ctrl.earnings, ctrl, [req(), {}]);
    expect(out.entries[0]).toMatchObject({ id: 'l1', amount_cents: 4802, status: 'posted' });
    assertNoSecrets(out);
  });

  it('GET /v1/coach/packages/:id/subscribers', async () => {
    const prisma = buildPrisma();
    const svc: PackagesService = Reflect.construct(PackagesService, [prisma, {}]);
    prisma.clientPurchase.findMany.mockClear();
    const out = await svc.listSubscribers(COACH, 'pkg-1', { limit: 50 });
    expect(out.subscribers.length).toBeGreaterThan(0);
    assertNoSecrets(out);
  });

  it('the allow-lists themselves name no secret-like field', () => {
    for (const select of [
      COACH_PURCHASE_SELECT,
      COACH_LEDGER_SELECT,
      COACH_TRANSFER_SELECT,
      COACH_DUNNING_SELECT,
    ]) {
      expect(Object.keys(select).filter((k) => COACH_FORBIDDEN_FIELD_PATTERN.test(k))).toEqual([]);
    }
    // The pattern really catches the fields that leaked before the fix.
    for (const k of [
      'stripe_client_secret',
      'stripe_ephemeral_key',
      'idempotency_key',
      'stripe_customer_id',
      'stripe_checkout_session_id',
      'stripe_payment_intent_id',
      'payment_method_details',
    ]) {
      expect(COACH_FORBIDDEN_FIELD_PATTERN.test(k)).toBe(true);
    }
  });
});
