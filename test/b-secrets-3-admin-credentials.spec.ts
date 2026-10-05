// B-SECRETS-3 (#646 C-646-1 Opus + Sol, C-646-2 Sol) — owner / admin routes
// never return the client's cached Stripe PaymentSheet credentials, and the
// log redactor scrubs them by key and by value.
//
// The prisma fake honours `omit` / `select` the way Prisma does, so a route
// that reads the raw row leaks the canaries and fails here.
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { DunningService } from '../src/checkout/dunning.service';
import {
  ADMIN_PURCHASE_OMIT,
  PURCHASE_PAYMENT_SECRET_FIELDS,
} from '../src/checkout/admin-purchase.select';
import { redactLogLine, redactObject } from '../src/observability/log-redaction';
import { Prisma } from '@prisma/client';

const CLIENT_SECRET = 'pi_3Canary_secret_Canary1';
const EPHEMERAL_KEY = 'ek_test_CanaryEphemeral';

function purchaseRow(): Record<string, unknown> {
  return {
    id: 'cp-1',
    client_user_id: 'client-1',
    coach_user_id: 'coach-1',
    package_id: 'pkg-1',
    amount_cents: 10_000,
    currency: 'usd',
    status: 'pending',
    stripe_payment_intent_id: 'pi_3Canary',
    stripe_customer_id: 'cus_1',
    stripe_client_secret: CLIENT_SECRET,
    stripe_ephemeral_key: EPHEMERAL_KEY,
    created_at: new Date('2026-10-01T00:00:00Z'),
  };
}

type ProjectArgs = {
  omit?: Record<string, boolean>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
};

function project(row: Record<string, unknown>, args: ProjectArgs) {
  let out: Record<string, unknown> = { ...row };
  if (args.select) {
    out = Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
  }
  for (const [k, on] of Object.entries(args.omit ?? {})) if (on) delete out[k];
  if (args.include?.package) out.package = { id: 'pkg-1', name: 'Package' };
  return out;
}

function makePrisma() {
  const row = purchaseRow();
  return {
    clientPurchase: {
      findMany: jest.fn(async (args: ProjectArgs) => [project(row, args)]),
      findUnique: jest.fn(async (args: ProjectArgs) => project(row, args)),
    },
    connectTransfer: { findMany: jest.fn(async () => []) },
    dunningState: { findUnique: jest.fn(async () => null) },
    dunningAttempt: { findMany: jest.fn(async () => []) },
    paymentReminder: { findMany: jest.fn(async () => []) },
  };
}

// Test doubles implement only what these routes touch; `fixture` hands them
// to the constructors without a cast token.
function fixture<T>(value: object): T {
  return value as T;
}

type Ctor = ConstructorParameters<typeof AdminPaymentOpsController>;

function makeController(prisma: ReturnType<typeof makePrisma>) {
  const stub = {};
  return new AdminPaymentOpsController(
    fixture<Ctor[0]>(prisma),
    fixture<Ctor[1]>({ resolvePolicy: jest.fn(async () => ({ platform_fee_bps: 200 })) }),
    fixture<Ctor[2]>({ findByPurchase: jest.fn(async () => []) }),
    fixture<Ctor[3]>(stub),
    fixture<Ctor[4]>(stub),
    fixture<Ctor[5]>(stub),
    fixture<Ctor[6]>(stub),
    fixture<Ctor[7]>(stub),
    fixture<Ctor[8]>(stub),
    fixture<Ctor[9]>(stub),
  );
}

function expectNoCredentials(body: unknown) {
  const json = JSON.stringify(body);
  expect(json).not.toContain(CLIENT_SECRET);
  expect(json).not.toContain(EPHEMERAL_KEY);
  expect(json).not.toContain('stripe_client_secret');
  expect(json).not.toContain('stripe_ephemeral_key');
}

describe('B-SECRETS-3 owner / admin purchase reads omit the payment credentials', () => {
  it('GET /v1/admin/payments/purchases', async () => {
    const prisma = makePrisma();
    const body = await makeController(prisma).listPurchases();
    expectNoCredentials(body);
    // Support still sees the Stripe ids.
    expect(body.purchases[0]).toMatchObject({
      stripe_payment_intent_id: 'pi_3Canary',
      stripe_customer_id: 'cus_1',
    });
  });

  it('GET /v1/admin/payments/purchases/:id', async () => {
    const prisma = makePrisma();
    const body = await makeController(prisma).getPurchase('cp-1');
    expectNoCredentials(body);
    expect(body.purchase).toMatchObject({ id: 'cp-1', stripe_payment_intent_id: 'pi_3Canary' });
  });

  it('DunningService.getAdminView (admin dunning drill-down and every admin dunning action)', async () => {
    const prisma = makePrisma();
    const svc = new DunningService(
      fixture<ConstructorParameters<typeof DunningService>[0]>(prisma),
      fixture<ConstructorParameters<typeof DunningService>[1]>({}),
    );
    const view = await svc.getAdminView('cp-1');
    expectNoCredentials(view);
    expect(view.purchase).toMatchObject({ id: 'cp-1' });
  });

  it('ADMIN_PURCHASE_OMIT drops exactly the credential columns', () => {
    expect(Object.keys(ADMIN_PURCHASE_OMIT).sort()).toEqual(
      [...PURCHASE_PAYMENT_SECRET_FIELDS].sort(),
    );
    const columns = Object.values(Prisma.ClientPurchaseScalarFieldEnum) as string[];
    for (const f of PURCHASE_PAYMENT_SECRET_FIELDS) expect(columns).toContain(f);
    // Any other credential-like column added later must be omitted on purpose.
    const credentialLike = columns.filter((c) => /secret|ephemeral|token|password/i.test(c));
    expect(credentialLike.sort()).toEqual([...PURCHASE_PAYMENT_SECRET_FIELDS].sort());
  });
});

describe('B-SECRETS-3 log redaction (#646 C-646-2 Sol)', () => {
  it('redacts the credential keys and any *_secret key in objects', () => {
    const out = redactObject({
      stripe_client_secret: CLIENT_SECRET,
      stripe_ephemeral_key: EPHEMERAL_KEY,
      ephemeral_key: EPHEMERAL_KEY,
      webhook_secret: 'whsec_Canary',
      purchase_id: 'cp-1',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      stripe_client_secret: '[REDACTED]',
      stripe_ephemeral_key: '[REDACTED]',
      ephemeral_key: '[REDACTED]',
      webhook_secret: '[REDACTED]',
      purchase_id: 'cp-1',
    });
  });

  it('scrubs Stripe credential values inside free text, keeping the ids', () => {
    const msg = `PaymentSheet resumed for pi_3Canary with ${CLIENT_SECRET} and ${EPHEMERAL_KEY} (key sk_live_CanaryKey, whsec_CanaryHook)`;
    const fromObject = redactObject({ message: msg }) as { message: string };
    const fromLine = redactLogLine(JSON.stringify({ msg }));
    for (const out of [fromObject.message, fromLine]) {
      expect(out).not.toContain(CLIENT_SECRET);
      expect(out).not.toContain(EPHEMERAL_KEY);
      expect(out).not.toContain('sk_live_CanaryKey');
      expect(out).not.toContain('whsec_CanaryHook');
      expect(out).toContain('pi_3Canary ');
    }
  });

  it('redacts serialised credential keys in a log line', () => {
    const line = JSON.stringify({
      stripe_client_secret: 'opaque',
      stripe_ephemeral_key: 'opaque2',
      id: 'cp-1',
    });
    expect(redactLogLine(line)).toBe(
      '{"stripe_client_secret":"[REDACTED]","stripe_ephemeral_key":"[REDACTED]","id":"cp-1"}',
    );
  });
});
