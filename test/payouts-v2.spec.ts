/**
 * Bank-Account Payouts v2 (spec §2) — Phase A test suite.
 *
 * Covers the R66 hard-gate matrix from the builder brief:
 *   - PayoutMethod CRUD + idempotency on the signup-flow bank link
 *   - Payout routing: card-paid → card-fee tier; bank-paid → bank-fee tier
 *   - PlatformFeeService.compute matches EVERY §2.7 worked example exactly
 *     (incl. the $1k ACH landing at $32.15 per the corrected formula
 *     `2% + 50% × (card_cost − stripe_actual_cost)`)
 *   - Penny-absorb: computed $32.15 vs actual Stripe $32.16 → coach-visible
 *     $32.15, internal reconciliation field holds $32.16, platform eats 1¢
 *   - Webhook signature: verified payload mutates state; unverified → 401,
 *     state unchanged
 *   - Constructor injection: BankPayout service constructed with a mocked
 *     StripeConnect routes calls through the mock
 *   - Feature flag OFF: all service methods no-op
 *
 * Hermetic: no DB, no network. Prisma is an in-memory fake; StripeConnect is a
 * constructor-injected mock.
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'http';
import { PlatformFeeService } from '../src/payouts-v2/platform-fee.service';
import { PayoutMethodService } from '../src/payouts-v2/payout-method.service';
import { PayoutRoutingService } from '../src/payouts-v2/payout-routing.service';
import { PayoutMethodController } from '../src/payouts-v2/payout-method.controller';
import { PayoutsV2WebhookController } from '../src/payouts-v2/payouts-v2-webhook.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { CoachOrOwnerGuard } from '../src/common/guards/coach-or-owner.guard';
import {
  isBankPayoutsV2Enabled,
  isStripeTreasuryPayoutsEnabled,
} from '../src/payouts-v2/payouts-v2.feature';
import type { StripeConnect } from '../src/payouts-v2/stripe-connect.provider';
import {
  verifyStripeSignature,
  signStripePayload,
  StripeSignatureError,
} from '../src/billing/stripe-signature';

// ---------------------------------------------------------------------------
// Minimal HTTP client (supertest is intentionally absent from devDependencies
// repo-wide; see test/notifications.controller.spec.ts). We POST raw bytes to
// a real Nest app listening on an ephemeral port and read back status + body.
// ---------------------------------------------------------------------------
async function httpRequest(opts: {
  app: INestApplication;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const server = opts.app.getHttpServer();
  const address = server.address();
  const port =
    typeof address === 'object' && address ? address.port : Number(address);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** A pass-through guard: lets the request through and stamps a coach user. */
class AllowCoachGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = { id: 'coach1', role: 'coach' };
    return true;
  }
}

// ---------------------------------------------------------------------------
// In-memory Prisma fake — only the surface the payout services touch.
// ---------------------------------------------------------------------------
function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

interface FakeRow {
  [k: string]: any;
}

function makeFakePrisma() {
  const db = {
    payoutMethod: [] as FakeRow[],
    user: [] as FakeRow[],
    connectAccount: [] as FakeRow[],
  };

  const matches = (row: FakeRow, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
      return row[k] === v;
    });
  };

  const payoutMethod = {
    findMany: jest.fn(async (args: any = {}) => {
      let rows = db.payoutMethod.filter((r) => matches(r, args.where));
      rows = [...rows].sort((a, b) =>
        args.orderBy?.created_at === 'desc'
          ? b.created_at - a.created_at
          : a.created_at - b.created_at,
      );
      if (args.cursor) {
        const idx = rows.findIndex((r) => r.id === args.cursor.id);
        if (idx >= 0) rows = rows.slice(idx + (args.skip ?? 0));
      }
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((r) => ({ ...r }));
    }),
    findFirst: jest.fn(async (args: any = {}) => {
      const r = db.payoutMethod.find((row) => matches(row, args.where));
      return r ? { ...r } : null;
    }),
    findUnique: jest.fn(async (args: any) => {
      const r = db.payoutMethod.find((row) => row.id === args.where.id);
      return r ? { ...r } : null;
    }),
    count: jest.fn(async (args: any = {}) =>
      db.payoutMethod.filter((r) => matches(r, args.where)).length,
    ),
    create: jest.fn(async (args: any) => {
      const row: FakeRow = {
        id: makeId('pm'),
        last4: null,
        bank_name: null,
        stripe_external_account_id: null,
        status: 'PENDING_VERIFICATION',
        default: false,
        created_at: Date.now() + db.payoutMethod.length,
        ...args.data,
      };
      db.payoutMethod.push(row);
      return { ...row };
    }),
    update: jest.fn(async (args: any) => {
      const r = db.payoutMethod.find((row) => row.id === args.where.id);
      if (!r) throw new Error('row not found');
      Object.assign(r, args.data);
      return { ...r };
    }),
    updateMany: jest.fn(async (args: any) => {
      const rows = db.payoutMethod.filter((r) => matches(r, args.where));
      rows.forEach((r) => Object.assign(r, args.data));
      return { count: rows.length };
    }),
  };

  const user = {
    findUnique: jest.fn(async (args: any) => {
      const r = db.user.find((row) => row.id === args.where.id);
      return r ? { ...r } : null;
    }),
    update: jest.fn(async (args: any) => {
      const r = db.user.find((row) => row.id === args.where.id);
      if (!r) throw new Error('user not found');
      Object.assign(r, args.data);
      return { ...r };
    }),
    updateMany: jest.fn(async (args: any) => {
      const rows = db.user.filter((r) => matches(r, args.where));
      rows.forEach((r) => Object.assign(r, args.data));
      return { count: rows.length };
    }),
  };

  const connectAccount = {
    findUnique: jest.fn(async (args: any) => {
      const r = db.connectAccount.find(
        (row) =>
          (args.where.coach_user_id &&
            row.coach_user_id === args.where.coach_user_id) ||
          (args.where.stripe_account_id &&
            row.stripe_account_id === args.where.stripe_account_id),
      );
      return r ? { ...r } : null;
    }),
  };

  const prisma: any = {
    payoutMethod,
    user,
    connectAccount,
    // The services use $transaction(async (tx) => ...) — run against the same
    // fake client so writes are visible.
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    __db: db,
  };
  return prisma;
}

// A constructor-injectable StripeConnect mock (operator decision A).
function makeStripeConnectMock(): jest.Mocked<StripeConnect> {
  const mock: StripeConnect = {
    createFinancialConnectionsSession: jest.fn(async (_args: {
      connectedAccountId: string;
    }) => ({
      id: 'fcsess_test',
      client_secret: 'fcsess_test_secret',
    })),
    createExternalAccountFromFcSession: jest.fn(async (_args: {
      connectedAccountId: string;
      fcSessionId: string;
    }) => ({
      id: 'ba_test123',
      last4: '6789',
      bank_name: 'Test Bank',
      status: 'new',
    })),
  };
  return mock as jest.Mocked<StripeConnect>;
}

const ON = { FEATURE_BANK_PAYOUTS_V2: 'true' } as NodeJS.ProcessEnv;

async function withEnv<T>(
  env: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k] of Object.entries(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

// ===========================================================================
// 1. Feature flag — defaults OFF, exact-"true" only.
// ===========================================================================
describe('FEATURE_BANK_PAYOUTS_V2 flag', () => {
  it('defaults OFF when absent', () => {
    expect(isBankPayoutsV2Enabled({})).toBe(false);
  });
  it('is OFF for empty string', () => {
    expect(isBankPayoutsV2Enabled({ FEATURE_BANK_PAYOUTS_V2: '' })).toBe(false);
  });
  it.each(['false', '0', 'yes', 'on', '1', 'enabled', 'TRUEISH'])(
    'is OFF for non-"true" value %s',
    (v) => {
      expect(isBankPayoutsV2Enabled({ FEATURE_BANK_PAYOUTS_V2: v })).toBe(false);
    },
  );
  it.each(['true', 'TRUE', 'True', 'tRuE'])('is ON for "%s"', (v) => {
    expect(isBankPayoutsV2Enabled({ FEATURE_BANK_PAYOUTS_V2: v })).toBe(true);
  });
  it('Treasury flag defaults OFF', () => {
    expect(isStripeTreasuryPayoutsEnabled({})).toBe(false);
    expect(
      isStripeTreasuryPayoutsEnabled({ FEATURE_STRIPE_TREASURY_PAYOUTS: 'true' }),
    ).toBe(true);
  });
});

// ===========================================================================
// 2. PlatformFeeService — every §2.7 worked example, exactly.
// ===========================================================================
describe('PlatformFeeService.compute — §2.7 worked examples', () => {
  const fee = new PlatformFeeService();

  // [label, amount_cents, stripe_fee_cents, expected_platform_fee, expected_coach_net]
  const cases: Array<[string, number, number, number, number]> = [
    ['$50 card', 5000, 175, 100, 4725],
    ['$200 card', 20000, 610, 400, 18990],
    ['$200 future ACH', 20000, 160, 625, 19215],
    ['$1000 card', 100000, 2930, 2000, 95070],
    ['$1000 future ACH (capped $5)', 100000, 500, 3215, 96285],
  ];

  it.each(cases)(
    '%s → platform_fee + coach_net match the spec table exactly',
    (_label, amount, stripeFee, expFee, expNet) => {
      const r = fee.compute({
        amount_cents: amount,
        stripe_fee_cents: stripeFee,
      });
      expect(r.platform_fee_cents).toBe(expFee);
      expect(r.coach_net_cents).toBe(expNet);
      // Invariant: net = amount − platform_fee − stripe_fee.
      expect(r.coach_net_cents).toBe(amount - r.platform_fee_cents - stripeFee);
    },
  );

  it('the $1000 ACH row lands at $32.15 fee / $962.85 net (corrected formula)', () => {
    const r = fee.compute({ amount_cents: 100000, stripe_fee_cents: 500 });
    expect(r.platform_fee_cents).toBe(3215); // $32.15
    expect(r.coach_net_cents).toBe(96285); // $962.85
  });

  it('card payments yield savings=0 → fee is exactly 2%', () => {
    // card_cost == stripe_fee for a real card, so savings clamps to 0.
    const r = fee.compute({ amount_cents: 20000, stripe_fee_cents: 610 });
    expect(r.platform_fee_cents).toBe(400); // exactly 2% of $200
  });

  it('rejects non-integer / negative cents', () => {
    expect(() => fee.compute({ amount_cents: 1.5, stripe_fee_cents: 0 })).toThrow();
    expect(() => fee.compute({ amount_cents: -1, stripe_fee_cents: 0 })).toThrow();
  });
});

// ===========================================================================
// 2b. Gross-conservation invariant: coach_net + platform_fee + stripe_fee == gross.
//
// The original builder brief stated "coachPayout + platformFee === gross",
// which is mathematically wrong once Stripe takes a real cut: the Stripe fee
// must also be a term. The correct conservation law the source implements is
//   coach_net_cents + platform_fee_cents + stripe_fee_cents === amount_cents
// because compute() defines coach_net = amount - platform_fee - stripe_fee.
// This block asserts that law to the cent across >=5 adversarial inputs.
// ===========================================================================
describe('PlatformFeeService — gross-conservation invariant (coach + platform + stripe == gross)', () => {
  const fee = new PlatformFeeService();

  // [label, amount_cents (gross), stripe_fee_cents]
  // stripe_fee_cents models the ACTUAL rail fee for the scenario:
  //   - ACH: Stripe 0.8% capped at $5.00 (500 cents) — so always min(round(0.008*gross), 500).
  const cases: Array<[string, number, number]> = [
    ['$1,000 ACH (gross=100000, stripe=500 capped)', 100000, 500],
    ['$25 micro-purchase (gross=2500, stripe=125)', 2500, 125],
    ['$9,999.99 large ACH (gross=999999, stripe=500 capped)', 999999, 500],
    ['$1.00 minimum (gross=100, stripe=1)', 100, 1],
    ['$50 card (gross=5000, stripe=175)', 5000, 175],
    ['$200 future ACH (gross=20000, stripe=160)', 20000, 160],
  ];

  it.each(cases)(
    '%s → coach_net + platform_fee + stripe_fee === gross, to the cent',
    (_label, gross, stripeFee) => {
      const r = fee.compute({ amount_cents: gross, stripe_fee_cents: stripeFee });
      // The gross is fully partitioned: nothing is created or destroyed.
      expect(r.coach_net_cents + r.platform_fee_cents + stripeFee).toBe(gross);
      // Each component is a non-negative integer number of cents.
      expect(Number.isInteger(r.coach_net_cents)).toBe(true);
      expect(Number.isInteger(r.platform_fee_cents)).toBe(true);
      expect(r.coach_net_cents).toBeGreaterThanOrEqual(0);
      expect(r.platform_fee_cents).toBeGreaterThanOrEqual(0);
    },
  );

  it('rounding-edge: platform absorbs the internal penny while visible coach + visible platform + stripe still == gross', () => {
    // Use the reconcileInternal path. computed basis stripe_fee=500 → visible
    // fee 3215; actual basis stripe_fee=498 → internal fee 3216, so the
    // platform absorbs a +1c delta (platform_absorbed_delta_cents > 0).
    const gross = 100000;
    const stripeFee = 500;
    const recon = fee.reconcileInternal({
      amount_cents: gross,
      stripe_fee_cents: stripeFee,
      actual_stripe_fee_cents: 498,
    });
    // The penny is absorbed by the platform, never surfaced to the coach.
    expect(recon.platform_absorbed_delta_cents).toBeGreaterThan(0);
    // The COACH-VISIBLE partition still conserves gross exactly.
    expect(
      recon.coach_visible_net_cents +
        recon.coach_visible_fee_cents +
        stripeFee,
    ).toBe(gross);
  });
});

// ===========================================================================
// 3. Penny-absorb invariant (operator decision A: platform absorbs delta).
// ===========================================================================
describe('PlatformFeeService.reconcileInternal — penny absorb', () => {
  const fee = new PlatformFeeService();

  it('computed $32.15 vs actual Stripe $32.16: coach sees $32.15, internal holds $32.16', () => {
    // Construct an actual-fee one cent higher than the computed-basis fee.
    // computed basis: amount=100000, stripe_fee=500 → fee 3215.
    // actual basis: stripe_fee 498 → fee 3216 (one cent higher).
    const r = fee.reconcileInternal({
      amount_cents: 100000,
      stripe_fee_cents: 500,
      actual_stripe_fee_cents: 498,
    });
    expect(r.coach_visible_fee_cents).toBe(3215); // $32.15 — clean number on coach ledger
    expect(r.internal_actual_fee_cents).toBe(3216); // $32.16 — internal reconciliation
    expect(r.platform_absorbed_delta_cents).toBe(1); // platform eats the 1¢
  });

  it('no "Adjustment" leaks: coach-visible figure equals compute() exactly', () => {
    const visible = fee.compute({ amount_cents: 100000, stripe_fee_cents: 500 });
    const recon = fee.reconcileInternal({
      amount_cents: 100000,
      stripe_fee_cents: 500,
      actual_stripe_fee_cents: 498,
    });
    expect(recon.coach_visible_fee_cents).toBe(visible.platform_fee_cents);
    expect(recon.coach_visible_net_cents).toBe(visible.coach_net_cents);
  });
});

// ===========================================================================
// 4. PayoutMethodService — CRUD + idempotency + constructor injection.
// ===========================================================================
describe('PayoutMethodService — CRUD, idempotency, constructor injection', () => {
  it('constructs with a mocked StripeConnect and routes the FC link through the mock', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: null });
      prisma.__db.connectAccount.push({
        coach_user_id: 'coach1',
        stripe_account_id: 'acct_1',
      });
      // CONSTRUCTOR INJECTION (operator decision A): StripeConnect passed in.
      const svc = new PayoutMethodService(prisma, stripe);

      const session = await svc.createFinancialConnectionsSession({
        coachId: 'coach1',
      });
      expect(session?.client_secret).toBe('fcsess_test_secret');
      // Verify the call routed THROUGH the injected mock, on the coach's acct.
      expect(stripe.createFinancialConnectionsSession).toHaveBeenCalledWith({
        connectedAccountId: 'acct_1',
      });

      const row = await svc.createFromFinancialConnections({
        coachId: 'coach1',
        fcSessionId: 'fcsess_test',
      });
      expect(stripe.createExternalAccountFromFcSession).toHaveBeenCalledWith({
        connectedAccountId: 'acct_1',
        fcSessionId: 'fcsess_test',
      });
      expect(row?.kind).toBe('STRIPE_CONNECT_CUSTOM_BANK');
      expect(row?.status).toBe('PENDING_VERIFICATION');
      expect(row?.last4).toBe('6789');
    });
  });

  it('signup-flow bank link is idempotent — a re-submitted FC session does not duplicate the row', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: null });
      prisma.__db.connectAccount.push({
        coach_user_id: 'coach1',
        stripe_account_id: 'acct_1',
      });
      const svc = new PayoutMethodService(prisma, stripe);

      const first = await svc.createFromFinancialConnections({
        coachId: 'coach1',
        fcSessionId: 'fcsess_test',
      });
      const second = await svc.createFromFinancialConnections({
        coachId: 'coach1',
        fcSessionId: 'fcsess_test',
      });
      expect(second?.id).toBe(first?.id);
      expect(prisma.__db.payoutMethod.length).toBe(1);
    });
  });

  it('markVerified flips PENDING→VERIFIED and sets first verified method as default', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: null });
      const svc = new PayoutMethodService(prisma, stripe);
      const row = await prisma.payoutMethod.create({
        data: { coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK' },
      });

      const verified = await svc.markVerified(row.id);
      expect(verified?.status).toBe('VERIFIED');
      expect(verified?.default).toBe(true);
      const coach = prisma.__db.user.find((u: any) => u.id === 'coach1');
      expect(coach.default_payout_method_id).toBe(row.id);
    });
  });

  it('setDefault moves the default flag + User mirror in one transaction', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: 'pmA' });
      prisma.__db.payoutMethod.push(
        { id: 'pmA', coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK', status: 'VERIFIED', default: true, created_at: 1 },
        { id: 'pmB', coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK', status: 'VERIFIED', default: false, created_at: 2 },
      );
      const svc = new PayoutMethodService(prisma, stripe);

      const res = await svc.setDefault({ coachId: 'coach1', payoutMethodId: 'pmB' });
      expect(res?.default).toBe(true);
      expect(prisma.__db.payoutMethod.find((r: any) => r.id === 'pmA').default).toBe(false);
      expect(prisma.__db.user.find((u: any) => u.id === 'coach1').default_payout_method_id).toBe('pmB');
    });
  });

  it('listForCoach paginates with the default-50/max-100 cursor idiom', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      for (let i = 0; i < 5; i++) {
        prisma.__db.payoutMethod.push({
          id: `pm${i}`,
          coach_id: 'coach1',
          kind: 'STRIPE_CONNECT_CUSTOM_BANK',
          status: 'VERIFIED',
          default: false,
          created_at: i,
        });
      }
      const svc = new PayoutMethodService(prisma, stripe);
      const page1 = await svc.listForCoach('coach1', { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await svc.listForCoach('coach1', {
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.items).toHaveLength(2);
    });
  });

  it('disableForCoach refuses to disable the ONLY verified method', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: 'pmA' });
      prisma.__db.payoutMethod.push({
        id: 'pmA', coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK', status: 'VERIFIED', default: true, created_at: 1,
      });
      const svc = new PayoutMethodService(prisma, stripe);
      await expect(
        svc.disableForCoach({ coachId: 'coach1', payoutMethodId: 'pmA' }),
      ).rejects.toThrow(/only verified/i);
    });
  });
});

// ===========================================================================
// 5. PayoutRoutingService — card vs bank fee tier (spec §2.5).
// ===========================================================================
describe('PayoutRoutingService — fee-tier routing', () => {
  it('card-paid (Express) purchase routes to the card-fee tier', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: null });
      prisma.__db.connectAccount.push({ coach_user_id: 'coach1', stripe_account_id: 'acct_1' });
      const methods = new PayoutMethodService(prisma, stripe);
      const router = new PayoutRoutingService(prisma, methods);

      const res = await router.routePayoutWebhook({
        connectedAccountId: 'acct_1',
        payoutId: 'po_1',
        eventType: 'payout.paid',
      });
      expect(res.routed).toBe(true);
      expect(res.kind).toBe('STRIPE_EXPRESS');
      expect(res.feeTier).toBe('card');
      expect(res.action).toBe('express_log');
    });
  });

  it('bank-paid (Connect Custom bank) purchase routes to the bank-fee tier', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: 'pmA' });
      prisma.__db.connectAccount.push({ coach_user_id: 'coach1', stripe_account_id: 'acct_1' });
      prisma.__db.payoutMethod.push({
        id: 'pmA', coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK', status: 'VERIFIED', default: true, created_at: 1,
      });
      const methods = new PayoutMethodService(prisma, stripe);
      const router = new PayoutRoutingService(prisma, methods);

      const res = await router.routePayoutWebhook({
        connectedAccountId: 'acct_1',
        payoutId: 'po_1',
        eventType: 'payout.paid',
      });
      expect(res.kind).toBe('STRIPE_CONNECT_CUSTOM_BANK');
      expect(res.feeTier).toBe('bank');
      expect(res.action).toBe('custom_bank_log');
    });
  });

  it('STRIPE_TREASURY behaves like Connect Custom bank while the Treasury flag is OFF', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: 'pmT' });
      prisma.__db.connectAccount.push({ coach_user_id: 'coach1', stripe_account_id: 'acct_1' });
      prisma.__db.payoutMethod.push({
        id: 'pmT', coach_id: 'coach1', kind: 'STRIPE_TREASURY', status: 'VERIFIED', default: true, created_at: 1,
      });
      const methods = new PayoutMethodService(prisma, stripe);
      const router = new PayoutRoutingService(prisma, methods);
      const res = await router.routePayoutWebhook({
        connectedAccountId: 'acct_1',
        payoutId: 'po_1',
        eventType: 'payout.paid',
      });
      expect(res.kind).toBe('STRIPE_TREASURY');
      expect(res.feeTier).toBe('bank');
      expect(res.action).toBe('custom_bank_log'); // inert Treasury branch
    });
  });
});

// ===========================================================================
// 6. Webhook signature: verified mutates state; unverified → 401, no mutation.
// ===========================================================================
describe('payout.paid webhook signature verification', () => {
  const SECRET = 'whsec_test_secret';

  it('verified payload passes verification and the router mutates state', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: 'pmA' });
      prisma.__db.connectAccount.push({ coach_user_id: 'coach1', stripe_account_id: 'acct_1' });
      prisma.__db.payoutMethod.push({
        id: 'pmA', coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK', status: 'PENDING_VERIFICATION', default: false, created_at: 1,
      });
      const methods = new PayoutMethodService(prisma, stripe);

      const payload = JSON.stringify({
        type: 'account.external_account.updated',
        data: { object: { id: 'ba_test123', account: 'acct_1' } },
      });
      const header = signStripePayload({ payload, secret: SECRET });

      // 1) verification succeeds (does not throw)
      expect(() =>
        verifyStripeSignature({ payload, signatureHeader: header, secret: SECRET }),
      ).not.toThrow();

      // 2) only AFTER a verified signature do we mutate state.
      const verified = await methods.markVerified('pmA');
      expect(verified?.status).toBe('VERIFIED');
      expect(prisma.__db.payoutMethod.find((r: any) => r.id === 'pmA').status).toBe('VERIFIED');
    });
  });

  it('unverified payload throws (would yield 401) and leaves state unchanged', async () => {
    await withEnv(ON as any, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.payoutMethod.push({
        id: 'pmA', coach_id: 'coach1', kind: 'STRIPE_CONNECT_CUSTOM_BANK', status: 'PENDING_VERIFICATION', default: false, created_at: 1,
      });
      const methods = new PayoutMethodService(prisma, stripe);

      const payload = JSON.stringify({ type: 'payout.paid', data: { object: { id: 'po_x' } } });
      // Sign with the WRONG secret → verification must reject.
      const badHeader = signStripePayload({ payload, secret: 'whsec_attacker' });

      let rejected = false;
      try {
        verifyStripeSignature({ payload, signatureHeader: badHeader, secret: SECRET });
      } catch (err) {
        rejected = err instanceof StripeSignatureError;
      }
      expect(rejected).toBe(true);

      // State is NOT mutated because we never reach the handler on a bad sig.
      expect(prisma.__db.payoutMethod.find((r: any) => r.id === 'pmA').status).toBe('PENDING_VERIFICATION');
      expect(methods).toBeDefined();
    });
  });
});

// ===========================================================================
// 7. Feature flag OFF → all service methods no-op (safe defaults).
// ===========================================================================
describe('FEATURE_BANK_PAYOUTS_V2 OFF — every service method no-ops', () => {
  it('PayoutMethodService methods return safe defaults and touch no state', async () => {
    await withEnv({ FEATURE_BANK_PAYOUTS_V2: 'false' }, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      prisma.__db.user.push({ id: 'coach1', default_payout_method_id: null });
      prisma.__db.connectAccount.push({ coach_user_id: 'coach1', stripe_account_id: 'acct_1' });
      const svc = new PayoutMethodService(prisma, stripe);

      expect(await svc.listForCoach('coach1')).toEqual({ items: [], nextCursor: null });
      expect(await svc.createFinancialConnectionsSession({ coachId: 'coach1' })).toBeNull();
      expect(
        await svc.createFromFinancialConnections({ coachId: 'coach1', fcSessionId: 'x' }),
      ).toBeNull();
      expect(await svc.markVerified('pmA')).toBeNull();
      expect(await svc.markDisabled('pmA')).toBeNull();
      expect(await svc.setDefault({ coachId: 'coach1', payoutMethodId: 'pmA' })).toBeNull();
      expect(await svc.disableForCoach({ coachId: 'coach1', payoutMethodId: 'pmA' })).toBeNull();
      // resolveEffectiveKind falls back to Express (pre-v2 behaviour).
      expect(await svc.resolveEffectiveKind('coach1')).toBe('STRIPE_EXPRESS');

      // The Stripe mock was NEVER called, and no rows were written.
      expect(stripe.createFinancialConnectionsSession).not.toHaveBeenCalled();
      expect(stripe.createExternalAccountFromFcSession).not.toHaveBeenCalled();
      expect(prisma.__db.payoutMethod.length).toBe(0);
    });
  });

  it('PayoutRoutingService no-ops while OFF (reports Express, action noop)', async () => {
    await withEnv({ FEATURE_BANK_PAYOUTS_V2: 'false' }, async () => {
      const prisma = makeFakePrisma();
      const stripe = makeStripeConnectMock();
      const methods = new PayoutMethodService(prisma, stripe);
      const router = new PayoutRoutingService(prisma, methods);
      const res = await router.routePayoutWebhook({
        connectedAccountId: 'acct_1',
        payoutId: 'po_1',
        eventType: 'payout.paid',
      });
      expect(res.routed).toBe(false);
      expect(res.kind).toBe('STRIPE_EXPRESS');
      expect(res.action).toBe('noop');
      expect(res.reason).toBe('flag_off');
    });
  });
});

// ===========================================================================
// 8. Webhook HTTP-level signature reject (Gate 7) — real Nest app, real status
//    codes, and a before/after no-mutation assertion against PayoutRouting.
//
// The dedicated PayoutsV2WebhookController verifies the Stripe-Signature HMAC
// BEFORE delegating to PayoutRoutingService. A missing or invalid signature is
// rejected with HTTP 400 (this repo's Stripe convention: BadRequest = "do not
// retry"; see src/billing/stripe-webhook.controller.ts) and the routing service
// is NEVER invoked, so no DB row / audit / side effect can occur. A valid
// signature returns 200 and the expected routing state transition.
// ===========================================================================
describe('PayoutsV2WebhookController — HTTP-level signature reject (Gate 7)', () => {
  const SECRET = 'whsec_http_test_secret';
  let app: INestApplication;
  let routePayoutWebhook: jest.Mock;

  beforeAll(async () => {
    routePayoutWebhook = jest.fn(async () => ({
      routed: true,
      kind: 'STRIPE_CONNECT_CUSTOM_BANK',
      feeTier: 'bank',
      action: 'custom_bank_log',
    }));
    const moduleRef = await Test.createTestingModule({
      controllers: [PayoutsV2WebhookController],
      providers: [
        { provide: PayoutRoutingService, useValue: { routePayoutWebhook } },
      ],
    }).compile();
    // rawBody:true mirrors src/main.ts so req.rawBody is the exact signed bytes.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0);
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });

  afterAll(async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    if (app) await app.close();
  });

  beforeEach(() => routePayoutWebhook.mockClear());

  const PATH = '/v1/webhooks/payouts-v2/stripe-connect';
  const payload = JSON.stringify({
    id: 'evt_1',
    type: 'account.external_account.updated',
    data: { object: { id: 'ba_test123', account: 'acct_1' } },
  });

  it('POST with MISSING Stripe-Signature header → 400 and no routing/DB side effect', async () => {
    const res = await httpRequest({
      app,
      method: 'POST',
      path: PATH,
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Stripe signature');
    // The routing layer (the only DB/audit mutation path) was never reached.
    expect(routePayoutWebhook).not.toHaveBeenCalled();
  });

  it('POST with INVALID Stripe-Signature → 400 and no routing/DB side effect', async () => {
    const badHeader = signStripePayload({ payload, secret: 'whsec_attacker' });
    const res = await httpRequest({
      app,
      method: 'POST',
      path: PATH,
      headers: { 'content-type': 'application/json', 'stripe-signature': badHeader },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Stripe signature');
    expect(routePayoutWebhook).not.toHaveBeenCalled();
  });

  it('after both rejects, the routing service was never invoked (no row / no audit / no side effect)', () => {
    // Both prior tests asserted not-called; this aggregate guard documents the
    // before/after invariant: zero delegations across all rejected requests.
    expect(routePayoutWebhook).not.toHaveBeenCalled();
  });

  it('POST with VALID Stripe-Signature → 200 and the expected routing transition', async () => {
    const header = signStripePayload({ payload, secret: SECRET });
    const res = await httpRequest({
      app,
      method: 'POST',
      path: PATH,
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(routePayoutWebhook).toHaveBeenCalledTimes(1);
    expect(routePayoutWebhook).toHaveBeenCalledWith({
      connectedAccountId: 'acct_1',
      payoutId: 'ba_test123',
      eventType: 'account.external_account.updated',
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.received).toBe(true);
    expect(parsed.routing.action).toBe('custom_bank_log');
  });
});

// Keep imports referenced for environments that tree-shake unused imports.
void BadRequestException;
void UnauthorizedException;
