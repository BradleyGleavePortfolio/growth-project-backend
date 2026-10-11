// A7 — wrong invite-code guesses are limited per network address. Real
// InviteCodesService, controllers and LoginThrottleResetService over the real
// in-memory throttler storage. On main the same 5,000 misses never slow
// anything (ops probe B-A7); here misses past the limit get the standard 429.
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteCodesController } from '../src/invite-codes/invite-codes.controller';
import { InviteLandingController } from '../src/invite-landing/invite-landing.controller';
import { InviteLandingService } from '../src/invite-landing/invite-landing.service';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { CoachlessController } from '../src/coachless/coachless.controller';
import { COACHLESS_ERROR, CoachlessError } from '../src/coachless/coachless.errors';
import { InviteGrantController } from '../src/invite-grant/invite-grant.controller';
import { INVITE_CODE_MISSES_PER_HOUR, LoginThrottleResetService } from '../src/throttler/login-throttle-reset.service';

const cast = <T>(value: unknown): T => value as T;
const REAL = 'GP-K7M2QX';
const coach = { user_id: 'c1', business_name: 'Biz', user: { id: 'c1', name: 'Coach One', role: 'coach' } };
const storages: ThrottlerStorageService[] = [];
function build(storage: unknown = storages[storages.push(new ThrottlerStorageService()) - 1]) {
  const prisma = {
    coachProfile: {
      findUnique: jest.fn(async (a: { where: { invite_code?: string } }) => (a.where.invite_code === REAL ? coach : null)),
    },
    coachSubscription: { findUnique: jest.fn(async () => ({ status: 'active' })) },
    inviteCode: { findUnique: jest.fn(async () => null) },
    // A client of another coach: a real code is answered 409 (the lookup ran), never "invalid".
    user: { findUnique: jest.fn(async () => ({ id: 'u', role: 'student', coach_id: 'other' })) },
  };
  const svc = new InviteCodesService(cast(prisma), cast({ capture: jest.fn() }), cast({}), cast({}));
  const guard = new LoginThrottleResetService(cast(storage));
  return {
    codes: new InviteCodesController(svc, guard),
    landing: new InviteLandingController(new InviteLandingService(svc), guard),
    auth: new AuthController(
      new AuthService(cast(prisma), svc, cast({ capture: jest.fn() }), cast({}), cast({}), cast({})),
      svc,
      guard,
    ),
    coachless: new CoachlessController(cast({}), cast(coachlessStub), cast({}), cast({}), guard),
    grants: new InviteGrantController(cast(grantsStub), guard),
  };
}
const coachlessStub = {
  check: async (_u: unknown, c: string) =>
    c === REAL ? { valid: true } : { valid: false, code: COACHLESS_ERROR.CODE_INVALID },
  redeem: async (a: { rawCode: string }) => {
    if (a.rawCode !== REAL) throw new CoachlessError(COACHLESS_ERROR.CODE_INVALID);
    throw new CoachlessError(COACHLESS_ERROR.ALREADY_ATTACHED);
  },
};
const grantsStub = {
  claimGrantForCode: async (_c: unknown, code: string) => {
    if (code !== REAL) throw new NotFoundException({ error: 'INVITE_CODE_NOT_FOUND', message: 'x' });
    throw new ConflictException('grant revoked');
  },
};
const from = (ip: string) => ({ headers: { 'fly-client-ip': ip } });
const as = (id: string, ip: string) => cast<never>({ user: { id, role: 'student' }, ...from(ip) });
const guess = (i: number) => `GP-${(100000 + i).toString(36).toUpperCase().slice(-6).padStart(6, 'Z')}`;
const res = () => cast<Response>({ setHeader: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() });
const limited = expect.any(ThrottlerException);
afterAll(() => storages.forEach((s) => s.onApplicationShutdown()));

describe('A7 — wrong invite-code guesses are limited per address', () => {
  it('5,000 misses from one address: misses past the limit get 429; a real code from another address still works', async () => {
    const { codes } = build();
    let answered = 0;
    let blocked = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        expect((await codes.previewInvite(guess(i), from('203.0.113.9'))).valid).toBe(false);
        answered++;
      } catch (err) {
        expect((err as ThrottlerException).getStatus()).toBe(429);
        blocked++;
      }
    }
    expect([answered, blocked]).toEqual([INVITE_CODE_MISSES_PER_HOUR, 5000 - INVITE_CODE_MISSES_PER_HOUR]);
    await expect(codes.previewInvite(REAL, from('203.0.113.9'))).rejects.toEqual(limited);
    expect((await codes.previewInvite(REAL, from('198.51.100.4'))).valid).toBe(true);
  });

  it('misses are counted across all five public lookups', async () => {
    const { codes, landing, auth } = build();
    const ip = from('203.0.113.10');
    const calls = [
      (c: string) => codes.previewInvite(c, ip),
      (c: string) => codes.acceptInviteToken(c, {}, ip),
      (c: string) => auth.validateInviteCode({ code: c }, cast(ip)),
      (c: string) => landing.joinHtml(c, res(), undefined, ip),
      (c: string) => landing.inviteHtml(c, res(), undefined, ip),
    ];
    for (let i = 0; i < INVITE_CODE_MISSES_PER_HOUR; i++) await calls[i % 5](guess(i));
    for (const call of calls) await expect(call(REAL)).rejects.toEqual(limited);
  });

  it('correct codes never count: 500 real previews from one clinic network leave its full miss budget', async () => {
    const { codes } = build();
    const ip = from('192.0.2.50');
    for (let i = 0; i < 500; i++) expect((await codes.previewInvite(REAL, ip)).valid).toBe(true);
    for (let i = 0; i < INVITE_CODE_MISSES_PER_HOUR - 1; i++) await codes.previewInvite(guess(i), ip);
    expect((await codes.previewInvite(REAL, ip)).valid).toBe(true);
  });

  it('a throttler storage outage does not break invites (fails open like the route throttles)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { codes } = build({ increment: jest.fn().mockRejectedValue(new Error('redis down')) });
    for (let i = 0; i < 100; i++)
      expect((await codes.previewInvite(guess(i), from('203.0.113.11'))).valid).toBe(false);
    expect((await codes.previewInvite(REAL, from('203.0.113.11'))).valid).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// F-927-A7 (Opus B-927-1) — signed-in and signup code entry share the same
// miss counter, per address AND per account. At 523422f1 all 5,000 attach
// misses below were answered (L-927-OPUS probe).
describe('F-927-A7 — code-consuming routes share the miss limit', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());
  it('5,000 attach-invite-code misses: only 60 answered; a real code still works elsewhere', async () => {
    const { auth } = build();
    let answered = 0;
    for (let i = 0; i < 5000; i++) {
      const err = await auth.attachInviteCode(as('u1', '203.0.113.77'), cast({ invite_code: guess(i) })).catch((e) => e);
      if (err instanceof BadRequestException) answered++;
      else expect(err).toEqual(limited);
    }
    expect(answered).toBe(INVITE_CODE_MISSES_PER_HOUR);
    const real = cast({ invite_code: REAL });
    await expect(auth.attachInviteCode(as('u1', '203.0.113.77'), real)).rejects.toEqual(limited);
    await expect(auth.attachInviteCode(as('u2', '198.51.100.7'), real)).rejects.toBeInstanceOf(ConflictException);
    for (let i = 0; i < 100; i++) await auth.attachInviteCode(as('u3', '192.0.2.8'), real).catch((e) => e);
    await expect(auth.attachInviteCode(as('u3', '192.0.2.8'), cast({ invite_code: guess(1) }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('an account does not get a fresh budget by changing networks', async () => {
    const { codes } = build();
    for (let i = 0; i < INVITE_CODE_MISSES_PER_HOUR; i++)
      await codes.attachCoachCode(as('u4', `10.0.0.${i}`), { code: guess(i) }).catch((e) => e);
    await expect(codes.attachCoachCode(as('u4', '10.9.9.9'), { code: REAL })).rejects.toEqual(limited);
    await expect(codes.attachCoachCode(as('u5', '10.9.9.9'), { code: REAL })).rejects.toBeInstanceOf(ConflictException);
  });

  it('misses on every code-consuming route count in one bucket, refused before the lookup', async () => {
    const { auth, codes, coachless, grants } = build();
    const key = '7d3c1f4e-8a2b-4c6d-9e0f-1a2b3c4d5e6f';
    const signup = (c: string) => cast({ email: 'a@example.test', password: 'x', name: 'A', invite_code: c });
    const calls = [
      (c: string, r: never) => auth.attachInviteCode(r, cast({ invite_code: c })),
      (c: string, r: never) => auth.selectRole(r, cast({ role: 'student', invite_code: c })),
      (c: string, r: never) => auth.signupWithCode(signup(c), r),
      (c: string, r: never) => codes.attachCoachCode(r, { code: c }),
      (c: string, r: never) => coachless.check(r, cast({ code: c })),
      (c: string, r: never) => coachless.redeem(r, cast({ code: c }), key),
      (c: string, r: never) => grants.claimGrant(r, cast({ code: c })),
    ];
    for (let i = 0; i < INVITE_CODE_MISSES_PER_HOUR; i++)
      await calls[i % calls.length](guess(i), as('u6', '203.0.113.88')).catch((e) => e);
    for (const call of calls) await expect(call(REAL, as('u7', '203.0.113.88'))).rejects.toEqual(limited);
  });
});
