import { Prisma } from '@prisma/client';
import { AuthController } from '../src/auth/auth.controller';
import { AdminService } from '../src/admin/admin.service';
import { PackagesService } from '../src/packages/packages.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import {
  AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT,
  resolveOAuthCoachSignupPerHour,
} from '../src/throttler/login-throttle-reset.service';

// Clinic C13 fix round — cross-module regressions requested by the two
// independent audits (Opus + Grok) of PR #597. The auth-service paths live in
// test/auth-signup-role-choice.spec.ts; this file covers the surrounding
// modules: the OAuth coach-signup throttle, the
// controller wiring, the admin invite-code sampler and the phantom sub-coach
// promotion through PackagesService.

describe('OAuth coach-signup throttle (Grok B5)', () => {
  const ORIG = process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    else process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = ORIG;
  });

  it('resolves the per-hour limit from env with a small default and sane clamps', () => {
    delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    expect(AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT).toBe(5);
    expect(resolveOAuthCoachSignupPerHour()).toBe(5);
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = '20';
    expect(resolveOAuthCoachSignupPerHour()).toBe(20);
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = '0';
    expect(resolveOAuthCoachSignupPerHour()).toBe(5);
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = 'nope';
    expect(resolveOAuthCoachSignupPerHour()).toBe(5);
  });

  // The storage behaviour (block, per-IP key, fail-closed) is proven against
  // the REAL @nestjs/throttler / Redis adapters in
  // test/oauth-coach-signup-ceiling.spec.ts (Sol SOL-C13-A2) — the incrementing
  // mock that used to live here hid the zero-block-duration reset.
});

describe('AuthController google/apple wiring (Opus C5 / Grok B1, B5)', () => {
  function build(result: any) {
    const auth: any = {
      googleAuth: jest.fn(async () => result),
      appleAuth: jest.fn(async () => result),
    };
    const loginThrottleReset: any = { resetLoginCounters: jest.fn() };
    const inviteCodes: any = {};
    const controller = new AuthController(auth, inviteCodes, loginThrottleReset);
    const req: any = {
      ip: '203.0.113.9',
      headers: { 'user-agent': 'growth-mobile/1.0' },
      socket: { remoteAddress: '203.0.113.9' },
    };
    return { controller, auth, loginThrottleReset, req };
  }

  it('passes IP/user-agent into AuthService.googleAuth and skips the login-throttle reset for a NEW user', async () => {
    const { controller, auth, loginThrottleReset, req } = build({ is_new_user: true, user: {} });
    const body: any = { token: 't', intended_role: 'coach' };
    await controller.googleAuth(body, req);
    expect(auth.googleAuth).toHaveBeenCalledWith(
      't',
      undefined,
      'coach',
      expect.objectContaining({ ip: '203.0.113.9', userAgent: 'growth-mobile/1.0' }),
    );
    expect(loginThrottleReset.resetLoginCounters).not.toHaveBeenCalled();
  });

  it('still resets the login counters for a RETURNING user (google and apple)', async () => {
    const { controller, loginThrottleReset, req } = build({ is_new_user: false, user: {} });
    const body: any = { token: 't' };
    await controller.googleAuth(body, req);
    await controller.appleAuth(body, req);
    expect(loginThrottleReset.resetLoginCounters).toHaveBeenCalledTimes(2);
  });

  it('apple: no reset for a NEW user either', async () => {
    const { controller, auth, loginThrottleReset, req } = build({ is_new_user: true, user: {} });
    const body: any = { token: 't', intended_role: 'coach' };
    await controller.appleAuth(body, req);
    expect(auth.appleAuth).toHaveBeenCalledWith(
      't',
      undefined,
      undefined,
      expect.objectContaining({ ip: '203.0.113.9' }),
      undefined,
      'coach',
    );
    expect(loginThrottleReset.resetLoginCounters).not.toHaveBeenCalled();
  });
});

describe('AdminService invite-code sampler (Grok C6)', () => {
  it('ensureCoachProfile mints GP- codes from the uniform randomInt alphabet', async () => {
    const codes: string[] = [];
    const prisma: any = {
      coachProfile: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          codes.push(data.invite_code);
          return { id: 'cp', ...data };
        }),
      },
    };
    const analytics: any = { capture: jest.fn() };
    const audit: any = { write: jest.fn() };
    const svc = new AdminService(prisma, analytics, audit);
    for (let i = 0; i < 50; i++) await svc.ensureCoachProfile(`u-${i}`);
    expect(codes).toHaveLength(50);
    for (const c of codes) expect(c).toMatch(/^GP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // No 0/O/1/I/L — the ambiguous glyphs are excluded from the alphabet.
    expect(codes.map((c) => c.slice(3)).join('')).not.toMatch(/[01OIL]/);
  });
});

describe('PackagesService.resolveEffectiveCoachId — phantom sub-coach (Opus A1)', () => {
  const HEAD = 'head-coach';
  const PHANTOM = 'free-coach-who-bought-a-package';
  function build(membership: boolean) {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === PHANTOM
            ? { role: 'coach', coach_id: HEAD }
            : { role: 'coach', coach_id: null },
        ),
        findMany: jest.fn(async () => []),
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => (membership ? { id: 'seat' } : null)),
      },
      subCoachAssignment: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    };
    const scope = new SubCoachScopeService(prisma);
    return { svc: new PackagesService(prisma, scope), prisma };
  }

  it('WITHOUT a membership relation the caller manages their OWN packages, never the head coach\u2019s', async () => {
    const { svc } = build(false);
    expect(await svc.resolveEffectiveCoachId(PHANTOM)).toBe(PHANTOM);
  });

  it('WITH an active team seat the caller is scoped to the head coach', async () => {
    const { svc } = build(true);
    expect(await svc.resolveEffectiveCoachId(PHANTOM)).toBe(HEAD);
  });
});
