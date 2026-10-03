// OR-112-19 — the client's own purchase list never carries a Stripe client
// secret, ephemeral key or any other internal Stripe field, and the coach
// purchase feed (GET /v1/coach/purchases) never carries the client's.
//
// The Prisma double behaves like Prisma: with a `select` it returns only the
// selected fields; WITHOUT one it returns the FULL stored row, including the
// cached PaymentIntent client_secret and ephemeral key. Before this fix
// (ea919f6b) GET /v1/checkout/purchases and GET /v1/coach/purchases both
// returned raw rows, so these assertions fail there.
//
// Mobile (growth-project-mobile main) never reads a secret from a purchase
// row: ClientPurchase in src/api/clientPaymentsApi.ts types only the fields in
// MOBILE_READ_FIELDS below. A payment that still needs client action resumes
// through POST /v1/checkout/payment-intent with the same idempotency key,
// which replays the cached secret to its owner only (last test).

import 'reflect-metadata';
import { CheckoutController, CoachPurchasesController } from '../src/checkout/checkout.controller';
import { CheckoutService } from '../src/checkout/checkout.service';
import { CLIENT_PURCHASE_SELECT } from '../src/checkout/client-purchases.select';
import { COACH_FORBIDDEN_FIELD_PATTERN } from '../src/checkout/coach-payments.select';

const CLIENT = 'client-1';
const COACH = 'coach-1';
const SECRET_SETTLED = 'pi_3SETTLED_secret_PLANTEDvalue';
const SECRET_PENDING = 'pi_3PENDING_secret_PLANTEDvalue';
const EPHEMERAL_KEY = 'ek_live_PLANTED_ephemeral';

// Fields the mobile app reads from GET /v1/checkout/purchases rows.
const MOBILE_READ_FIELDS = [
  'id',
  'package_id',
  'status',
  'entitlement_active',
  'access_expires_at',
  'current_period_end',
  'cancel_at_period_end',
  'canceled_at',
  'created_at',
] as const;

type Row = Record<string, unknown>;

function fullPurchase(over: Row): Row {
  return {
    id: 'p-x',
    client_user_id: CLIENT,
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
    status: 'paid',
    entitlement_active: true,
    access_expires_at: null,
    current_period_end: new Date('2026-11-01T00:00:00Z'),
    cancel_at_period_end: false,
    canceled_at: null,
    idempotency_key: 'idem_PLANTED',
    stripe_client_secret: SECRET_SETTLED,
    stripe_ephemeral_key: EPHEMERAL_KEY,
    last_error: null,
    created_at: new Date('2026-09-04T00:00:00Z'),
    updated_at: new Date('2026-09-04T00:00:00Z'),
    landing_page_id: 'lp_PLANTED',
    contract_envelope_id: 'env_PLANTED',
    source: null,
    grant_metadata: null,
    ...over,
  };
}

// Newest first, as the service orders them.
const STORED: Row[] = [
  // Settled native PaymentIntent purchase — secret still cached on the row.
  fullPurchase({ id: 'p-paid', status: 'paid' }),
  // Still awaiting client action (PaymentIntent requires_payment_method /
  // requires_action): the row is `pending` with the cached secret.
  fullPurchase({
    id: 'p-pending',
    status: 'pending',
    entitlement_active: false,
    current_period_end: null,
    stripe_client_secret: SECRET_PENDING,
    created_at: new Date('2026-09-03T00:00:00Z'),
  }),
  fullPurchase({
    id: 'p-canceled',
    status: 'canceled',
    entitlement_active: false,
    cancel_at_period_end: true,
    canceled_at: new Date('2026-09-02T12:00:00Z'),
    created_at: new Date('2026-09-02T00:00:00Z'),
  }),
  // $0 grant row: synthetic session id + internal grant metadata.
  fullPurchase({
    id: 'p-grant',
    amount_cents: 0,
    billing_type: 'one_time',
    status: 'active',
    stripe_checkout_session_id: 'grant_PLANTED',
    stripe_payment_intent_id: null,
    stripe_client_secret: null,
    stripe_ephemeral_key: null,
    source: 'free_package_claim',
    grant_metadata: { invite_code_id: 'code_PLANTED', granted_by: 'coach_PLANTED' },
    created_at: new Date('2026-09-01T00:00:00Z'),
  }),
  // Another client of the same coach — never in client-1's list.
  fullPurchase({
    id: 'p-other-client',
    client_user_id: 'client-2',
    stripe_client_secret: 'pi_3OTHER_secret_PLANTEDvalue',
    created_at: new Date('2026-08-31T00:00:00Z'),
  }),
];

function project(row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

function buildPrisma() {
  return {
    clientPurchase: {
      findMany: jest.fn(
        async (args: {
          where: Row;
          take?: number;
          cursor?: { id: string };
          skip?: number;
          select?: Row;
        }) => {
          let rows = STORED.filter((p) => Object.entries(args.where).every(([k, v]) => p[k] === v));
          if (args.cursor) {
            const at = rows.findIndex((p) => p.id === args.cursor?.id);
            rows = rows.slice(at + (args.skip ?? 0));
          }
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          return rows.map((p) => project(p, args.select));
        },
      ),
      findUnique: jest.fn(async (args: { where: { idempotency_key: string } }) => {
        const p = STORED.find((x) => x.idempotency_key === args.where.idempotency_key);
        return p ? { ...p } : null;
      }),
    },
    user: {
      findUnique: jest.fn(async () => ({
        id: CLIENT,
        email: 'client@example.test',
        name: 'Client',
        coach_id: COACH,
      })),
    },
  };
}

function buildService(prisma: ReturnType<typeof buildPrisma>): CheckoutService {
  const packages = {
    getById: jest.fn(async () => ({
      id: 'pkg-1',
      coach_id: COACH,
      is_active: true,
      archived_at: null,
      published_at: new Date('2026-08-01T00:00:00Z'),
      amount_cents: 4900,
    })),
  };
  const stripe = { createPaymentIntent: jest.fn(), createEphemeralKey: jest.fn() };
  return Reflect.construct(CheckoutService, [prisma, stripe, packages, { ready: true }, {}, {}]);
}

/** Every key path in a JSON-serialised response whose name looks secret or internal. */
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(COACH_FORBIDDEN_FIELD_PATTERN.test(k) || /_secret$|_key$/i.test(k)
        ? [`${path}.${k}`]
        : []),
      ...forbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

function assertNoSecrets(response: unknown): void {
  const json = JSON.stringify(response);
  expect(json).not.toContain('_secret_');
  expect(json).not.toContain(EPHEMERAL_KEY);
  expect(json).not.toContain('PLANTED');
  expect(forbiddenKeys(JSON.parse(json))).toEqual([]);
}

const clientReq = { user: { id: CLIENT, role: 'student' } };
const coachReq = { user: { id: COACH, role: 'coach' } };

type ListOut = { purchases: Row[]; next_cursor: string | null };

// The real controller methods, called the way Nest calls them (req, cursor, limit).
async function clientList(
  prisma: ReturnType<typeof buildPrisma>,
  cursor?: string,
  limit?: string,
): Promise<ListOut> {
  const ctrl = new CheckoutController(buildService(prisma));
  return Reflect.apply(ctrl.listPurchases, ctrl, [clientReq, cursor, limit]);
}

async function coachList(prisma: ReturnType<typeof buildPrisma>): Promise<ListOut> {
  const ctrl = new CoachPurchasesController(buildService(prisma));
  return Reflect.apply(ctrl.list, ctrl, [coachReq]);
}

describe('OR-112-19 — purchase lists send no Stripe client secrets', () => {
  it('GET /v1/checkout/purchases: settled, pending, canceled and grant rows carry no secret or internal Stripe field', async () => {
    const prisma = buildPrisma();
    const out = await clientList(prisma);

    expect(out.purchases.map((p) => p.id)).toEqual([
      'p-paid',
      'p-pending',
      'p-canceled',
      'p-grant',
    ]);
    expect(out.next_cursor).toBeNull();
    assertNoSecrets(out);
    // The query itself asks for the allow-list, not the raw row.
    expect(prisma.clientPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: CLIENT_PURCHASE_SELECT,
        where: { client_user_id: CLIENT },
      }),
    );
  });

  it('GET /v1/checkout/purchases keeps every field the mobile app reads, with the stored values', async () => {
    const out = await clientList(buildPrisma());

    for (const row of out.purchases) {
      const stored: Row = STORED.find((p) => p.id === row.id) ?? {};
      for (const f of MOBILE_READ_FIELDS) expect(row).toHaveProperty(f, stored[f]);
    }
    expect(out.purchases[1]).toMatchObject({
      id: 'p-pending',
      status: 'pending',
      entitlement_active: false,
    });
    expect(out.purchases[3]).toMatchObject({
      id: 'p-grant',
      source: 'free_package_claim',
      amount_cents: 0,
    });
  });

  it('GET /v1/checkout/purchases pagination still works on the allow-listed rows', async () => {
    const prisma = buildPrisma();
    const page1 = await clientList(prisma, undefined, '2');
    expect(page1.purchases.map((p) => p.id)).toEqual(['p-paid', 'p-pending']);
    expect(page1.next_cursor).toBe('p-pending');
    const page2 = await clientList(prisma, page1.next_cursor ?? undefined, '2');
    expect(page2.purchases.map((p) => p.id)).toEqual(['p-canceled', 'p-grant']);
    expect(page2.next_cursor).toBeNull();
    assertNoSecrets([page1, page2]);
  });

  it('GET /v1/coach/purchases (coach revenue feed) carries none of the client secrets', async () => {
    const out = await coachList(buildPrisma());

    expect(out.purchases.map((p) => p.id)).toEqual([
      'p-paid',
      'p-pending',
      'p-canceled',
      'p-grant',
      'p-other-client',
    ]);
    expect(out.purchases[0]).toMatchObject({
      client_user_id: CLIENT,
      amount_cents: 4900,
      status: 'paid',
    });
    assertNoSecrets(out);
  });

  it('the client allow-list names no secret-like field and covers every mobile-read field', () => {
    const keys = Object.keys(CLIENT_PURCHASE_SELECT);
    expect(
      keys.filter((k) => COACH_FORBIDDEN_FIELD_PATTERN.test(k) || /_secret$|_key$/i.test(k)),
    ).toEqual([]);
    for (const f of MOBILE_READ_FIELDS) expect(keys).toContain(f);
  });

  it('resume path: POST /v1/checkout/payment-intent replay still hands the cached secret to its owner', async () => {
    const prisma = buildPrisma();
    const svc = buildService(prisma);
    STORED[1].idempotency_key = `pi-${CLIENT}-11111111-1111-4111-8111-111111111111`;
    try {
      const out = await svc.createPaymentIntentForClient(CLIENT, {
        package_id: 'pkg-1',
        idempotency_key: '11111111-1111-4111-8111-111111111111',
      });
      expect(out.client_secret).toBe(SECRET_PENDING);
      expect(out.ephemeral_key).toBe(EPHEMERAL_KEY);
    } finally {
      STORED[1].idempotency_key = 'idem_PLANTED';
    }
  });
});
