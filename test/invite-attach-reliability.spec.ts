import { ConflictException, ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import {
  INVITE_ATTACH_ERROR,
  InviteCodesService,
  inviteAttachErrorCode,
  isWellFormedInviteCode,
} from '../src/invite-codes/invite-codes.service';
import {
  SIGNUP_WITH_CODE_ACTIVE_THROTTLERS,
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
  THROTTLER_ROUTE_LIMITS,
} from '../src/throttler/throttler.config';
import {
  isSignupWithCodeRequest,
  requestCarriesWellFormedInviteCode,
  skipSignupBaselineWhenCodePresent,
  skipSignupBurstUnlessCodePresent,
} from '../src/throttler/signup-code-burst';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import type { PrismaService } from '../src/prisma.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { AuditService } from '../src/audit/audit.service';
import type { EmailService } from '../src/email/email.service';

// Clinic launch C03 — reliable invite attach.
//
//   1. attachUserToCoachByCode refuses to re-parent a student whose coach_id is
//      already a DIFFERENT coach (409 already_attached_to_different_coach) and
//      is an idempotent success for the SAME coach (no seat consumed).
//   2. Every attach failure carries a safe machine-readable code, and the auth
//      flows (signup-with-code / Google / Apple) return
//      `invite_attached` + `invite_attach_error` instead of swallowing it.
//   3. Signup throttle: 5/hour/IP without a code, 30/hour/IP with a well-formed
//      code, enforced by the real UserThrottlerGuard over in-memory storage.

// ---- typed doubles ----------------------------------------------------------

type UserRow = { id: string; email: string; role: string; coach_id: string | null; name?: string };

type InviteRow = {
  id: string;
  code: string;
  coach_id: string;
  revoked: boolean;
  expires_at: Date | null;
  max_uses: number | null;
  used_count: number;
  intended_email: string | null;
};

function makeAttachPrisma(seed: {
  users: UserRow[];
  coaches: { id: string; code: string; status?: string }[];
  inviteRows?: InviteRow[];
  /** Called between the in-transaction user read and the conditional write (race injection). */
  beforeAttachWrite?: () => Promise<void> | void;
}) {
  const users = new Map(seed.users.map((u) => [u.id, { ...u }]));
  const inviteRows = new Map((seed.inviteRows ?? []).map((r) => [r.id, { ...r }]));
  const profiles = seed.coaches.map((c) => ({
    id: `cp-${c.id}`,
    user_id: c.id,
    invite_code: c.code,
    user: { id: c.id, role: 'coach' },
  }));
  const subs = new Map(seed.coaches.map((c) => [c.id, { status: c.status ?? 'active' }]));
  const base = {
    _users: users,
    coachProfile: {
      findUnique: jest.fn(
        async ({ where }: { where: { invite_code?: string } }) =>
          profiles.find((p) => p.invite_code === where.invite_code) ?? null,
      ),
    },
    coachSubscription: {
      findUnique: jest.fn(
        async ({ where }: { where: { coach_id: string } }) => subs.get(where.coach_id) ?? null,
      ),
    },
    inviteCode: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
        const row = [...inviteRows.values()].find((r) =>
          where.id ? r.id === where.id : r.code === where.code,
        );
        return row ? { ...row, coach: { id: row.coach_id, role: 'coach' } } : null;
      }),
      findFirst: jest.fn(async () => null),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; revoked: boolean; used_count?: { lt: number } };
          data: { used_count: { increment: number } };
        }) => {
          const row = inviteRows.get(where.id);
          if (!row || row.revoked !== where.revoked) return { count: 0 };
          if (where.used_count && !(row.used_count < where.used_count.lt)) return { count: 0 };
          row.used_count += data.used_count.increment;
          return { count: 1 };
        },
      ),
    },
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
      // Conditional attach (C03): student with NO coach → set coach_id only.
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; role: string; coach_id: null };
          data: { coach_id: string };
        }) => {
          await seed.beforeAttachWrite?.();
          const row = users.get(where.id);
          if (!row || row.role !== where.role || row.coach_id !== where.coach_id) {
            return { count: 0 };
          }
          row.coach_id = data.coach_id;
          return { count: 1 };
        },
      ),
    },
    _inviteRows: inviteRows,
  };
  const double = Object.assign(base, {
    $transaction: jest.fn(async <T>(cb: (tx: typeof base) => Promise<T>) => cb(base)),
  });
  return double;
}
type AttachPrisma = ReturnType<typeof makeAttachPrisma>;

function asPrisma(d: AttachPrisma): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — only the delegates attach reads
  return d;
}
function makeAnalytics(): AnalyticsService {
  const a = { capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() };
  // @ts-expect-error partial structural mock of AnalyticsService
  return a;
}
function makeEmail(): EmailService {
  const e = { send: jest.fn() };
  // @ts-expect-error partial structural mock of EmailService — never reached by attach
  return e;
}
function makeAudit(): AuditService {
  const a = { write: jest.fn(async () => undefined) };
  // @ts-expect-error partial structural mock of AuditService
  return a;
}

function buildInviteCodes(prisma: AttachPrisma) {
  return new InviteCodesService(asPrisma(prisma), makeAnalytics(), makeEmail(), makeAudit());
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

// ---- 1. re-parent refusal + idempotent same-coach ---------------------------

describe('C03 — attachUserToCoachByCode re-parent rules', () => {
  const COACH_A = 'coach-a';
  const COACH_B = 'coach-b';

  function seed(studentCoach: string | null) {
    return makeAttachPrisma({
      users: [{ id: 'stu-1', email: 'stu@example.com', role: 'student', coach_id: studentCoach }],
      coaches: [
        { id: COACH_A, code: 'GP-COACHA' },
        { id: COACH_B, code: 'GP-COACHB' },
      ],
    });
  }

  it('fresh student attaches normally (already_attached:false) — coach_id only, role untouched', async () => {
    const prisma = seed(null);
    const res = await buildInviteCodes(prisma).attachUserToCoachByCode('stu-1', ' GP-COACHA ');
    expect(res).toEqual({ role: 'student', coach_id: COACH_A, already_attached: false });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'stu-1', role: 'student', coach_id: null },
      data: { coach_id: COACH_A },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma._users.get('stu-1')).toMatchObject({ role: 'student', coach_id: COACH_A });
  });

  it.each([
    ['coach', 'coach-x'],
    ['sub_coach', 'sub-x'],
  ])(
    '%s account (coach_id null) → 403 coach_cannot_redeem; nothing written, never demoted',
    async (role, id) => {
      const prisma = makeAttachPrisma({
        users: [{ id, email: `${id}@example.com`, role, coach_id: null }],
        coaches: [{ id: COACH_A, code: 'GP-COACHA' }],
      });
      const err = await captureHttp(
        buildInviteCodes(prisma).attachUserToCoachByCode(id, 'GP-COACHA'),
      );
      expect(err.getStatus()).toBe(403);
      expect(inviteAttachErrorCode(err)).toBe('coach_cannot_redeem');
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma._users.get(id)).toMatchObject({ role, coach_id: null });
    },
  );

  it('a coach redeeming their OWN permanent code is refused (403), not demoted or self-parented', async () => {
    const prisma = makeAttachPrisma({
      users: [{ id: COACH_A, email: 'a@example.com', role: 'coach', coach_id: null }],
      coaches: [{ id: COACH_A, code: 'GP-COACHA' }],
    });
    const err = await captureHttp(
      buildInviteCodes(prisma).attachUserToCoachByCode(COACH_A, 'GP-COACHA'),
    );
    expect(inviteAttachErrorCode(err)).toBe('coach_cannot_redeem');
    expect(prisma._users.get(COACH_A)).toMatchObject({ role: 'coach', coach_id: null });
  });

  it('race: two different codes for a fresh student → one winner, one 409, no silent re-parent', async () => {
    // Interleave: while request 1 is between its in-transaction read and its
    // conditional write, request 2 attaches the same user to COACH_B.
    let injected = false;
    const prisma = makeAttachPrisma({
      users: [{ id: 'stu-1', email: 'stu@example.com', role: 'student', coach_id: null }],
      coaches: [
        { id: COACH_A, code: 'GP-COACHA' },
        { id: COACH_B, code: 'GP-COACHB' },
      ],
      beforeAttachWrite: () => {
        if (injected) return;
        injected = true;
        const row = prisma._users.get('stu-1');
        if (row) row.coach_id = COACH_B; // the sibling request commits first
      },
    });
    const err = await captureHttp(
      buildInviteCodes(prisma).attachUserToCoachByCode('stu-1', 'GP-COACHA'),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(inviteAttachErrorCode(err)).toBe('already_attached_to_different_coach');
    expect(prisma._users.get('stu-1')?.coach_id).toBe(COACH_B); // winner stands, no overwrite
  });

  it('race: a retry racing its own first commit (same coach) resolves to already_attached:true', async () => {
    let injected = false;
    const prisma = makeAttachPrisma({
      users: [{ id: 'stu-1', email: 'stu@example.com', role: 'student', coach_id: null }],
      coaches: [{ id: COACH_A, code: 'GP-COACHA' }],
      beforeAttachWrite: () => {
        if (injected) return;
        injected = true;
        const row = prisma._users.get('stu-1');
        if (row) row.coach_id = COACH_A;
      },
    });
    const res = await buildInviteCodes(prisma).attachUserToCoachByCode('stu-1', 'GP-COACHA');
    expect(res).toEqual({ role: 'student', coach_id: COACH_A, already_attached: true });
  });

  it('concurrent use of ONE InviteCode by two clients: both succeed, used_count 2 (no false "invalid code")', async () => {
    const prisma = makeAttachPrisma({
      users: [
        { id: 'stu-1', email: 'one@example.com', role: 'student', coach_id: null },
        { id: 'stu-2', email: 'two@example.com', role: 'student', coach_id: null },
      ],
      coaches: [{ id: COACH_A, code: 'GP-COACHA' }],
      inviteRows: [
        {
          id: 'inv-1',
          code: 'CLINIC-ROOM',
          coach_id: COACH_A,
          revoked: false,
          expires_at: null,
          max_uses: 5,
          used_count: 0,
          intended_email: null,
        },
      ],
    });
    // validate() resolves per-row codes through inviteCode.findUnique({ code }).
    const svc = buildInviteCodes(prisma);
    const [a, b] = await Promise.all([
      svc.attachUserToCoachByCode('stu-1', 'CLINIC-ROOM'),
      svc.attachUserToCoachByCode('stu-2', 'CLINIC-ROOM'),
    ]);
    expect(a).toMatchObject({ coach_id: COACH_A, already_attached: false });
    expect(b).toMatchObject({ coach_id: COACH_A, already_attached: false });
    expect(prisma._inviteRows.get('inv-1')?.used_count).toBe(2);
    // The bump is conditional on capacity, not on an equality snapshot.
    expect(prisma.inviteCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv-1', revoked: false, used_count: { lt: 5 } } }),
    );
  });

  it('an exhausted InviteCode fails the conditional bump → invite_code_invalid, user not attached', async () => {
    const prisma = makeAttachPrisma({
      users: [{ id: 'stu-1', email: 'one@example.com', role: 'student', coach_id: null }],
      coaches: [{ id: COACH_A, code: 'GP-COACHA' }],
      inviteRows: [
        {
          id: 'inv-2',
          code: 'FULL-ROOM',
          coach_id: COACH_A,
          revoked: false,
          expires_at: null,
          max_uses: 1,
          used_count: 1,
          intended_email: null,
        },
      ],
    });
    const err = await captureHttp(
      buildInviteCodes(prisma).attachUserToCoachByCode('stu-1', 'FULL-ROOM'),
    );
    expect(inviteAttachErrorCode(err)).toBe('invite_code_invalid');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('same coach → idempotent success, nothing written, no seat consumed', async () => {
    const prisma = seed(COACH_A);
    const res = await buildInviteCodes(prisma).attachUserToCoachByCode('stu-1', 'GP-COACHA');
    expect(res).toEqual({ role: 'student', coach_id: COACH_A, already_attached: true });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inviteCode.updateMany).not.toHaveBeenCalled();
  });

  it('different coach → 409 already_attached_to_different_coach, coach_id untouched', async () => {
    const prisma = seed(COACH_A);
    const err = await captureHttp(
      buildInviteCodes(prisma).attachUserToCoachByCode('stu-1', 'GP-COACHB'),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: INVITE_ATTACH_ERROR.ALREADY_ATTACHED_TO_DIFFERENT_COACH,
    });
    expect(inviteAttachErrorCode(err)).toBe('already_attached_to_different_coach');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma._users.get('stu-1')?.coach_id).toBe(COACH_A);
  });

  it('every other failure carries a safe code (invalid code, paused coach, owner)', async () => {
    const paused = makeAttachPrisma({
      users: [
        { id: 'stu-1', email: 'stu@example.com', role: 'student', coach_id: null },
        { id: 'own-1', email: 'own@example.com', role: 'owner', coach_id: null },
      ],
      coaches: [
        { id: COACH_A, code: 'GP-COACHA' },
        { id: 'coach-p', code: 'GP-PAUSED', status: 'past_due' },
      ],
    });
    const svc = buildInviteCodes(paused);
    const invalid = await captureHttp(svc.attachUserToCoachByCode('stu-1', 'GP-NOPE'));
    expect(inviteAttachErrorCode(invalid)).toBe('invite_code_invalid');
    expect(invalid.message).toBe('Invalid or expired invite code'); // legacy message preserved
    const notAccepting = await captureHttp(svc.attachUserToCoachByCode('stu-1', 'GP-PAUSED'));
    expect(inviteAttachErrorCode(notAccepting)).toBe('coach_not_accepting_clients');
    const owner = await captureHttp(svc.attachUserToCoachByCode('own-1', 'GP-COACHA'));
    expect(inviteAttachErrorCode(owner)).toBe('owner_cannot_redeem');
    // Unknown errors collapse to attach_failed and never leak the message.
    expect(inviteAttachErrorCode(new Error('ECONNRESET db'))).toBe('attach_failed');
    expect(inviteAttachErrorCode(new ConflictException('plain string response'))).toBe(
      'attach_failed',
    );
  });
});

// ---- 2. auth flows surface the outcome ---------------------------------------

describe('C03 — auth flows report invite_attached / invite_attach_error', () => {
  const ORIG = { ...process.env };
  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://stub.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';
  });
  afterAll(() => {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'COACH_CODE_GATE_ENABLED']) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  type InviteCodesDouble = {
    attachUserToCoachByCode: jest.Mock;
    previewCode: jest.Mock;
  };
  function buildAuth(invite: InviteCodesDouble, userRow: UserRow) {
    const prisma = {
      user: {
        findUnique: jest.fn(async () => userRow),
      },
    };
    const verifier = { isConfigured: () => true, getAudiences: () => ['aud'], verify: jest.fn() };
    const deps = {
      prisma,
      invite,
      analytics: { capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() },
      audit: { write: jest.fn(async () => undefined) },
      apple: verifier,
      google: verifier,
    };
    type Ctor = ConstructorParameters<typeof AuthService>;
    function asCtorArgs(d: typeof deps): Ctor {
      // @ts-expect-error partial structural doubles for the AuthService collaborators
      return [d.prisma, d.invite, d.analytics, d.audit, d.apple, d.google];
    }
    const svc = new AuthService(...asCtorArgs(deps));
    // signupWithCode → register → Supabase; stub register at the boundary so
    // the test stays on the attach contract.
    jest.spyOn(svc, 'register').mockResolvedValue({
      message: 'Account created. Check your email to verify.',
      requires_verification: true,
      user_id: userRow.id,
      email: userRow.email,
      role: 'student',
    });
    return { svc, deps };
  }
  const student: UserRow = {
    id: 'u-1',
    email: 's@example.com',
    role: 'student',
    coach_id: null,
    name: 'S',
  };

  it('signupWithCode: attach success → invite_attached:true, no error field', async () => {
    const invite: InviteCodesDouble = {
      previewCode: jest.fn(async () => ({ valid: true })),
      attachUserToCoachByCode: jest.fn(async () => ({
        role: 'student',
        coach_id: 'c',
        already_attached: false,
      })),
    };
    const { svc } = buildAuth(invite, student);
    const res = await svc.signupWithCode({
      email: 's@example.com',
      password: 'Password123!',
      name: 'S',
      invite_code: 'GP-COACHA',
    });
    expect(res.invite_attached).toBe(true);
    expect(res).not.toHaveProperty('invite_attach_error');
    expect(res.user_id).toBe('u-1');
  });

  it('signupWithCode: attach failure is reported, not swallowed; account still returned', async () => {
    const invite: InviteCodesDouble = {
      previewCode: jest.fn(async () => ({ valid: true })),
      attachUserToCoachByCode: jest.fn(async () => {
        throw new ConflictException({
          code: INVITE_ATTACH_ERROR.COACH_NOT_ACCEPTING_CLIENTS,
          message: 'Coach is not currently accepting clients',
        });
      }),
    };
    const { svc, deps } = buildAuth(invite, student);
    const res = await svc.signupWithCode({
      email: 's@example.com',
      password: 'Password123!',
      name: 'S',
      invite_code: 'GP-COACHA',
    });
    expect(res.invite_attached).toBe(false);
    expect(res.invite_attach_error).toBe('coach_not_accepting_clients');
    expect(res.user_id).toBe('u-1');
    expect(res.requires_verification).toBe(true);
    expect(deps.analytics.capture).toHaveBeenCalledWith(
      'u-1',
      expect.any(String),
      expect.objectContaining({
        invite_attached: false,
        invite_attach_error: 'coach_not_accepting_clients',
      }),
    );
  });

  it('signupWithCode without a code: invite_attached:false and no error', async () => {
    const invite: InviteCodesDouble = {
      previewCode: jest.fn(),
      attachUserToCoachByCode: jest.fn(),
    };
    delete process.env.COACH_CODE_GATE_ENABLED;
    const { svc } = buildAuth(invite, student);
    const res = await svc.signupWithCode({
      email: 's@example.com',
      password: 'Password123!',
      name: 'S',
    });
    expect(res.invite_attached).toBe(false);
    expect(res).not.toHaveProperty('invite_attach_error');
    expect(invite.attachUserToCoachByCode).not.toHaveBeenCalled();
  });

  it('googleAuth / appleAuth: the shared attach helper maps a different-coach refusal to a safe code', async () => {
    const invite: InviteCodesDouble = {
      previewCode: jest.fn(),
      attachUserToCoachByCode: jest.fn(async () => {
        throw new ConflictException({
          code: INVITE_ATTACH_ERROR.ALREADY_ATTACHED_TO_DIFFERENT_COACH,
          message: 'You are already attached to a different coach',
        });
      }),
    };
    const { svc } = buildAuth(invite, { ...student, coach_id: 'coach-a' });
    // The helper is private; bracket access keeps the call typed without a cast.
    const helper = svc['tryAttachInviteCode'].bind(svc);
    const google = await helper('googleAuth', 'u-1', 'GP-COACHB');
    expect(google).toEqual({
      invite_attached: false,
      invite_attach_error: 'already_attached_to_different_coach',
    });
    const apple = await helper('appleAuth', 'u-1', 'GP-COACHB');
    expect(apple).toEqual({
      invite_attached: false,
      invite_attach_error: 'already_attached_to_different_coach',
    });
    invite.attachUserToCoachByCode.mockResolvedValueOnce({
      role: 'student',
      coach_id: 'coach-a',
      already_attached: true,
    });
    expect(await helper('appleAuth', 'u-1', 'GP-COACHA')).toEqual({ invite_attached: true });
  });
});

// ---- 3. signup throttle: 5/h codeless, 30/h with a well-formed code ---------

describe('C03 — signup-with-code throttle burst for invite-code holders', () => {
  function makeCtx(opts: {
    path: string;
    body?: unknown;
    ip: string;
    handler?: (...args: unknown[]) => unknown;
  }): {
    ctx: ExecutionContext;
    res: { header: jest.Mock };
  } {
    const req = {
      route: { path: opts.path },
      url: opts.path,
      body: opts.body,
      ip: opts.ip,
      headers: {},
      socket: { remoteAddress: opts.ip },
    };
    const res = { header: jest.fn() };
    const handler = opts.handler ?? AuthController.prototype.signupWithCode;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => handler,
      getClass: () => AuthController,
      getType: () => 'http',
    };
    // @ts-expect-error partial ExecutionContext double — the throttler reads only these members
    return { ctx, res };
  }

  it('predicates: only a signup-with-code POST with a well-formed code switches buckets', () => {
    expect(isWellFormedInviteCode('GP-COACHA')).toBe(true);
    expect(isWellFormedInviteCode(' gp-coacha ')).toBe(true);
    expect(isWellFormedInviteCode('ab')).toBe(false); // < 3
    expect(isWellFormedInviteCode('x'.repeat(33))).toBe(false); // > 32
    expect(isWellFormedInviteCode('GP COACH')).toBe(false); // space
    expect(isWellFormedInviteCode(42)).toBe(false);

    const withCode = makeCtx({
      path: '/auth/signup-with-code',
      body: { invite_code: 'GP-COACHA' },
      ip: '1.1.1.1',
    });
    const noCode = makeCtx({
      path: '/auth/signup-with-code',
      body: { email: 'x@y.z' },
      ip: '1.1.1.1',
    });
    const badCode = makeCtx({
      path: '/auth/signup-with-code',
      body: { invite_code: '!!' },
      ip: '1.1.1.1',
    });
    const otherRoute = makeCtx({
      path: '/auth/apple',
      body: { invite_code: 'GP-COACHA' },
      ip: '1.1.1.1',
    });
    const prefixed = makeCtx({
      path: '/api/auth/signup-with-code',
      body: { invite_code: 'GP-COACHA' },
      ip: '1.1.1.1',
    });

    expect(skipSignupBaselineWhenCodePresent(withCode.ctx)).toBe(true);
    expect(skipSignupBurstUnlessCodePresent(withCode.ctx)).toBe(false);
    expect(skipSignupBaselineWhenCodePresent(prefixed.ctx)).toBe(true);

    for (const c of [noCode, badCode, otherRoute]) {
      expect(skipSignupBaselineWhenCodePresent(c.ctx)).toBe(false);
      expect(skipSignupBurstUnlessCodePresent(c.ctx)).toBe(true);
    }
    expect(isSignupWithCodeRequest(undefined)).toBe(false);
    expect(requestCarriesWellFormedInviteCode({ body: 'not-an-object' })).toBe(false);
  });

  it('config + handler metadata: both buckets are registered and mutually exclusive on the handler', () => {
    const byName: Record<string, { ttl: number; limit: number; skipIf?: unknown }> =
      Object.fromEntries(THROTTLER_LIMITS.map((t) => [t.name, t]));
    expect(byName[THROTTLER_NAMES.AUTH_SIGNUP]).toMatchObject({ ttl: 3_600_000, limit: 5 });
    expect(byName[THROTTLER_NAMES.AUTH_SIGNUP].skipIf).toBe(skipSignupBaselineWhenCodePresent);
    expect(byName[THROTTLER_NAMES.AUTH_SIGNUP_WITH_CODE]).toMatchObject({ ttl: 3_600_000 });
    expect(byName[THROTTLER_NAMES.AUTH_SIGNUP_WITH_CODE].skipIf).toBe(
      skipSignupBurstUnlessCodePresent,
    );
    expect(THROTTLER_ROUTE_LIMITS.AUTH_SIGNUP_WITH_CODE_PER_HOUR).toBe(30); // default

    const handler = AuthController.prototype.signupWithCode;
    const limit = (name: string) =>
      Reflect.getMetadata(`THROTTLER:LIMIT${name}`, handler) as number;
    expect(limit(THROTTLER_NAMES.AUTH_SIGNUP)).toBe(5);
    expect(limit(THROTTLER_NAMES.AUTH_SIGNUP_WITH_CODE)).toBe(30);
    // /auth/register keeps only the baseline bucket.
    expect(
      Reflect.getMetadata(
        `THROTTLER:LIMIT${THROTTLER_NAMES.AUTH_SIGNUP_WITH_CODE}`,
        AuthController.prototype.register,
      ),
    ).toBeUndefined();
    // Route isolation: every OTHER named throttler is skipped on signup-with-code,
    // the three governing buckets are not.
    const skipped = (name: string) =>
      Reflect.getMetadata(`THROTTLER:SKIP${name}`, handler) as boolean | undefined;
    for (const name of Object.values(THROTTLER_NAMES)) {
      const governs = (SIGNUP_WITH_CODE_ACTIVE_THROTTLERS as readonly string[]).includes(name);
      expect([name, skipped(name)]).toEqual([name, governs ? undefined : true]);
    }
  });

  // In-memory storage arms 1h expiry timers; always clear them so jest exits
  // cleanly even when an assertion fails mid-test.
  const storages: ThrottlerStorageService[] = [];
  afterEach(() => {
    for (const s of storages.splice(0)) s.onApplicationShutdown();
  });

  function buildGuard() {
    const storage = new ThrottlerStorageService();
    storages.push(storage);
    const guard = new UserThrottlerGuard(
      { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) },
      storage,
      new Reflector(),
    );
    return { guard, storage };
  }

  async function hammer(
    guard: UserThrottlerGuard,
    build: () => ExecutionContext,
    n: number,
  ): Promise<{ allowed: number; blocked: number }> {
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < n; i += 1) {
      try {
        if (await guard.canActivate(build())) allowed += 1;
      } catch (err) {
        if (!(err instanceof ThrottlerException)) throw err;
        blocked += 1;
      }
    }
    return { allowed, blocked };
  }

  it('codeless signups from one IP: 5 allowed, the 6th is 429', async () => {
    const { guard } = buildGuard();
    await guard.onModuleInit();
    const build = () =>
      makeCtx({
        path: '/auth/signup-with-code',
        body: { email: 'a@b.c', password: 'x' },
        ip: '10.0.0.1',
      }).ctx;
    expect(await hammer(guard, build, 6)).toEqual({ allowed: 5, blocked: 1 });
  });

  it('signups carrying a well-formed code from one IP: 30 allowed, the 31st is 429', async () => {
    const { guard } = buildGuard();
    await guard.onModuleInit();
    const build = () =>
      makeCtx({
        path: '/auth/signup-with-code',
        body: { email: 'a@b.c', invite_code: 'GP-CLINIC' },
        ip: '10.0.0.2',
      }).ctx;
    expect(await hammer(guard, build, 31)).toEqual({ allowed: 30, blocked: 1 });
  });

  it('the two buckets are independent: exhausting the codeless cap does not block code-bearing signups, and vice versa', async () => {
    const { guard } = buildGuard();
    await guard.onModuleInit();
    const ip = '10.0.0.3';
    const codeless = () =>
      makeCtx({ path: '/auth/signup-with-code', body: { email: 'a@b.c' }, ip }).ctx;
    const withCode = () =>
      makeCtx({ path: '/auth/signup-with-code', body: { invite_code: 'GP-CLINIC' }, ip }).ctx;
    expect(await hammer(guard, codeless, 6)).toEqual({ allowed: 5, blocked: 1 });
    expect(await hammer(guard, withCode, 30)).toEqual({ allowed: 30, blocked: 0 });
    // Codeless is still blocked; code-bearing is now blocked too.
    expect(await hammer(guard, codeless, 1)).toEqual({ allowed: 0, blocked: 1 });
    expect(await hammer(guard, withCode, 1)).toEqual({ allowed: 0, blocked: 1 });
  });

  it('a malformed code does NOT unlock the burst bucket (counts against the 5/h baseline)', async () => {
    const { guard } = buildGuard();
    await guard.onModuleInit();
    const build = () =>
      makeCtx({
        path: '/auth/signup-with-code',
        body: { invite_code: 'not a code!!' },
        ip: '10.0.0.4',
      }).ctx;
    expect(await hammer(guard, build, 6)).toEqual({ allowed: 5, blocked: 1 });
  });
});
