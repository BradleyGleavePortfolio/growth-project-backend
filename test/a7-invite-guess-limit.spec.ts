// A7 — wrong invite-code guesses are limited per network address. Real
// InviteCodesService, controllers and LoginThrottleResetService over the real
// in-memory throttler storage. On main the same 5,000 misses never slow
// anything (ops probe B-A7); here misses past the limit get the standard 429.
import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { InviteCodesController } from '../src/invite-codes/invite-codes.controller';
import { InviteLandingController } from '../src/invite-landing/invite-landing.controller';
import { InviteLandingService } from '../src/invite-landing/invite-landing.service';
import { AuthController } from '../src/auth/auth.controller';
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
  };
  const svc = new InviteCodesService(cast(prisma), cast({ capture: jest.fn() }), cast({}), cast({}));
  const guard = new LoginThrottleResetService(cast(storage));
  return {
    codes: new InviteCodesController(svc, guard),
    landing: new InviteLandingController(new InviteLandingService(svc), guard),
    auth: new AuthController(cast({}), svc, guard),
  };
}
const from = (ip: string) => ({ headers: { 'fly-client-ip': ip } });
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
