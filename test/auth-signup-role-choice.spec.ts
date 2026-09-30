import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthService } from '../src/auth/auth.service';
import { AppleAuthDto, GoogleAuthDto, RegisterDto, SignupWithCodeDto } from '../src/auth/auth.dto';
import { AuditAction } from '../src/audit/audit.service';
import { CoachService } from '../src/coach/coach.service';

// Clinic launch C13 — signup-time client/coach role choice.
//
// Owner direction (2026-09-30): anyone who downloads the app can self-select
// client vs coach WHEN CREATING the account. The security design pinned here
// keeps the enterprise privilege-escalation concern (auth.service.ts, the
// become-coach hard gate) closed:
//
//   * `intended_role` only applies on the branch that inserts a brand-new User
//     row (register; google/apple first contact). Existing accounts are never
//     changed by it.
//   * A new coach gets, in one transaction, role 'coach' + CoachSubscription
//     {tier free, status active} (upsert with update:{} exactly like
//     becomeCoach) + a CoachProfile with a GP- invite code, then a
//     user.role_changed audit row whose actor is the new user.
//   * /auth/signup-with-code always creates a client; 'coach' is refused with
//     a stable error code. invite_code + coach is refused on google/apple.
//   * /auth/become-coach stays hard-gated; /auth/select-role unchanged.
//   * The DTO enum rejects anything but 'client' | 'coach'.
//   * Tenancy smoke: a brand-new coach sees zero clients.

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
const makeAuditMock = (): any => ({
  write: jest.fn(async () => {}),
  list: jest.fn(async () => []),
});
const makeVerifierMock = (configured: boolean): any => ({
  isConfigured: jest.fn(() => configured),
  getAudiences: jest.fn(() => (configured ? ['com.growthproject.app'] : [])),
  verify: jest.fn(),
});

// In-memory Prisma double. `$transaction(cb)` hands the same tables to the
// callback and records that it ran, so the "one transaction" property and
// the "no transaction on the client path" property are both observable.
function buildPrisma(seed: { users?: any[]; profiles?: any[]; subs?: any[] } = {}) {
  const users: any[] = [...(seed.users ?? [])];
  const profiles: any[] = [...(seed.profiles ?? [])];
  const subs: any[] = [...(seed.subs ?? [])];
  let seq = 0;
  const tables: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return users.find((u) => u.id === where.id) ?? null;
        if (where.email) return users.find((u) => u.email === where.email) ?? null;
        if (where.supabase_id)
          return users.find((u) => u.supabase_id === where.supabase_id) ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `u-${++seq}`, coach_id: null, archived_at: null, ...data };
        users.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = users.find((u) => u.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        users.filter(
          (u) =>
            (where.coach_id === undefined || u.coach_id === where.coach_id) &&
            (where.role === undefined || u.role === where.role) &&
            (where.archived_at === undefined || (u.archived_at ?? null) === where.archived_at),
        ),
      ),
    },
    coachSubscription: {
      findUnique: jest.fn(
        async ({ where }: any) => subs.find((s) => s.coach_id === where.coach_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = subs.find((s) => s.coach_id === where.coach_id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `sub-${++seq}`, ...create };
        subs.push(row);
        return row;
      }),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.invite_code)
          return profiles.find((p) => p.invite_code === where.invite_code) ?? null;
        if (where.user_id) return profiles.find((p) => p.user_id === where.user_id) ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `cp-${++seq}`, ...data };
        profiles.push(row);
        return row;
      }),
    },
  };
  tables.$transaction = jest.fn(async (cb: any) => cb(tables));
  tables._users = users;
  tables._profiles = profiles;
  tables._subs = subs;
  return tables;
}

function buildService(prisma: any, opts: { apple?: boolean } = {}) {
  const inviteCodes = makeInviteCodesMock();
  const analytics = makeAnalyticsMock();
  const audit = makeAuditMock();
  const appleVerifier = makeVerifierMock(opts.apple ?? false);
  const service = new AuthService(
    prisma,
    inviteCodes,
    analytics,
    audit,
    appleVerifier,
    makeVerifierMock(false),
  );
  return { service, inviteCodes, analytics, audit, appleVerifier };
}

const GOOD_PASSWORD = 'Aa1!aaaa';

function expectCoachProvisioned(prisma: any, audit: any, userId: string, provider: string) {
  const user = prisma._users.find((u: any) => u.id === userId);
  expect(user.role).toBe('coach');
  expect(user.coach_id).toBeNull();

  // Exactly one transaction wrapped the create + upsert + profile.
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

  const roleAudits = audit.write.mock.calls
    .map((c: any[]) => c[0])
    .filter((a: any) => a.action === AuditAction.USER_ROLE_CHANGED);
  expect(roleAudits).toHaveLength(1);
  expect(roleAudits[0]).toEqual(
    expect.objectContaining({
      actorId: userId,
      targetUserId: userId,
      tenantCoachId: userId,
      metadata: expect.objectContaining({ to: 'coach', via: 'signup_role_choice', provider }),
    }),
  );
}

function expectNoCoachProvisioning(prisma: any, audit: any) {
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
  expect(prisma.coachProfile.create).not.toHaveBeenCalled();
  const roleAudits = audit.write.mock.calls
    .map((c: any[]) => c[0])
    .filter((a: any) => a.action === AuditAction.USER_ROLE_CHANGED);
  expect(roleAudits).toHaveLength(0);
}

describe('C13 signup-time role choice — POST /auth/register', () => {
  beforeEach(() => {
    hooks().__supaSignUp = jest.fn(async ({ email }: any) => ({
      data: { user: { id: `sup-${email}` } },
      error: null,
    }));
  });

  it('intended_role=coach creates a coach with a free/active subscription, profile and audit row', async () => {
    const prisma = buildPrisma();
    const { service, audit, analytics } = buildService(prisma);
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
    expectCoachProvisioned(prisma, audit, res.user_id, 'email');
    // Audit carries the request context and never a password.
    const roleAudit = audit.write.mock.calls.map((c: any[]) => c[0])[0];
    expect(roleAudit.ip).toBe('1.2.3.4');
    expect(JSON.stringify(roleAudit)).not.toContain(GOOD_PASSWORD);
    expect(analytics.capture).toHaveBeenCalledWith(
      res.user_id,
      'coach_promoted',
      expect.objectContaining({ via: 'signup_role_choice', provider: 'email' }),
    );
    // Email verification behaviour unchanged: Supabase signUp still ran.
    expect(hooks().__supaSignUp).toHaveBeenCalledTimes(1);
  });

  it('defaults to a client (student) with no transaction, subscription, profile or audit', async () => {
    const prisma = buildPrisma();
    const { service, audit } = buildService(prisma);
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
    expectNoCoachProvisioning(prisma, audit);
  });

  it("intended_role='client' is the same as omitting it", async () => {
    const prisma = buildPrisma();
    const { service, audit } = buildService(prisma);
    const res = await service.register({
      email: 'c2@example.test',
      password: GOOD_PASSWORD,
      name: 'Client',
      intended_role: 'client',
    });
    expect(res.role).toBe('student');
    expectNoCoachProvisioning(prisma, audit);
  });

  it('a duplicate email is still refused before any provisioning', async () => {
    const prisma = buildPrisma({
      users: [
        { id: 'u-existing', email: 'dup@example.test', role: 'student', coach_id: 'coach-1' },
      ],
    });
    const { service, audit } = buildService(prisma);
    await expect(
      service.register({
        email: 'dup@example.test',
        password: GOOD_PASSWORD,
        name: 'Dup',
        intended_role: 'coach',
      }),
    ).rejects.toThrow('Email already registered');
    expectNoCoachProvisioning(prisma, audit);
    expect(prisma._users[0].role).toBe('student');
  });
});

describe('C13 signup-time role choice — POST /auth/google', () => {
  const googleSupaUser = (id: string, email: string) => ({
    id,
    email,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: 'G User' },
    identities: [{ provider: 'google' }],
  });

  function withAdmin(service: AuthService, supaUser: any) {
    asRecord(service).supabaseAdmin = {
      auth: { getUser: jest.fn(async () => ({ data: { user: supaUser }, error: null })) },
    };
  }

  it('new user with intended_role=coach is provisioned as a coach', async () => {
    const prisma = buildPrisma();
    const { service, audit } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g1', 'g1@example.test'));
    const res = await service.googleAuth('tok', undefined, 'coach');
    expect(res.is_new_user).toBe(true);
    expect(res.user.role).toBe('coach');
    expectCoachProvisioned(prisma, audit, res.user.id, 'google');
  });

  it('new user without intended_role is a student (unchanged legacy shape)', async () => {
    const prisma = buildPrisma();
    const { service, audit } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g2', 'g2@example.test'));
    const res = await service.googleAuth('tok');
    expect(res.user.role).toBe('student');
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { supabase_id: 'sup-g2', email: 'g2@example.test', name: 'G User', role: 'student' },
    });
    expectNoCoachProvisioning(prisma, audit);
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
    const { service, audit } = buildService(prisma);
    withAdmin(service, googleSupaUser('sup-g3', 'g3@example.test'));
    const res = await service.googleAuth('tok', undefined, 'coach');
    expect(res.is_new_user).toBe(false);
    expect(res.user.role).toBe('student');
    expect(res.user.coach_id).toBe('coach-1');
    expect(prisma._users[0]).toEqual(existing);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expectNoCoachProvisioning(prisma, audit);
  });

  it('EXISTING email-registered user being linked to Google with intended_role=coach keeps their role', async () => {
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
    const { service, audit } = buildService(prisma);
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
    expectNoCoachProvisioning(prisma, audit);
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

  it('new user with intended_role=coach is provisioned as a coach', async () => {
    const prisma = buildPrisma();
    const { service, audit, appleVerifier } = buildService(prisma, { apple: true });
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
    expectCoachProvisioned(prisma, audit, res.user.id, 'apple');
    // The pre-existing Apple sign-in audit row is still written too.
    const actions = audit.write.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toContain(AuditAction.AUTH_APPLE_SIGNIN);
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
    const { service, audit, appleVerifier } = buildService(prisma, { apple: true });
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
    expectNoCoachProvisioning(prisma, audit);
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

  it("refuses intended_role='coach' with a stable error code before Supabase signUp", async () => {
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

  it("intended_role='client' signs up as a student and is attached to the coach", async () => {
    delete process.env.COACH_CODE_GATE_ENABLED;
    hooks().__supaSignUp = jest.fn(async () => ({
      data: { user: { id: 'sup-swc' } },
      error: null,
    }));
    const prisma = buildPrisma();
    const { service, inviteCodes, audit } = buildService(prisma);
    const res = await service.signupWithCode({
      email: 'y@example.test',
      password: GOOD_PASSWORD,
      name: 'Y',
      invite_code: 'GP-ABC123',
      intended_role: 'client',
    });
    expect(res.role).toBe('student');
    expect(inviteCodes.attachUserToCoachByCode).toHaveBeenCalledWith(res.user_id, 'GP-ABC123');
    expectNoCoachProvisioning(prisma, audit);
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
    const { service, audit } = buildService(prisma);
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
    expectNoCoachProvisioning(prisma, audit);
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
    hooks().__supaSignUp = jest.fn(async () => ({
      data: { user: { id: 'sup-new-coach' } },
      error: null,
    }));
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
    expectCoachProvisioned(prisma, audit, res.user_id, 'email');

    const coachService = new CoachService(prisma, audit);
    const clients = await coachService.getClients(res.user_id, 'active', 'coach');
    expect(clients).toEqual([]);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ coach_id: res.user_id, role: 'student' }),
      }),
    );
    // Sanity: the other coach still sees their own two students.
    const others = await coachService.getClients('other-coach', 'active', 'coach');
    expect(others.map((u: any) => u.id).sort()).toEqual(['s1', 's2']);
  });
});
