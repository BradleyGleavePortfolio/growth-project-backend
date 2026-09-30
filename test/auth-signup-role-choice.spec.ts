import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthService } from '../src/auth/auth.service';
import { AppleAuthDto, GoogleAuthDto, RegisterDto, SignupWithCodeDto } from '../src/auth/auth.dto';
import { AuditAction, AuditService } from '../src/audit/audit.service';
import { CoachService } from '../src/coach/coach.service';
import {
  InviteCodesService,
  INVITE_ATTACH_COACH_CANNOT_REDEEM,
} from '../src/invite-codes/invite-codes.service';
import { normalizeEmail } from '../src/auth/email-normalize';

// Clinic launch C13 — signup-time client/coach role choice (+ fix round for
// the two independent T4 audits, Opus + Grok).
//
// Owner direction (2026-09-30): anyone who downloads the app can self-select
// client vs coach WHEN CREATING the account. The security design pinned here
// keeps the enterprise privilege-escalation concern (auth.service.ts, the
// become-coach hard gate) closed:
//
//   * `intended_role` only applies on the branch that inserts a brand-new User
//     row (register; google/apple first contact). Existing accounts are never
//     changed by it — including CASE VARIANTS of an existing email.
//   * A new coach gets, in ONE transaction, role 'coach' + coach_id null +
//     CoachSubscription {tier free, status active} (upsert with update:{}
//     exactly like becomeCoach) + a CoachProfile with a GP- invite code + the
//     user.role_changed audit row. Any failure inside rolls everything back;
//     the register path then deletes the orphaned Supabase auth user.
//   * A coach can never be demoted / re-parented by a client invite code
//     (`coach_cannot_redeem`), on any endpoint.
//   * /auth/signup-with-code always creates a client; 'coach' is refused with
//     a stable error code. invite_code + coach is refused on google/apple.
//   * /auth/become-coach stays hard-gated; /auth/select-role unchanged for
//     students and refuses coaches.
//   * SIGNUP_ROLE_CHOICE_ENABLED=false turns the whole feature into a no-op.
//
// The Prisma double below is deliberately more realistic than a call-count
// mock: unique constraints throw P2002, `$transaction` snapshots every table
// and RESTORES it when the callback throws, and the email lookup honours
// `mode: 'insensitive'`.

// Per-test Supabase stubs live on globalThis so the hoisted jest.mock factory
// can reach them. `hooks()` is the single any-typed view of that bag.
const hooks = (): any => globalThis;
// Reach the private `supabaseAdmin` slot the googleAuth specs override.
const asRecord = (obj: object): any => obj;

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signUp: (...args: any[]) => hooks().__supaSignUp?.(...args),
        signInWithIdToken: (...args: any[]) => hooks().__supaSignInWithIdToken?.(...args),
        signInWithPassword: jest.fn(async () => ({ error: { message: 'not mocked' } })),
        getUser: jest.fn(),
        resetPasswordForEmail: jest.fn(),
        admin: {
          deleteUser: (...args: any[]) => hooks().__supaAdminDeleteUser?.(...args),
        },
      },
    })),
  };
});

const makeInviteCodesMock = (): any => ({
  validate: jest.fn(),
  previewCode: jest.fn(async () => ({ valid: true })),
  attachUserToCoachByCode: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
});
const makeAnalyticsMock = (): any => ({
  capture: jest.fn(),
  identify: jest.fn(),
  onModuleDestroy: jest.fn(),
});
const makeVerifierMock = (configured: boolean): any => ({
  isConfigured: jest.fn(() => configured),
  getAudiences: jest.fn(() => (configured ? ['com.growthproject.app'] : [])),
  verify: jest.fn(),
});
const makeThrottleMock = (): any => ({
  consumeOAuthCoachSignupSlot: jest.fn(async () => {}),
  resetLoginCounters: jest.fn(async () => {}),
});

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

// In-memory Prisma double with real negative paths:
//   - unique constraints on User.email / User.supabase_id / CoachProfile.invite_code
//     / CoachSubscription.coach_id throw P2002;
//   - `$transaction(cb)` snapshots every table before running cb and restores
//     the snapshot when cb throws (a real rollback, not a call counter);
//   - `user.findFirst` honours `{ email: { equals, mode: 'insensitive' } }`.
// Per-table `failNext` hooks let a test inject a failure at a precise step.
function buildPrisma(seed: { users?: any[]; profiles?: any[]; subs?: any[]; audits?: any[] } = {}) {
  const state: any = {
    users: [...(seed.users ?? [])],
    profiles: [...(seed.profiles ?? [])],
    subs: [...(seed.subs ?? [])],
    audits: [...(seed.audits ?? [])],
  };
  let seq = 0;
  const failNext: Record<string, Error | undefined> = {};
  const maybeFail = (key: string) => {
    const err = failNext[key];
    if (err) {
      failNext[key] = undefined;
      throw err;
    }
  };

  const tables: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return state.users.find((u: any) => u.id === where.id) ?? null;
        if (where.email) return state.users.find((u: any) => u.email === where.email) ?? null;
        if (where.supabase_id)
          return state.users.find((u: any) => u.supabase_id === where.supabase_id) ?? null;
        return null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const cond = where?.email;
        if (cond && typeof cond === 'object' && cond.mode === 'insensitive') {
          const needle = String(cond.equals).toLowerCase();
          return state.users.find((u: any) => String(u.email).toLowerCase() === needle) ?? null;
        }
        if (typeof cond === 'string') return state.users.find((u: any) => u.email === cond) ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        maybeFail('user.create');
        if (state.users.some((u: any) => u.email === data.email)) throw p2002(['email']);
        if (data.supabase_id && state.users.some((u: any) => u.supabase_id === data.supabase_id))
          throw p2002(['supabase_id']);
        const row = { id: `u-${++seq}`, coach_id: null, archived_at: null, ...data };
        state.users.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.users.find((u: any) => u.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        state.users.filter(
          (u: any) =>
            (where.coach_id === undefined || u.coach_id === where.coach_id) &&
            (where.role === undefined || u.role === where.role) &&
            (where.archived_at === undefined || (u.archived_at ?? null) === where.archived_at),
        ),
      ),
    },
    coachSubscription: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          state.subs.find((s: any) => s.coach_id === where.coach_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        maybeFail('coachSubscription.upsert');
        const existing = state.subs.find((s: any) => s.coach_id === where.coach_id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `sub-${++seq}`, ...create };
        state.subs.push(row);
        return row;
      }),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.invite_code)
          return state.profiles.find((p: any) => p.invite_code === where.invite_code) ?? null;
        if (where.user_id)
          return state.profiles.find((p: any) => p.user_id === where.user_id) ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        maybeFail('coachProfile.create');
        if (state.profiles.some((p: any) => p.invite_code === data.invite_code))
          throw p2002(['invite_code']);
        const row = { id: `cp-${++seq}`, ...data };
        state.profiles.push(row);
        return row;
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        maybeFail('auditLog.create');
        const row = { id: `al-${++seq}`, created_at: new Date(), ...data };
        state.audits.push(row);
        return row;
      }),
    },
    // Not used by the auth paths but present so nothing type-errors if a
    // helper reaches for them.
    teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
    subCoachAssignment: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  tables.$transaction = jest.fn(async (cb: any) => {
    const snapshot = JSON.parse(JSON.stringify(state));
    try {
      return await cb(tables);
    } catch (err) {
      // Rollback: restore every table to its pre-transaction contents.
      for (const k of Object.keys(state)) {
        state[k].length = 0;
        state[k].push(...snapshot[k]);
      }
      throw err;
    }
  });
  tables._state = state;
  tables._failNext = failNext;
  Object.defineProperty(tables, '_users', { get: () => state.users });
  Object.defineProperty(tables, '_profiles', { get: () => state.profiles });
  Object.defineProperty(tables, '_subs', { get: () => state.subs });
  Object.defineProperty(tables, '_audits', { get: () => state.audits });
  return tables;
}

function buildService(prisma: any, opts: { apple?: boolean } = {}) {
  const inviteCodes = makeInviteCodesMock();
  const analytics = makeAnalyticsMock();
  // Real AuditService over the double: `write` swallows, `writeTx` throws.
  const audit = new AuditService(prisma);
  const appleVerifier = makeVerifierMock(opts.apple ?? false);
  const throttle = makeThrottleMock();
  const service = new AuthService(
    prisma,
    inviteCodes,
    analytics,
    audit,
    appleVerifier,
    makeVerifierMock(false),
    throttle,
  );
  return { service, inviteCodes, analytics, audit, appleVerifier, throttle };
}

const GOOD_PASSWORD = 'Aa1!aaaa';

function roleAudits(prisma: any) {
  return prisma._audits.filter((a: any) => a.action === AuditAction.USER_ROLE_CHANGED);
}

function expectCoachProvisioned(prisma: any, userId: string, provider: string) {
  const user = prisma._users.find((u: any) => u.id === userId);
  expect(user.role).toBe('coach');
  expect(user.coach_id).toBeNull();

  // Exactly one transaction wrapped the create + upsert + profile + audit.
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(prisma.coachSubscription.upsert).toHaveBeenCalledTimes(1);
  expect(prisma.coachSubscription.upsert).toHaveBeenCalledWith({
    where: { coach_id: userId },
    create: { coach_id: userId, tier: 'free', status: 'active' },
    update: {},
  });
  const sub = prisma._subs.find((s: any) => s.coach_id === userId);
  expect(sub).toEqual(expect.objectContaining({ tier: 'free', status: 'active' }));

  const profile = prisma._profiles.find((p: any) => p.user_id === userId);
  expect(profile).toBeDefined();
  expect(profile.invite_code).toMatch(/^GP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

  const audits = roleAudits(prisma);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toEqual(
    expect.objectContaining({
      actor_id: userId,
      actor_role: null, // there was no prior role
      target_user_id: userId,
      tenant_coach_id: userId,
      metadata: expect.objectContaining({
        from: null,
        to: 'coach',
        via: 'signup_role_choice',
        provider,
      }),
    }),
  );
  // The audit row was written through the transaction client (the double
  // hands the same table object to the tx callback, so the row is visible
  // in the auditLog.create calls; other best-effort audit rows — e.g. the
  // Apple sign-in row — may sit next to it).
  const roleChangedCreates = prisma.auditLog.create.mock.calls.filter(
    (c: any[]) => c[0]?.data?.action === AuditAction.USER_ROLE_CHANGED,
  );
  expect(roleChangedCreates).toHaveLength(1);
}

function expectNoCoachProvisioning(prisma: any) {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
  expect(prisma.coachProfile.create).not.toHaveBeenCalled();
  expect(roleAudits(prisma)).toHaveLength(0);
}

function expectNothingProvisioned(prisma: any) {
  expect(prisma._users.filter((u: any) => u.role === 'coach')).toHaveLength(0);
  expect(prisma._subs).toHaveLength(0);
  expect(prisma._profiles).toHaveLength(0);
  expect(prisma._audits).toHaveLength(0);
}

beforeEach(() => {
  hooks().__supaAdminDeleteUser = jest.fn(async () => ({ data: {}, error: null }));
  hooks().__supaSignUp = jest.fn(async ({ email }: any) => ({
    data: { user: { id: `sup-${email}`, identities: [{ provider: 'email' }] } },
    error: null,
  }));
  delete process.env.SIGNUP_ROLE_CHOICE_ENABLED;
});

describe('C13 signup-time role choice — POST /auth/register', () => {
  it('intended_role=coach creates a coach with a free/active subscription, profile and an in-transaction audit row', async () => {
    const prisma = buildPrisma();
    const { service, analytics } = buildService(prisma);
    const res = await service.register(
      {
        email: 'coach@example.test',
        password: GOOD_PASSWORD,
        name: 'Coach',
        intended_role: 'coach',
      },
      { ip: '1.2.3.4', userAgent: 'jest' },
    );
    expect(res.requires_verification).toBe(true);
    expect(res.role).toBe('coach');
    expectCoachProvisioned(prisma, res.user_id, 'email');
    // Audit carries the request context and never a password.
    const roleAudit = roleAudits(prisma)[0];
    expect(roleAudit.ip).toBe('1.2.3.4');
    expect(roleAudit.user_agent).toBe('jest');
    expect(JSON.stringify(roleAudit)).not.toContain(GOOD_PASSWORD);
    expect(analytics.capture).toHaveBeenCalledWith(
      res.user_id,
      'coach_promoted',
      expect.objectContaining({ via: 'signup_role_choice', provider: 'email' }),
    );
    // Email verification behaviour unchanged: Supabase signUp still ran, and
    // no compensation was needed.
    expect(hooks().__supaSignUp).toHaveBeenCalledTimes(1);
    expect(hooks().__supaAdminDeleteUser).not.toHaveBeenCalled();
  });

  it('defaults to a client (student) with no transaction, subscription, profile or audit', async () => {
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    const res = await service.register({
      email: 'c@example.test',
      password: GOOD_PASSWORD,
      name: 'Client',
    });
    expect(res.role).toBe('student');
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        supabase_id: 'sup-c@example.test',
        email: 'c@example.test',
        name: 'Client',
        phone: null,
        role: 'student',
        signup_ref: null,
      },
    });
    expectNoCoachProvisioning(prisma);
  });

  it("intended_role='client' is the same as omitting it", async () => {
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    const res = await service.register({
      email: 'c2@example.test',
      password: GOOD_PASSWORD,
      name: 'Client',
      intended_role: 'client',
    });
    expect(res.role).toBe('student');
    expectNoCoachProvisioning(prisma);
  });

  it('a duplicate email is still refused before any provisioning', async () => {
    const prisma = buildPrisma({
      users: [
        { id: 'u-existing', email: 'dup@example.test', role: 'student', coach_id: 'coach-1' },
      ],
    });
    const { service } = buildService(prisma);
    await expect(
      service.register({
        email: 'dup@example.test',
        password: GOOD_PASSWORD,
        name: 'Dup',
        intended_role: 'coach',
      }),
    ).rejects.toThrow('Email already registered');
    expectNoCoachProvisioning(prisma);
    expect(hooks().__supaSignUp).not.toHaveBeenCalled();
    expect(prisma._users[0].role).toBe('student');
  });

  // Grok A1 / Opus C2 — email canonicalisation.
  describe('email normalisation (Grok A1 / Opus C2)', () => {
    it('normalizeEmail: NFKC + trim + lowercase', () => {
      expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com');
      expect(normalizeEmail('\uFB01re@Example.com')).toBe('fire@example.com'); // ﬁ ligature
      expect(normalizeEmail('\uFF4A\uFF41\uFF4E\uFF45@example.com')).toBe('jane@example.com'); // fullwidth
    });

    it('a CASE VARIANT of an existing student (with coach_id) is a duplicate, not a new coach', async () => {
      const prisma = buildPrisma({
        users: [
          {
            id: 'u-jane',
            supabase_id: 'sup-jane',
            email: 'Jane@Example.com',
            role: 'student',
            coach_id: 'coach-1',
          },
        ],
      });
      const { service } = buildService(prisma);
      await expect(
        service.register({
          email: 'jane@example.com',
          password: GOOD_PASSWORD,
          name: 'Impostor',
          intended_role: 'coach',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(hooks().__supaSignUp).not.toHaveBeenCalled();
      expect(prisma._users).toHaveLength(1);
      expect(prisma._users[0]).toEqual(
        expect.objectContaining({ role: 'student', coach_id: 'coach-1' }),
      );
      expectNoCoachProvisioning(prisma);
    });

    it('a CASE VARIANT of an existing OWNER is a duplicate too', async () => {
      const prisma = buildPrisma({
        users: [{ id: 'u-owner', supabase_id: 'sup-o', email: 'Owner@Example.com', role: 'owner' }],
      });
      const { service } = buildService(prisma);
      await expect(
        service.register({
          email: 'OWNER@example.com',
          password: GOOD_PASSWORD,
          name: 'X',
          intended_role: 'coach',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma._users).toHaveLength(1);
      expect(prisma._users[0].role).toBe('owner');
    });

    it('stores and sends the canonical lowercase address', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      const res = await service.register({
        email: '  New.Coach@Example.COM ',
        password: GOOD_PASSWORD,
        name: 'NC',
        intended_role: 'coach',
      });
      expect(res.email).toBe('new.coach@example.com');
      expect(hooks().__supaSignUp).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new.coach@example.com' }),
      );
      expect(prisma._users[0].email).toBe('new.coach@example.com');
    });
  });

  // Grok B3 / Opus C2 — Supabase enumeration protection.
  it("Supabase's obfuscated 'already registered' user (identities: []) is a 409 and creates nothing", async () => {
    hooks().__supaSignUp = jest.fn(async () => ({
      data: { user: { id: 'sup-placeholder', identities: [] } },
      error: null,
    }));
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    await expect(
      service.register({
        email: 'taken@example.test',
        password: GOOD_PASSWORD,
        name: 'T',
        intended_role: 'coach',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expectNothingProvisioned(prisma);
    // The placeholder is Supabase's, not ours: no compensation.
    expect(hooks().__supaAdminDeleteUser).not.toHaveBeenCalled();
  });

  // Opus B3 / Grok B2 — atomic audit; Opus C7 — real rollback paths.
  describe('atomicity and compensation (Opus B3, C1, C7 / Grok B2, B3)', () => {
    it('the coach invite code is allocated BEFORE Supabase signUp', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      const order: string[] = [];
      prisma.coachProfile.findUnique.mockImplementation(async () => {
        order.push('pick-code');
        return null;
      });
      hooks().__supaSignUp = jest.fn(async ({ email }: any) => {
        order.push('signUp');
        return {
          data: { user: { id: `sup-${email}`, identities: [{ provider: 'email' }] } },
          error: null,
        };
      });
      await service.register({
        email: 'order@example.test',
        password: GOOD_PASSWORD,
        name: 'O',
        intended_role: 'coach',
      });
      expect(order.indexOf('pick-code')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('pick-code')).toBeLessThan(order.indexOf('signUp'));
    });

    it('a CoachProfile insert failure rolls back the User + CoachSubscription + audit rows and deletes the Supabase user', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      prisma._failNext['coachProfile.create'] = new Error('db blip');
      await expect(
        service.register(
          {
            email: 'rollback@example.test',
            password: GOOD_PASSWORD,
            name: 'R',
            intended_role: 'coach',
          },
          { ip: '5.5.5.5' },
        ),
      ).rejects.toThrow('db blip');
      // Everything the transaction wrote is gone.
      expect(prisma._users).toHaveLength(0);
      expectNothingProvisioned(prisma);
      // Compensation: the Supabase auth user created by signUp is deleted…
      expect(hooks().__supaAdminDeleteUser).toHaveBeenCalledTimes(1);
      expect(hooks().__supaAdminDeleteUser).toHaveBeenCalledWith('sup-rollback@example.test');
    });

    it('an AUDIT write failure fails the signup and rolls the coach back (audit is not optional)', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      prisma._failNext['auditLog.create'] = new Error('audit table unavailable');
      await expect(
        service.register({
          email: 'noaudit@example.test',
          password: GOOD_PASSWORD,
          name: 'N',
          intended_role: 'coach',
        }),
      ).rejects.toThrow('audit table unavailable');
      expect(prisma._users).toHaveLength(0);
      expectNothingProvisioned(prisma);
      expect(hooks().__supaAdminDeleteUser).toHaveBeenCalledWith('sup-noaudit@example.test');
    });

    it('AUDIT_LOGGING_ENABLED=off does NOT skip the role_changed row (writeTx ignores the kill switch)', async () => {
      const prev = process.env.AUDIT_LOGGING_ENABLED;
      process.env.AUDIT_LOGGING_ENABLED = 'off';
      try {
        const prisma = buildPrisma();
        const { service } = buildService(prisma);
        const res = await service.register({
          email: 'auditoff@example.test',
          password: GOOD_PASSWORD,
          name: 'A',
          intended_role: 'coach',
        });
        expectCoachProvisioned(prisma, res.user_id, 'email');
      } finally {
        if (prev === undefined) delete process.env.AUDIT_LOGGING_ENABLED;
        else process.env.AUDIT_LOGGING_ENABLED = prev;
      }
    });

    it('a client-path User insert failure also deletes the Supabase user, and the error is rethrown unchanged', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      prisma._failNext['user.create'] = p2002(['supabase_id']);
      await expect(
        service.register({ email: 'race@example.test', password: GOOD_PASSWORD, name: 'R' }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(hooks().__supaAdminDeleteUser).toHaveBeenCalledWith('sup-race@example.test');
    });

    it('compensation failure is logged (id only, no email/password) and the original error still surfaces', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      prisma._failNext['coachProfile.create'] = new Error('original');
      hooks().__supaSignUp = jest.fn(async () => ({
        data: { user: { id: 'sup-opaque-1', identities: [{ provider: 'email' }] } },
        error: null,
      }));
      hooks().__supaAdminDeleteUser = jest.fn(async () => ({
        data: null,
        error: { message: 'admin api down' },
      }));
      const logger = asRecord(service).logger;
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      await expect(
        service.register({
          email: 'secret.person@example.test',
          password: GOOD_PASSWORD,
          name: 'S',
          intended_role: 'coach',
        }),
      ).rejects.toThrow('original');
      const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => c.map(String).join(' '))
        .join('\n');
      expect(logged).toContain('sup-opaque-1');
      expect(logged).toContain('admin api down');
      expect(logged).not.toContain('secret.person');
      expect(logged).not.toContain(GOOD_PASSWORD);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('an invite-code P2002 race retries the transaction with a fresh code (and nothing else)', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      // First attempt: the pre-checked code is stolen between check and insert.
      prisma._failNext['coachProfile.create'] = p2002(['CoachProfile_invite_code_key']);
      const res = await service.register({
        email: 'retry@example.test',
        password: GOOD_PASSWORD,
        name: 'R',
        intended_role: 'coach',
      });
      expect(res.role).toBe('coach');
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      // The rolled-back first attempt left no duplicate rows behind.
      expect(prisma._users).toHaveLength(1);
      expect(prisma._subs).toHaveLength(1);
      expect(prisma._profiles).toHaveLength(1);
      expect(roleAudits(prisma)).toHaveLength(1);
      expect(hooks().__supaAdminDeleteUser).not.toHaveBeenCalled();
    });

    it('an email P2002 (a real duplicate) is NOT retried', async () => {
      const prisma = buildPrisma();
      const { service } = buildService(prisma);
      prisma._failNext['user.create'] = p2002(['email']);
      await expect(
        service.register({
          email: 'dup2@example.test',
          password: GOOD_PASSWORD,
          name: 'D',
          intended_role: 'coach',
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});

describe('C13 signup-time role choice — POST /auth/google', () => {
  const googleSupaUser = (id: string, email: string, extra: Record<string, unknown> = {}) => ({
    id,
    email,
    email_confirmed_at: '2026-09-30T00:00:00Z',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: 'G User' },
    identities: [{ provider: 'google', identity_data: { email_verified: true } }],
    ...extra,
  });

  function withAdmin(service: AuthService, supaUser: any) {
    const getUser = jest.fn(async () => ({ data: { user: supaUser }, error: null }));
    asRecord(service).supabaseAdmin = { auth: { getUser } };
    return getUser;
  }

  it('new user with intended_role=coach is provisioned as a coach, audited with IP/UA and counted against the coach-signup throttle', async () => {
    const prisma = buildPrisma();
    const { service, throttle } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g1', 'g1@example.test'));
    const res = await service.googleAuth('tok', undefined, 'coach', {
      ip: '7.7.7.7',
      userAgent: 'android',
    });
    expect(res.is_new_user).toBe(true);
    expect(res.user.role).toBe('coach');
    expectCoachProvisioned(prisma, res.user.id, 'google');
    // Opus C5 / Grok B1 — request context reaches the audit row.
    const audit = roleAudits(prisma)[0];
    expect(audit.ip).toBe('7.7.7.7');
    expect(audit.user_agent).toBe('android');
    // Grok B5 — per-IP coach-create slot consumed BEFORE the row exists.
    expect(throttle.consumeOAuthCoachSignupSlot).toHaveBeenCalledWith('7.7.7.7');
  });

  it('new user without intended_role is a student (unchanged legacy shape) and does not touch the coach-signup throttle', async () => {
    const prisma = buildPrisma();
    const { service, throttle } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g2', 'g2@example.test'));
    const res = await service.googleAuth('tok');
    expect(res.user.role).toBe('student');
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { supabase_id: 'sup-g2', email: 'g2@example.test', name: 'G User', role: 'student' },
    });
    expectNoCoachProvisioning(prisma);
    expect(throttle.consumeOAuthCoachSignupSlot).not.toHaveBeenCalled();
  });

  it('when the coach-signup throttle refuses, no row of any kind is created', async () => {
    const prisma = buildPrisma();
    const { service, throttle } = buildService(prisma);
    throttle.consumeOAuthCoachSignupSlot.mockRejectedValueOnce(new ThrottlerException());
    withAdmin(service, googleSupaUser('sup-g5', 'g5@example.test'));
    await expect(
      service.googleAuth('tok', undefined, 'coach', { ip: '8.8.8.8' }),
    ).rejects.toBeInstanceOf(ThrottlerException);
    expect(prisma._users).toHaveLength(0);
    expectNothingProvisioned(prisma);
  });

  it('EXISTING user (matched by supabase_id) sending intended_role=coach stays exactly as they were', async () => {
    const existing = {
      id: 'u-student',
      supabase_id: 'sup-g3',
      email: 'g3@example.test',
      name: 'Student',
      role: 'student',
      coach_id: 'coach-1',
    };
    const prisma = buildPrisma({ users: [{ ...existing }] });
    const { service } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g3', 'g3@example.test'));
    const res = await service.googleAuth('tok', undefined, 'coach');
    expect(res.is_new_user).toBe(false);
    expect(res.user.role).toBe('student');
    expect(res.user.coach_id).toBe('coach-1');
    expect(prisma._users[0]).toEqual(existing);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expectNoCoachProvisioning(prisma);
  });

  it('EXISTING email-registered user (legacy row, supabase_id null) being linked with intended_role=coach keeps their role', async () => {
    const prisma = buildPrisma({
      users: [
        {
          id: 'u-email',
          supabase_id: null,
          email: 'g4@example.test',
          name: 'E',
          role: 'student',
          coach_id: 'coach-1',
        },
      ],
    });
    const { service } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g4', 'g4@example.test'));
    const res = await service.googleAuth('tok', undefined, 'coach');
    expect(res.is_new_user).toBe(false);
    expect(res.user.role).toBe('student');
    expect(prisma._users[0].role).toBe('student');
    expect(prisma._users[0].coach_id).toBe('coach-1');
    // Only the supabase_id linkage was written.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u-email' },
      data: { supabase_id: 'sup-g4' },
    });
    expectNoCoachProvisioning(prisma);
  });

  // Grok A1 — case variant + a DIFFERENT supabase_id (the realistic case: the
  // email/password account and the Google identity are two Supabase users).
  it('a CASE VARIANT of an existing email with a different supabase_id is refused (401) and no second row is inserted', async () => {
    const existing = {
      id: 'u-jane',
      supabase_id: 'sup-jane-email',
      email: 'Jane@Example.com',
      name: 'Jane',
      role: 'student',
      coach_id: 'coach-1',
    };
    const prisma = buildPrisma({ users: [{ ...existing }] });
    const { service } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-jane-google', 'jane@example.com'));
    await expect(service.googleAuth('tok', undefined, 'coach')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0]).toEqual(existing);
    expectNoCoachProvisioning(prisma);
  });

  it('a CASE VARIANT of an existing OWNER with a different supabase_id is refused the same way', async () => {
    const prisma = buildPrisma({
      users: [
        { id: 'u-o', supabase_id: 'sup-o', email: 'Boss@Example.com', role: 'owner', name: 'B' },
      ],
    });
    const { service } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-o-google', 'boss@example.com'));
    await expect(service.googleAuth('tok', undefined, 'coach')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0].role).toBe('owner');
  });

  // Grok B4 — unverified Google email.
  it('an UNVERIFIED Google email cannot create (or link) a row: 401, nothing written', async () => {
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    withAdmin(
      service,
      googleSupaUser('sup-unv', 'unverified@example.test', {
        email_confirmed_at: null,
        identities: [{ provider: 'google', identity_data: { email_verified: false } }],
      }),
    );
    await expect(service.googleAuth('tok', undefined, 'coach')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma._users).toHaveLength(0);
    expectNothingProvisioned(prisma);
  });

  it('an unverified email is still accepted for a RETURNING user matched by supabase_id (no create/link involved)', async () => {
    const prisma = buildPrisma({
      users: [
        {
          id: 'u-r',
          supabase_id: 'sup-r',
          email: 'r@example.test',
          role: 'student',
          coach_id: null,
          name: 'R',
        },
      ],
    });
    const { service } = buildService(prisma);
    withAdmin(
      service,
      googleSupaUser('sup-r', 'r@example.test', {
        email_confirmed_at: null,
        identities: [{ provider: 'google' }],
      }),
    );
    const res = await service.googleAuth('tok');
    expect(res.is_new_user).toBe(false);
    expect(res.user.id).toBe('u-r');
  });

  it('intended_role=coach together with an invite_code is refused before any Supabase call', async () => {
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    const getUser = jest.fn();
    asRecord(service).supabaseAdmin = { auth: { getUser } };
    let caught: any;
    try {
      await service.googleAuth('tok', 'GP-ABC123', 'coach');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.getResponse()).toEqual(
      expect.objectContaining({ error: 'intended_role_not_allowed_with_invite_code' }),
    );
    expect(getUser).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  // Opus B1 / Grok A2 — an existing coach + a stale QR / deep-link code.
  it('an EXISTING signup coach signing in with an invite_code (no intended_role) is never demoted or attached', async () => {
    const prisma = buildPrisma();
    const { service, inviteCodes } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-c', 'c@example.test'));
    const created = await service.googleAuth('tok', undefined, 'coach');
    expect(created.user.role).toBe('coach');

    // Second sign-in, this time with a client's invite code in the body.
    const res = await service.googleAuth('tok', 'GP-CLIENT1');
    expect(res.is_new_user).toBe(false);
    expect(res.invite_attached).toBe(false);
    expect(res.user.role).toBe('coach');
    expect(res.user.coach_id).toBeNull();
    expect(inviteCodes.attachUserToCoachByCode).not.toHaveBeenCalled();
    const row = prisma._users.find((u: any) => u.id === created.user.id);
    expect(row.role).toBe('coach');
    expect(row.coach_id).toBeNull();
  });

  it('an EXISTING owner signing in with an invite_code is never attached either', async () => {
    const prisma = buildPrisma({
      users: [
        {
          id: 'u-o',
          supabase_id: 'sup-o',
          email: 'o@example.test',
          role: 'owner',
          coach_id: null,
          name: 'O',
        },
      ],
    });
    const { service, inviteCodes } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-o', 'o@example.test'));
    const res = await service.googleAuth('tok', 'GP-CLIENT1');
    expect(res.user.role).toBe('owner');
    expect(inviteCodes.attachUserToCoachByCode).not.toHaveBeenCalled();
  });

  it('a STUDENT signing in with an invite_code is still attached (unchanged)', async () => {
    const prisma = buildPrisma({
      users: [
        {
          id: 'u-s',
          supabase_id: 'sup-s',
          email: 's@example.test',
          role: 'student',
          coach_id: null,
          name: 'S',
        },
      ],
    });
    const { service, inviteCodes } = buildService(prisma);
    inviteCodes.attachUserToCoachByCode.mockImplementation(async (id: string) => {
      const row = prisma._users.find((u: any) => u.id === id);
      row.coach_id = 'coach-1';
      return { role: 'student', coach_id: 'coach-1' };
    });
    withAdmin(service, googleSupaUser('sup-s', 's@example.test'));
    const res = await service.googleAuth('tok', 'GP-CLIENT1');
    expect(res.invite_attached).toBe(true);
    expect(res.user.coach_id).toBe('coach-1');
  });
});

describe('C13 signup-time role choice — POST /auth/apple', () => {
  const appleSession = (id: string, email: string) => ({
    data: {
      session: { access_token: 'at', refresh_token: 'rt' },
      user: { id, email, user_metadata: {} },
    },
    error: null,
  });

  beforeEach(() => {
    hooks().__supaSignInWithIdToken = undefined;
  });

  it('new user with intended_role=coach is provisioned as a coach (audited, throttled)', async () => {
    const prisma = buildPrisma();
    const { service, appleVerifier, throttle } = buildService(prisma, { apple: true });
    appleVerifier.verify.mockResolvedValue({ sub: 'apple-1', email: 'a1@example.test' });
    hooks().__supaSignInWithIdToken = jest.fn(async () =>
      appleSession('sup-a1', 'a1@example.test'),
    );
    const res = await service.appleAuth(
      'apple-token',
      'Apple Coach',
      undefined,
      { ip: '9.9.9.9', userAgent: 'ios' },
      undefined,
      'coach',
    );
    expect(res.is_new_user).toBe(true);
    expect(res.user.role).toBe('coach');
    expect(res.user.name).toBe('Apple Coach');
    expectCoachProvisioned(prisma, res.user.id, 'apple');
    expect(roleAudits(prisma)[0].ip).toBe('9.9.9.9');
    expect(throttle.consumeOAuthCoachSignupSlot).toHaveBeenCalledWith('9.9.9.9');
    // The pre-existing Apple sign-in audit row is still written too
    // (best-effort `write`, goes through the same auditLog table).
    expect(prisma._audits.map((a: any) => a.action)).toContain(AuditAction.AUTH_APPLE_SIGNIN);
  });

  it('EXISTING user sending intended_role=coach stays exactly as they were', async () => {
    const existing = {
      id: 'u-apple-student',
      supabase_id: 'sup-a2',
      email: 'a2@example.test',
      name: 'A Student',
      role: 'student',
      coach_id: 'coach-1',
    };
    const prisma = buildPrisma({ users: [{ ...existing }] });
    const { service, appleVerifier } = buildService(prisma, { apple: true });
    appleVerifier.verify.mockResolvedValue({ sub: 'apple-2', email: 'a2@example.test' });
    hooks().__supaSignInWithIdToken = jest.fn(async () =>
      appleSession('sup-a2', 'a2@example.test'),
    );
    const res = await service.appleAuth(
      'apple-token',
      undefined,
      undefined,
      {},
      undefined,
      'coach',
    );
    expect(res.is_new_user).toBe(false);
    expect(res.user.role).toBe('student');
    expect(res.user.coach_id).toBe('coach-1');
    expect(prisma._users[0]).toEqual(existing);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expectNoCoachProvisioning(prisma);
  });

  it('a CASE VARIANT of an existing email (different supabase_id) is refused and not re-created as a coach', async () => {
    const prisma = buildPrisma({
      users: [
        {
          id: 'u-j',
          supabase_id: 'sup-j-email',
          email: 'Jane@Example.com',
          role: 'student',
          coach_id: 'coach-1',
          name: 'J',
        },
      ],
    });
    const { service, appleVerifier } = buildService(prisma, { apple: true });
    appleVerifier.verify.mockResolvedValue({ sub: 'apple-j', email: 'JANE@example.com' });
    hooks().__supaSignInWithIdToken = jest.fn(async () =>
      appleSession('sup-j-apple', 'jane@example.com'),
    );
    await expect(
      service.appleAuth('apple-token', undefined, undefined, {}, undefined, 'coach'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma._users).toHaveLength(1);
    expectNoCoachProvisioning(prisma);
  });

  it('an EXISTING signup coach signing in with an invite_code is never demoted or attached', async () => {
    const prisma = buildPrisma({
      users: [
        {
          id: 'u-c',
          supabase_id: 'sup-c',
          email: 'c@example.test',
          role: 'coach',
          coach_id: null,
          name: 'C',
        },
      ],
    });
    const { service, appleVerifier, inviteCodes } = buildService(prisma, { apple: true });
    appleVerifier.verify.mockResolvedValue({ sub: 'apple-c', email: 'c@example.test' });
    hooks().__supaSignInWithIdToken = jest.fn(async () => appleSession('sup-c', 'c@example.test'));
    const res = await service.appleAuth('apple-token', undefined, 'GP-CLIENT1', {});
    expect(res.invite_attached).toBe(false);
    expect(res.user.role).toBe('coach');
    expect(res.user.coach_id).toBeNull();
    expect(inviteCodes.attachUserToCoachByCode).not.toHaveBeenCalled();
    expect(prisma._users[0]).toEqual(expect.objectContaining({ role: 'coach', coach_id: null }));
  });

  it('intended_role=coach together with an invite_code is refused before verification', async () => {
    const prisma = buildPrisma();
    const { service, appleVerifier } = buildService(prisma, { apple: true });
    await expect(
      service.appleAuth('apple-token', undefined, 'GP-ABC123', {}, undefined, 'coach'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(appleVerifier.verify).not.toHaveBeenCalled();
  });
});

describe('C13 signup-time role choice — /auth/signup-with-code always creates a client', () => {
  const ORIG = process.env.COACH_CODE_GATE_ENABLED;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.COACH_CODE_GATE_ENABLED;
    else process.env.COACH_CODE_GATE_ENABLED = ORIG;
  });

  it("refuses intended_role='coach' + invite_code with a stable error code before Supabase signUp", async () => {
    delete process.env.COACH_CODE_GATE_ENABLED;
    const signUp = jest.fn();
    hooks().__supaSignUp = signUp;
    const prisma = buildPrisma();
    const { service, inviteCodes } = buildService(prisma);
    let caught: any;
    try {
      await service.signupWithCode({
        email: 'x@example.test',
        password: GOOD_PASSWORD,
        name: 'X',
        invite_code: 'GP-ABC123',
        intended_role: 'coach',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.getResponse()).toEqual(
      expect.objectContaining({ error: 'intended_role_not_allowed_with_invite_code' }),
    );
    expect(signUp).not.toHaveBeenCalled();
    expect(inviteCodes.previewCode).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("refuses intended_role='coach' WITHOUT a code with a code that names the endpoint (Grok C2)", async () => {
    delete process.env.COACH_CODE_GATE_ENABLED;
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    let caught: any;
    try {
      await service.signupWithCode({
        email: 'x@example.test',
        password: GOOD_PASSWORD,
        name: 'X',
        intended_role: 'coach',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.getResponse()).toEqual(
      expect.objectContaining({ error: 'coach_signup_requires_register_endpoint' }),
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("intended_role='client' signs up as a student and is attached to the coach", async () => {
    delete process.env.COACH_CODE_GATE_ENABLED;
    hooks().__supaSignUp = jest.fn(async () => ({
      data: { user: { id: 'sup-swc', identities: [{ provider: 'email' }] } },
      error: null,
    }));
    const prisma = buildPrisma();
    const { service, inviteCodes } = buildService(prisma);
    const res = await service.signupWithCode({
      email: 'y@example.test',
      password: GOOD_PASSWORD,
      name: 'Y',
      invite_code: 'GP-ABC123',
      intended_role: 'client',
    });
    expect(res.role).toBe('student');
    expect(inviteCodes.attachUserToCoachByCode).toHaveBeenCalledWith(res.user_id, 'GP-ABC123');
    expectNoCoachProvisioning(prisma);
  });
});

describe('C13 — SIGNUP_ROLE_CHOICE_ENABLED kill switch (Opus B2 / Grok C7)', () => {
  afterEach(() => {
    delete process.env.SIGNUP_ROLE_CHOICE_ENABLED;
  });

  it("'false' makes intended_role=coach a plain client signup and hides the picker in signup-policy", async () => {
    process.env.SIGNUP_ROLE_CHOICE_ENABLED = 'false';
    const prisma = buildPrisma();
    const { service } = buildService(prisma);
    const res = await service.register({
      email: 'ks@example.test',
      password: GOOD_PASSWORD,
      name: 'K',
      intended_role: 'coach',
    });
    expect(res.role).toBe('student');
    expectNoCoachProvisioning(prisma);
    const policy: any = service.getSignupPolicy();
    expect(policy.role_choice).toBe(false);
    expect(policy.role_choice_field).toBe('intended_role');
  });

  it("'false' also neutralises google/apple coach creation and the signup-with-code refusal", async () => {
    process.env.SIGNUP_ROLE_CHOICE_ENABLED = 'false';
    const prisma = buildPrisma();
    const { service, throttle } = buildService(prisma);
    asRecord(service).supabaseAdmin = {
      auth: {
        getUser: jest.fn(async () => ({
          data: {
            user: {
              id: 'sup-ks',
              email: 'ks-g@example.test',
              email_confirmed_at: 'x',
              app_metadata: { provider: 'google', providers: ['google'] },
              user_metadata: {},
              identities: [{ provider: 'google' }],
            },
          },
          error: null,
        })),
      },
    };
    const g = await service.googleAuth('tok', undefined, 'coach');
    expect(g.user.role).toBe('student');
    expect(throttle.consumeOAuthCoachSignupSlot).not.toHaveBeenCalled();
    // invite_code + coach is no longer a contradiction when coach is ignored.
    hooks().__supaSignUp = jest.fn(async () => ({
      data: { user: { id: 'sup-swc2', identities: [{ provider: 'email' }] } },
      error: null,
    }));
    const s = await service.signupWithCode({
      email: 'ks2@example.test',
      password: GOOD_PASSWORD,
      name: 'K2',
      invite_code: 'GP-ABC123',
      intended_role: 'coach',
    });
    expect(s.role).toBe('student');
    expectNoCoachProvisioning(prisma);
  });

  it('unset / true / anything else keeps the feature on', () => {
    const { service } = buildService(buildPrisma());
    delete process.env.SIGNUP_ROLE_CHOICE_ENABLED;
    expect(asRecord(service.getSignupPolicy()).role_choice).toBe(true);
    process.env.SIGNUP_ROLE_CHOICE_ENABLED = 'true';
    expect(asRecord(service.getSignupPolicy()).role_choice).toBe(true);
    process.env.SIGNUP_ROLE_CHOICE_ENABLED = '0';
    expect(asRecord(service.getSignupPolicy()).role_choice).toBe(false);
    process.env.SIGNUP_ROLE_CHOICE_ENABLED = 'off';
    expect(asRecord(service.getSignupPolicy()).role_choice).toBe(false);
  });
});

describe('C13 — coach_cannot_redeem (Opus B1 / Grok A2)', () => {
  function buildInviteCodes(users: any[]) {
    const prisma: any = {
      coachProfile: {
        findUnique: jest.fn(async () => ({
          user: { id: 'coach-x', role: 'coach' },
        })),
      },
      coachSubscription: {
        findUnique: jest.fn(async () => ({ status: 'active' })),
      },
      user: {
        findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };
    const analytics: any = { capture: jest.fn() };
    const email: any = { send: jest.fn() };
    const audit: any = { write: jest.fn() };
    const svc = new InviteCodesService(prisma, analytics, email, audit);
    return { svc, prisma };
  }

  for (const role of ['coach', 'sub_coach'] as const) {
    it(`InviteCodesService.attachUserToCoachByCode refuses a ${role} with 403 { code: 'coach_cannot_redeem' } and writes nothing`, async () => {
      const { svc, prisma } = buildInviteCodes([
        { id: 'me', role, coach_id: null, email: 'me@x.test' },
      ]);
      let caught: any;
      try {
        await svc.attachUserToCoachByCode('me', 'GP-COACHX');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect(caught.getResponse()).toEqual(
        expect.objectContaining({ code: INVITE_ATTACH_COACH_CANNOT_REDEEM }),
      );
      expect(INVITE_ATTACH_COACH_CANNOT_REDEEM).toBe('coach_cannot_redeem');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  }

  it('InviteCodesService still attaches a student (unchanged)', async () => {
    const { svc, prisma } = buildInviteCodes([
      { id: 'stu', role: 'student', coach_id: null, email: 's@x.test' },
    ]);
    prisma.user.update.mockResolvedValue({ role: 'student', coach_id: 'coach-x' });
    const res = await svc.attachUserToCoachByCode('stu', 'GP-COACHX');
    expect(res).toEqual({ role: 'student', coach_id: 'coach-x' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'stu' },
      data: { role: 'student', coach_id: 'coach-x' },
    });
  });

  it('POST /auth/select-role refuses to demote a coach to student (with or without a code) using the same code', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u-c', email: 'c@example.test', role: 'coach', coach_id: null }],
    });
    const { service, inviteCodes } = buildService(prisma);
    for (const code of [undefined, 'GP-CLIENT1']) {
      let caught: any;
      try {
        await service.selectRole('u-c', 'student', code);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect(caught.getResponse()).toEqual(
        expect.objectContaining({ code: 'coach_cannot_redeem' }),
      );
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(inviteCodes.validate).not.toHaveBeenCalled();
    expect(prisma._users[0]).toEqual(expect.objectContaining({ role: 'coach', coach_id: null }));
  });

  it('POST /auth/select-role still lets a student pick student (unchanged)', async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u-s', email: 's@example.test', role: 'student', coach_id: null }],
    });
    const { service } = buildService(prisma);
    const res = await service.selectRole('u-s', 'student');
    expect(res.role).toBe('student');
  });
});

describe('C13 — existing escalation gates are untouched', () => {
  const ORIG = process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    else process.env.ALLOW_SELF_SERVICE_BECOME_COACH = ORIG;
  });

  it('POST /auth/become-coach is still hard-gated (403 self_service_promotion_disabled)', async () => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    const prisma = buildPrisma({
      users: [{ id: 'u-s', email: 's@example.test', role: 'student', coach_id: 'coach-1' }],
    });
    const { service } = buildService(prisma);
    let caught: any;
    try {
      await service.becomeCoach('u-s', 'irrelevant');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught.getResponse()).toEqual(
      expect.objectContaining({ error: 'self_service_promotion_disabled' }),
    );
    expect(prisma._users[0].role).toBe('student');
    expectNoCoachProvisioning(prisma);
  });

  it("POST /auth/select-role still refuses role='coach'", async () => {
    const prisma = buildPrisma({
      users: [{ id: 'u-s', email: 's@example.test', role: 'student', coach_id: null }],
    });
    const { service } = buildService(prisma);
    await expect(service.selectRole('u-s', 'coach')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma._users[0].role).toBe('student');
  });
});

describe('C13 — DTO enum validation', () => {
  const cases: Array<[string, any, Record<string, unknown>]> = [
    ['RegisterDto', RegisterDto, { email: 'a@b.co', password: GOOD_PASSWORD, name: 'A' }],
    ['GoogleAuthDto', GoogleAuthDto, { token: 'x'.repeat(20) }],
    ['AppleAuthDto', AppleAuthDto, { token: 'x'.repeat(20) }],
    [
      'SignupWithCodeDto',
      SignupWithCodeDto,
      { email: 'a@b.co', password: GOOD_PASSWORD, name: 'A' },
    ],
  ];

  for (const [label, Dto, base] of cases) {
    it(`${label}: accepts client|coach|omitted and rejects owner/student/garbage`, async () => {
      for (const ok of [undefined, 'client', 'coach']) {
        const dto = plainToInstance(Dto, ok === undefined ? base : { ...base, intended_role: ok });
        expect(await validate(dto as object)).toEqual([]);
      }
      for (const bad of ['owner', 'student', 'admin', 'Coach', '', 1, true, {}]) {
        const dto = plainToInstance(Dto, { ...base, intended_role: bad });
        const errors = await validate(dto as object);
        expect(errors.map((e) => e.property)).toContain('intended_role');
      }
    });
  }
});

describe('C13 — signup policy advertises role choice', () => {
  it('role_choice:true plus the legacy fields other clients read', () => {
    const { service } = buildService(buildPrisma());
    const policy: any = service.getSignupPolicy();
    expect(policy.role_choice).toBe(true);
    expect(policy.role_choice_field).toBe('intended_role');
    expect(policy.role_choice_values).toEqual(['client', 'coach']);
    expect(policy).toEqual(
      expect.objectContaining({
        invite_code_required: expect.any(Boolean),
        coach_code_required: expect.any(Boolean),
        providers: expect.arrayContaining(['email']),
        invite_code_field: 'invite_code',
      }),
    );
  });
});

describe('C13 — tenancy smoke: a brand-new coach sees zero clients', () => {
  it('CoachService.getClients scopes by coach_id, so other coaches\u2019 students are invisible', async () => {
    const prisma = buildPrisma({
      users: [
        { id: 'other-coach', email: 'oc@example.test', role: 'coach', coach_id: null },
        { id: 's1', email: 's1@example.test', role: 'student', coach_id: 'other-coach' },
        { id: 's2', email: 's2@example.test', role: 'student', coach_id: 'other-coach' },
        { id: 's3', email: 's3@example.test', role: 'student', coach_id: null },
      ],
    });
    const { service, audit } = buildService(prisma);
    const res = await service.register({
      email: 'newcoach@example.test',
      password: GOOD_PASSWORD,
      name: 'New Coach',
      intended_role: 'coach',
    });
    expectCoachProvisioned(prisma, res.user_id, 'email');

    const coachService = new CoachService(prisma, audit);
    const clients = await coachService.getClients(res.user_id, 'active', 'coach');
    expect(clients).toEqual([]);
    const otherClients = await coachService.getClients('other-coach', 'active', 'coach');
    expect(otherClients.map((c: any) => c.id).sort()).toEqual(['s1', 's2']);
  });
});
