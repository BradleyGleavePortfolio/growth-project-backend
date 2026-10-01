import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { GRANT_SOURCE, InviteGrantService } from '../src/invite-grant/invite-grant.service';
import type { ConsentService } from '../src/consent/consent.service';
import type { CheckoutContractGate } from '../src/contracts/checkout-contract-gate.service';
import { ContractRequiredException } from '../src/contracts/contract-required.exception';
import type { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { InviteGrantController } from '../src/invite-grant/invite-grant.controller';
import { CreatePackageDto, UpdatePackageDto } from '../src/packages/packages.dto';
import { ValidationPipe } from '@nestjs/common';
import type { PrismaService } from '../src/prisma.service';
import type { AuditService } from '../src/audit/audit.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { EmailService } from '../src/email/email.service';
import type { AuthedRequest } from '../src/auth/auth-request';

// Clinic launch C01 — invite-code → package grants, free packages, revoke.
//
// Grants are ordinary ClientPurchase rows (entitlement_active, amount 0,
// source set), so the paywall (ClientEntitlementGuard) and
// CheckoutService.hasActiveEntitlement honour them with no change. These
// specs run the real InviteCodesService attach path, the real
// InviteGrantService and the real guard over an in-memory Prisma double.

// ---- in-memory Prisma double ------------------------------------------------

type UserRow = { id: string; email: string; role: string; coach_id: string | null };
type PkgRow = {
  id: string;
  coach_id: string;
  amount_cents: number;
  currency: string;
  billing_type: string;
  duration_periods: number | null;
  is_active: boolean;
  archived_at: Date | null;
  published_at: Date | null;
  requires_contract?: boolean;
  contract_template_id?: string | null;
};
type ProfileRow = {
  user_id: string;
  invite_code: string;
  invite_code_package_id: string | null;
  invite_code_grant_mode: 'none' | 'free' | 'prepaid';
};
type CodeRow = {
  id: string;
  code: string;
  coach_id: string;
  revoked: boolean;
  expires_at: Date | null;
  max_uses: number | null;
  used_count: number;
  intended_email: string | null;
  package_id: string | null;
  grant_mode: 'none' | 'free' | 'prepaid';
};
type PurchaseRow = {
  id: string;
  client_user_id: string;
  coach_user_id: string;
  package_id: string;
  amount_cents: number;
  currency: string;
  billing_type: string;
  stripe_checkout_session_id: string;
  status: string;
  entitlement_active: boolean;
  access_expires_at: Date | null;
  canceled_at: Date | null;
  idempotency_key: string;
  source: string | null;
  grant_metadata: Record<string, unknown> | null;
};

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      const alts = v as Where[];
      if (!alts.some((alt) => matches(row, alt))) return false;
      continue;
    }
    const actual = row[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as { in?: unknown[]; gt?: Date; lt?: number };
      if (cond.in && !cond.in.includes(actual)) return false;
      if (typeof cond.lt === 'number' && !((actual as number) < cond.lt)) return false;
      if (
        cond.gt instanceof Date &&
        !(actual instanceof Date && actual.getTime() > cond.gt.getTime())
      )
        return false;
      continue;
    }
    if ((actual ?? null) !== v) return false;
  }
  return true;
}

/** Apply a Prisma-style `data` (plain sets + `{ increment }`) to a row. */
function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as object)) {
      row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
    } else {
      row[k] = v;
    }
  }
}

function makePrisma(seed: {
  users: UserRow[];
  packages: PkgRow[];
  profiles: ProfileRow[];
  codes?: CodeRow[];
}) {
  const users = new Map(seed.users.map((u) => [u.id, { ...u }]));
  const packages = new Map(seed.packages.map((p) => [p.id, { ...p }]));
  const profiles = seed.profiles.map((p) => ({ ...p }));
  const codes = (seed.codes ?? []).map((c) => ({ ...c }));
  const purchases: PurchaseRow[] = [];
  const subs = new Map(
    seed.users.filter((u) => u.role === 'coach').map((u) => [u.id, { status: 'active' }]),
  );
  let seq = 0;

  const base = {
    _purchases: purchases,
    _users: users,
    _codes: codes,
    _profiles: profiles,
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
          const row = users.get(where.id);
          if (!row) throw new Error('no user');
          Object.assign(row, data);
          return row;
        },
      ),
      // Canonical attach (C03) writes conditionally: student with no coach.
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hits = [...users.values()].filter((u) => matches(u as unknown as Record<string, unknown>, where));
        for (const u of hits) applyData(u as unknown as Record<string, unknown>, data);
        return { count: hits.length };
      }),
    },
    coachSubscription: {
      findUnique: jest.fn(
        async ({ where }: { where: { coach_id: string } }) => subs.get(where.coach_id) ?? null,
      ),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: { where: { invite_code?: string } }) => {
        const p = profiles.find((x) => x.invite_code === where.invite_code);
        return p ? { ...p, user: { id: p.user_id, role: 'coach' } } : null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { invite_code: string }; data: Partial<ProfileRow> }) => {
          const p = profiles.find((x) => x.invite_code === where.invite_code);
          if (!p) throw new Error('no profile');
          Object.assign(p, data);
          return p;
        },
      ),
    },
    inviteCode: {
      findUnique: jest.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
        const c = codes.find((x) => (where.code ? x.code === where.code : x.id === where.id));
        return c ? { ...c, coach: { id: c.coach_id, role: 'coach' } } : null;
      }),
      findFirst: jest.fn(async () => null),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<CodeRow> }) => {
          const c = codes.find((x) => x.id === where.id);
          if (!c) throw new Error('no code');
          Object.assign(c, data);
          return c;
        },
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          const hits = codes.filter((c) => matches(c as unknown as Record<string, unknown>, where));
          for (const c of hits) applyData(c as unknown as Record<string, unknown>, data);
          return { count: hits.length };
        },
      ),
    },
    coachPackage: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => packages.get(where.id) ?? null,
      ),
    },
    clientPurchase: {
      findUnique: jest.fn(
        async ({ where }: { where: { idempotency_key?: string; id?: string } }) =>
          purchases.find((p) =>
            where.idempotency_key ? p.idempotency_key === where.idempotency_key : p.id === where.id,
          ) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Where }) => purchases.find((p) => matches(p, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        purchases.filter((p) => matches(p, where)),
      ),
      create: jest.fn(async ({ data }: { data: Omit<PurchaseRow, 'id' | 'canceled_at'> }) => {
        if (purchases.some((p) => p.idempotency_key === data.idempotency_key)) {
          throw new Error('unique violation idempotency_key');
        }
        const row: PurchaseRow = { id: `cp-${++seq}`, canceled_at: null, ...data };
        purchases.push(row);
        return row;
      }),
      // ON CONFLICT (idempotency_key) DO NOTHING ... RETURNING — the existing
      // row is returned untouched when the key already exists.
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { idempotency_key: string };
          create: Omit<PurchaseRow, 'id' | 'canceled_at'>;
        }) => {
          const existing = purchases.find((p) => p.idempotency_key === where.idempotency_key);
          if (existing) return existing;
          const row: PurchaseRow = { id: `cp-${++seq}`, canceled_at: null, ...create };
          purchases.push(row);
          return row;
        },
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hits = purchases.filter((p) => matches(p as unknown as Record<string, unknown>, where));
        for (const p of hits) applyData(p as unknown as Record<string, unknown>, data);
        return { count: hits.length };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<PurchaseRow> }) => {
          const row = purchases.find((p) => p.id === where.id);
          if (!row) throw new Error('no purchase');
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
  const double = Object.assign(base, {
    $transaction: jest.fn(async <T>(cb: (tx: typeof base) => Promise<T>) => cb(base)),
  });
  return double;
}
type PrismaDouble = ReturnType<typeof makePrisma>;

function asPrisma(d: PrismaDouble): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — only the delegates the code under test reads
  return d;
}
function makeAudit() {
  const a = { write: jest.fn(async () => undefined) };
  function asAudit(): AuditService {
    // @ts-expect-error partial structural mock of AuditService
    return a;
  }
  return { a, audit: asAudit() };
}
function makeAnalytics(): AnalyticsService {
  const a = { capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() };
  // @ts-expect-error partial structural mock of AnalyticsService
  return a;
}
function makeEmail(): EmailService {
  const e = { send: jest.fn() };
  // @ts-expect-error partial structural mock of EmailService — never reached
  return e;
}
function makeReflector(): Reflector {
  const r = { getAllAndOverride: () => false };
  // @ts-expect-error minimal Reflector double — the guard reads only getAllAndOverride
  return r;
}
function ctxFor(user: UserRow): ExecutionContext {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  // @ts-expect-error partial ExecutionContext double
  return ctx;
}
function asAuthed(user: UserRow): AuthedRequest {
  const req = { user, headers: {} };
  // @ts-expect-error partial AuthedRequest — user rows in this spec omit the full Prisma User shape
  return req;
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
}

// ---- fixtures ---------------------------------------------------------------

const COACH = 'coach-bradley';
const OTHER_COACH = 'coach-other';
const PKG_CLINIC = 'pkg-clinic';
const PKG_FREE = 'pkg-free';
const PKG_PAID = 'pkg-paid';
const PKG_OTHER = 'pkg-other-coach';
const CLINIC_CODE = 'GP-CLINIC';

function fixtures() {
  const now = new Date();
  return makePrisma({
    users: [
      { id: COACH, email: 'b@example.com', role: 'coach', coach_id: null },
      { id: OTHER_COACH, email: 'o@example.com', role: 'coach', coach_id: null },
      { id: 'owner-1', email: 'own@example.com', role: 'owner', coach_id: null },
      { id: 'client-1', email: 'c1@example.com', role: 'student', coach_id: null },
      { id: 'client-2', email: 'c2@example.com', role: 'student', coach_id: null },
      { id: 'client-other', email: 'co@example.com', role: 'student', coach_id: OTHER_COACH },
    ],
    packages: [
      {
        id: PKG_CLINIC,
        coach_id: COACH,
        amount_cents: 29900,
        currency: 'usd',
        billing_type: 'one_time',
        duration_periods: 12,
        is_active: true,
        archived_at: null,
        published_at: now,
      },
      {
        id: PKG_FREE,
        coach_id: COACH,
        amount_cents: 0,
        currency: 'usd',
        billing_type: 'one_time',
        duration_periods: null,
        is_active: true,
        archived_at: null,
        published_at: now,
      },
      {
        id: PKG_PAID,
        coach_id: COACH,
        amount_cents: 4900,
        currency: 'usd',
        billing_type: 'recurring',
        duration_periods: null,
        is_active: true,
        archived_at: null,
        published_at: now,
      },
      {
        id: PKG_OTHER,
        coach_id: OTHER_COACH,
        amount_cents: 0,
        currency: 'usd',
        billing_type: 'one_time',
        duration_periods: null,
        is_active: true,
        archived_at: null,
        published_at: now,
      },
    ],
    profiles: [
      {
        user_id: COACH,
        invite_code: CLINIC_CODE,
        invite_code_package_id: null,
        invite_code_grant_mode: 'none',
      },
      {
        user_id: OTHER_COACH,
        invite_code: 'GP-OTHER',
        invite_code_package_id: null,
        invite_code_grant_mode: 'none',
      },
    ],
    codes: [
      {
        id: 'ic-1',
        code: 'GP-ROW001',
        coach_id: COACH,
        revoked: false,
        expires_at: null,
        max_uses: 10,
        used_count: 0,
        intended_email: null,
        package_id: null,
        grant_mode: 'none',
      },
    ],
  });
}

type FanoutDouble = {
  onPurchaseEntitled: jest.Mock;
  flushAlerts: jest.Mock;
  cancelPendingForPurchase: jest.Mock;
};
function makeFanout(): { f: FanoutDouble; fanout: PurchaseFanoutService } {
  const f: FanoutDouble = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    flushAlerts: jest.fn(),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  // @ts-expect-error partial PurchaseFanoutService — the grant path uses only these three members
  const fanout: PurchaseFanoutService = f;
  return { f, fanout };
}
type GateDouble = { evaluate: jest.Mock };
function makeGate(result: Awaited<ReturnType<CheckoutContractGate['evaluate']>>): {
  g: GateDouble;
  gate: CheckoutContractGate;
} {
  const g: GateDouble = { evaluate: jest.fn(async () => result) };
  // @ts-expect-error partial CheckoutContractGate — only evaluate() is consumed
  const gate: CheckoutContractGate = g;
  return { g, gate };
}
async function captureHttp(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
  throw new Error('expected the promise to reject');
}

/** In-app onboarding agreement double (ConsentService.isGranted / onGranted). */
function makeConsent(agreed: boolean) {
  const c = {
    agreed,
    isGranted: jest.fn(async () => c.agreed),
    onGranted: jest.fn(),
  };
  return c;
}

function build(
  prisma: PrismaDouble,
  opts: { gate?: CheckoutContractGate; consent?: ReturnType<typeof makeConsent> } = {},
) {
  const { a: auditMock, audit } = makeAudit();
  const { f: fanoutMock, fanout } = makeFanout();
  // Default: the client ticked the in-app agreement (contracts default ON under NODE_ENV=test).
  const consent = opts.consent ?? makeConsent(true);
  const grants = new InviteGrantService(
    asPrisma(prisma),
    audit,
    fanout,
    opts.gate,
    consent as unknown as ConsentService,
  );
  const inviteCodes = new InviteCodesService(
    asPrisma(prisma),
    makeAnalytics(),
    makeEmail(),
    audit,
    grants,
  );
  const guard = new ClientEntitlementGuard(asPrisma(prisma), makeReflector());
  const controller = new InviteGrantController(grants);
  return { grants, inviteCodes, guard, controller, auditMock, fanoutMock };
}
const coachActor = { id: COACH, role: 'coach', email: 'b@example.com' };
const ownerActor = { id: 'owner-1', role: 'owner', email: 'own@example.com' };
const client = (id: string, coach_id: string | null = COACH): UserRow => ({
  id,
  email: `${id}@example.com`,
  role: 'student',
  coach_id,
});

// ---- 1. bindings ------------------------------------------------------------

describe('C01 — invite code → package binding', () => {
  it('coach binds the PERMANENT coach code to a package as prepaid; join link is /join/<code>', async () => {
    const prisma = fixtures();
    const { grants } = build(prisma);
    const b = await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    expect(b).toMatchObject({
      kind: 'profile',
      coach_id: COACH,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    expect(prisma._profiles[0]).toMatchObject({
      invite_code_package_id: PKG_CLINIC,
      invite_code_grant_mode: 'prepaid',
    });
    expect(await grants.resolveBinding(CLINIC_CODE)).toMatchObject({
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
  });

  it('coach binds a per-row InviteCode as free, then clears it with grant_mode none', async () => {
    const prisma = fixtures();
    const { grants, auditMock } = build(prisma);
    await grants.setBinding(coachActor, {
      code: 'GP-ROW001',
      package_id: PKG_FREE,
      grant_mode: 'free',
    });
    expect(prisma._codes[0]).toMatchObject({ package_id: PKG_FREE, grant_mode: 'free' });
    const cleared = await grants.setBinding(coachActor, {
      code: 'GP-ROW001',
      package_id: PKG_FREE,
      grant_mode: 'none',
    });
    expect(cleared).toMatchObject({ package_id: null, grant_mode: 'none' });
    expect(prisma._codes[0]).toMatchObject({ package_id: null, grant_mode: 'none' });
    expect(auditMock.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invite_code.binding_set' }),
    );
  });

  it("refuses another coach's code (404, non-leaking) and another coach's package; owner may bind any code", async () => {
    const prisma = fixtures();
    const { grants } = build(prisma);
    await expect(
      grants.setBinding(
        { id: OTHER_COACH, role: 'coach' },
        { code: CLINIC_CODE, package_id: PKG_OTHER, grant_mode: 'free' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      grants.setBinding(coachActor, {
        code: CLINIC_CODE,
        package_id: PKG_OTHER,
        grant_mode: 'free',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      grants.setBinding(coachActor, {
        code: 'GP-NOPE',
        package_id: PKG_CLINIC,
        grant_mode: 'free',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const b = await grants.setBinding(ownerActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'free',
    });
    expect(b.grant_mode).toBe('free');
  });
});

// ---- 2. grant on attach + paywall -------------------------------------------

describe('C01 — grant on attach via a bound code; paywall honours it without Stripe', () => {
  it('prepaid binding: attach creates a $0 ClientPurchase grant, delivered like a purchase (fan-out + coach alert); guard passes', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes, guard, fanoutMock } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });

    expect(await status(guard.canActivate(ctxFor(client('client-1', null))))).toBe(
      HttpStatus.PAYMENT_REQUIRED,
    );

    const res = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(res).toMatchObject({
      role: 'student',
      coach_id: COACH,
      grant: { status: 'created', package_id: PKG_CLINIC },
    });
    // attach tx + grant tx (the grant is post-commit and best-effort)
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // A1 — same fulfilment path as a paid purchase, in the grant's transaction,
    // then the staged coach-new-client alert is flushed after commit.
    expect(fanoutMock.onPurchaseEntitled).toHaveBeenCalledWith(
      { id: prisma._purchases[0].id },
      expect.objectContaining({ entrypoint: 'invite_grant', coachId: COACH, clientId: 'client-1' }),
      expect.anything(),
    );
    expect(fanoutMock.flushAlerts).toHaveBeenCalledWith(prisma._purchases[0].id);

    expect(prisma._purchases).toHaveLength(1);
    const row = prisma._purchases[0];
    expect(row).toMatchObject({
      client_user_id: 'client-1',
      coach_user_id: COACH,
      package_id: PKG_CLINIC,
      amount_cents: 0,
      status: 'active',
      entitlement_active: true,
      source: GRANT_SOURCE.INVITE_PREPAID,
      idempotency_key: `grant:${PKG_CLINIC}:client-1`, // one grant per (package, client) regardless of mode
    });
    expect(row.stripe_checkout_session_id).toMatch(/^grant_[0-9a-f-]{36}$/);
    expect(row.grant_metadata).toMatchObject({
      invite_code: CLINIC_CODE,
      code_kind: 'profile',
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    // one_time with duration_periods=12 weeks → expiry ~84 days out
    const days = (row.access_expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(83);
    expect(days).toBeLessThan(85);

    expect(await status(guard.canActivate(ctxFor(client('client-1'))))).toBe(200);
  });

  it('free binding on a per-row code: source invite_grant:free; unbound code grants nothing (402 stays)', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes, guard } = build(prisma);
    await grants.setBinding(coachActor, {
      code: 'GP-ROW001',
      package_id: PKG_FREE,
      grant_mode: 'free',
    });

    const withGrant = await inviteCodes.attachUserToCoachByCode('client-1', 'GP-ROW001');
    expect(withGrant.grant).toMatchObject({ status: 'created', package_id: PKG_FREE });
    expect(prisma._purchases[0].source).toBe(GRANT_SOURCE.INVITE_FREE);
    expect(prisma._codes[0].used_count).toBe(1);

    const noGrant = await inviteCodes.attachUserToCoachByCode('client-2', CLINIC_CODE); // unbound permanent code
    expect(noGrant).toMatchObject({ role: 'student', coach_id: COACH });
    expect(noGrant.grant).toBeUndefined(); // no binding → no grant field
    expect(prisma._purchases).toHaveLength(1);
    expect(await status(guard.canActivate(ctxFor(client('client-2'))))).toBe(
      HttpStatus.PAYMENT_REQUIRED,
    );
  });

  it('re-attach with the same code is idempotent: one row, status already_active', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    const again = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(again.grant).toMatchObject({ status: 'already_active', package_id: PKG_CLINIC });
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma.clientPurchase.upsert).toHaveBeenCalledTimes(2); // ON CONFLICT DO NOTHING on the replay
  });

  it('legacy 4-arg InviteCodesService (no grant service) still attaches and reports no grant', async () => {
    const prisma = fixtures();
    prisma._profiles[0].invite_code_package_id = PKG_CLINIC;
    prisma._profiles[0].invite_code_grant_mode = 'prepaid';
    const legacy = new InviteCodesService(
      asPrisma(prisma),
      makeAnalytics(),
      makeEmail(),
      makeAudit().audit,
    );
    const res = await legacy.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(res).toEqual({ role: 'student', coach_id: COACH, already_attached: false });
    expect(prisma._purchases).toHaveLength(0);
  });

  it('a binding to an archived/inactive package is skipped safely at attach time (attach still succeeds)', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    // Package archived after the binding was made.
    const pkg = await prisma.coachPackage.findUnique({ where: { id: PKG_CLINIC } });
    pkg!.archived_at = new Date();
    const res = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    // A2 — the attach itself succeeds; the grant is reported as skipped and audited.
    expect(res).toMatchObject({
      role: 'student',
      coach_id: COACH,
      grant: { status: 'package_unavailable', purchase_id: null, package_id: PKG_CLINIC },
    });
    expect(prisma._users.get('client-1')?.coach_id).toBe(COACH);
    expect(prisma._purchases).toHaveLength(0);
  });

  it('a grant failure (e.g. fan-out throws) never fails the attach: status failed, audited, attach committed', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes, auditMock, fanoutMock } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    fanoutMock.onPurchaseEntitled.mockRejectedValueOnce(new Error('resolver exploded'));
    const res = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(res).toMatchObject({ coach_id: COACH, grant: { status: 'failed', purchase_id: null } });
    expect(prisma._users.get('client-1')?.coach_id).toBe(COACH);
    expect(auditMock.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'entitlement.grant_skipped',
        metadata: expect.objectContaining({ reason: 'failed', detail: 'resolver exploded' }),
      }),
    );
  });

  it('double submit: two concurrent attaches through the bound code converge on ONE grant row', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    const [a, b] = await Promise.all([
      inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE),
      inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE),
    ]);
    expect([a.grant?.status, b.grant?.status].sort()).toEqual(['already_active', 'created']);
    expect(prisma._purchases).toHaveLength(1);
  });

  it('an EXISTING client of the same coach who scans the QR is granted (idempotent)', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes, guard } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    const existing = prisma._users.get('client-1');
    if (existing) existing.coach_id = COACH; // already Bradley's client before the clinic
    const res = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(res.grant).toMatchObject({ status: 'created', package_id: PKG_CLINIC });
    expect(await status(guard.canActivate(ctxFor(client('client-1'))))).toBe(HttpStatus.OK);
    // …and via the explicit claim endpoint (web /join for signed-in clients): already_active.
    const again = await grants.claimGrantForCode(client('client-1'), CLINIC_CODE);
    expect(again.status).toBe('already_active');
    expect(prisma._purchases).toHaveLength(1);
  });

  it('a binding switched free → prepaid does not re-grant a client revoked under the first mode', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'free',
    });
    await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    await grants.revoke(coachActor, { client_user_id: 'client-1' });
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    const res = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(res.grant?.status).toBe('revoked_not_regranted');
    expect(prisma._purchases).toHaveLength(1);
  });
});

// ---- 2b. contract / waiver gate ---------------------------------------------

describe('C01 — grants respect the package contract / waiver gate like checkout', () => {
  const blocked = {
    ok: false as const,
    layer: 'platform_waiver' as const,
    envelopeId: 'env-1',
    embedUrl: 'https://sign.example/env-1',
    status: 'sent',
  };

  it('binding a package that requires a coach agreement → 400 PACKAGE_REQUIRES_CONTRACT', async () => {
    const prisma = fixtures();
    const { grants } = build(prisma);
    const pkg = await prisma.coachPackage.findUnique({ where: { id: PKG_CLINIC } });
    pkg!.requires_contract = true;
    pkg!.contract_template_id = 'tpl-1';
    const err = await captureHttp(
      grants.setBinding(coachActor, {
        code: CLINIC_CODE,
        package_id: PKG_CLINIC,
        grant_mode: 'prepaid',
      }),
    );
    expect(err.getResponse()).toMatchObject({ error: 'PACKAGE_REQUIRES_CONTRACT' });
  });

  // Opus C01-B2 / Sol SOL-C01-B1 (owner ruling: one in-app "I agree" box).
  it('claim-free never consults the external platform waiver; the in-app agreement gates activation', async () => {
    const prisma = fixtures();
    const { g, gate } = makeGate(blocked); // external e-sign waiver unsigned
    const consent = makeConsent(false);
    const { grants } = build(prisma, { gate, consent });
    const pending = await grants.claimFreePackage(client('client-1'), PKG_FREE);
    expect(pending).toMatchObject({ status: 'pending_consent', recovery: { consent_scope: 'onboarding.agreement' } });
    expect(g.evaluate).not.toHaveBeenCalled();
    expect(prisma._purchases[0]).toMatchObject({ entitlement_active: false, status: 'pending_consent' });

    consent.agreed = true;
    const ok = await grants.claimFreePackage(client('client-1'), PKG_FREE);
    expect(ok.status).toBe('created');
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0]).toMatchObject({ entitlement_active: true, status: 'active' });
    expect(g.evaluate).not.toHaveBeenCalled();
  });

  it('attach through a bound code before the in-app agreement: attach succeeds, grant pending, claim after agreement activates', async () => {
    const prisma = fixtures();
    const { gate } = makeGate(blocked);
    const consent = makeConsent(false);
    const { grants, inviteCodes } = build(prisma, { gate, consent });
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    const res = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(res).toMatchObject({
      coach_id: COACH,
      grant: { status: 'pending_consent', package_id: PKG_CLINIC },
    });
    expect(await grants.claimGrantForCode(client('client-1'), CLINIC_CODE)).toMatchObject({
      status: 'pending_consent',
    });
    consent.agreed = true;
    expect((await grants.claimGrantForCode(client('client-1'), CLINIC_CODE)).status).toBe('created');
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0]).toMatchObject({ entitlement_active: true });
  });

  it('refused re-claim of a revoked grant is a 409 GRANT_REVOKED at the controller, not a 200', async () => {
    const prisma = fixtures();
    const { grants, controller } = build(prisma);
    const row = prisma._users.get('client-1');
    if (row) row.coach_id = COACH;
    await grants.claimFreePackage(client('client-1'), PKG_FREE);
    await grants.revoke(coachActor, { client_user_id: 'client-1' });
    const err = await captureHttp(
      controller.claimFree(asAuthed(client('client-1')), { id: PKG_FREE }),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      error: 'GRANT_REVOKED',
      status: 'revoked_not_regranted',
    });
  });
});

// ---- 3. free packages as a service -----------------------------------------

describe('C01 — free packages: POST /v1/packages/:id/claim-free', () => {
  it('client of the coach claims a $0 package → grant row, guard passes; second claim is already_active', async () => {
    const prisma = fixtures();
    const { controller, guard } = build(prisma);
    const req = asAuthed(client('client-1'));
    const res = await controller.claimFree(req, { id: PKG_FREE });
    expect(res).toMatchObject({ active: true, status: 'created' });
    expect(prisma._purchases[0]).toMatchObject({
      amount_cents: 0,
      source: GRANT_SOURCE.FREE_PACKAGE_CLAIM,
      entitlement_active: true,
      access_expires_at: null,
    });
    expect(await status(guard.canActivate(ctxFor(client('client-1'))))).toBe(200);
    const again = await controller.claimFree(req, { id: PKG_FREE });
    expect(again).toMatchObject({ active: true, status: 'already_active' });
    expect(prisma._purchases).toHaveLength(1);
  });

  it('non-free package → 400 PACKAGE_NOT_FREE (Stripe stays the only path); other coach’s package → 404; coach role → 403', async () => {
    const prisma = fixtures();
    const { grants } = build(prisma);
    const c1 = client('client-1');
    const notFree = await grants.claimFreePackage(c1, PKG_PAID).catch((e: unknown) => e);
    expect(notFree).toBeInstanceOf(BadRequestException);
    expect((notFree as HttpException).getResponse()).toMatchObject({ error: 'PACKAGE_NOT_FREE' });
    await expect(grants.claimFreePackage(c1, PKG_OTHER)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      grants.claimFreePackage(client('client-3', null), PKG_FREE),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      grants.claimFreePackage({ id: COACH, role: 'coach', coach_id: null }, PKG_FREE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma._purchases).toHaveLength(0);
  });

  it('package DTOs accept amount_cents 0 and still enforce the 50¢ floor for paid packages', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const base = { name: 'Free intro', amount_cents: 0, currency: 'usd', billing_type: 'one_time' };
    await expect(
      pipe.transform(base, { type: 'body', metatype: CreatePackageDto }),
    ).resolves.toMatchObject({ amount_cents: 0 });
    await expect(
      pipe.transform({ ...base, amount_cents: 10 }, { type: 'body', metatype: CreatePackageDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform({ ...base, amount_cents: -1 }, { type: 'body', metatype: CreatePackageDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform({ amount_cents: 0 }, { type: 'body', metatype: UpdatePackageDto }),
    ).resolves.toMatchObject({ amount_cents: 0 });
    await expect(
      pipe.transform({ amount_cents: 49 }, { type: 'body', metatype: UpdatePackageDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---- 4. revoke ---------------------------------------------------------------

describe('C01 — revoke grants (audited, idempotent, never touches Stripe rows)', () => {
  it('coach revokes for a roster client: row flips inactive, guard returns 402, re-attach does NOT re-grant', async () => {
    const prisma = fixtures();
    const { grants, inviteCodes, guard, auditMock } = build(prisma);
    await grants.setBinding(coachActor, {
      code: CLINIC_CODE,
      package_id: PKG_CLINIC,
      grant_mode: 'prepaid',
    });
    await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(await status(guard.canActivate(ctxFor(client('client-1'))))).toBe(200);

    const r = await grants.revoke(coachActor, {
      client_user_id: 'client-1',
      reason: 'left clinic',
    });
    expect(r.revoked).toBe(1);
    expect(prisma._purchases[0]).toMatchObject({ entitlement_active: false, status: 'revoked' });
    expect(prisma._purchases[0].grant_metadata).toMatchObject({
      revoked_by_user_id: COACH,
      revoke_reason: 'left clinic',
    });
    expect(auditMock.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entitlement.grant_revoked', targetId: 'cp-1' }),
    );
    expect(await status(guard.canActivate(ctxFor(client('client-1'))))).toBe(
      HttpStatus.PAYMENT_REQUIRED,
    );

    const again = await grants.revoke(coachActor, { client_user_id: 'client-1' });
    expect(again.revoked).toBe(0);

    const reattach = await inviteCodes.attachUserToCoachByCode('client-1', CLINIC_CODE);
    expect(reattach.grant).toMatchObject({ status: 'revoked_not_regranted' });
    expect(prisma._purchases).toHaveLength(1);
    expect(await status(guard.canActivate(ctxFor(client('client-1'))))).toBe(
      HttpStatus.PAYMENT_REQUIRED,
    );
  });

  it('coach cannot revoke for another coach’s client (404); owner can; Stripe purchases are untouched', async () => {
    const prisma = fixtures();
    const { grants } = build(prisma);
    // A real Stripe purchase for client-other (source null) plus a grant.
    prisma._purchases.push({
      id: 'cp-stripe',
      client_user_id: 'client-other',
      coach_user_id: OTHER_COACH,
      package_id: PKG_OTHER,
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'one_time',
      stripe_checkout_session_id: 'cs_test_123',
      status: 'paid',
      entitlement_active: true,
      access_expires_at: null,
      canceled_at: null,
      idempotency_key: 'stripe-key',
      source: null,
      grant_metadata: null,
    });
    await grants.claimFreePackage(client('client-other', OTHER_COACH), PKG_OTHER);
    expect(prisma._purchases).toHaveLength(2);

    await expect(
      grants.revoke(coachActor, { client_user_id: 'client-other' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const r = await grants.revoke(ownerActor, { client_user_id: 'client-other' });
    expect(r.revoked).toBe(1);
    expect(prisma._purchases.find((p) => p.id === 'cp-stripe')).toMatchObject({
      entitlement_active: true,
      status: 'paid',
    });
    expect(
      prisma._purchases.find((p) => p.source === GRANT_SOURCE.FREE_PACKAGE_CLAIM),
    ).toMatchObject({ entitlement_active: false });
  });
});
