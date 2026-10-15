import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import {
  AGE_CONFIRMATION_REQUIRED,
  MIN_CLIENT_AGE,
  confirmsMinClientAge,
} from '../src/auth/client-age';
import { AuthController } from '../src/auth/auth.controller';
import { OnboardingController } from '../src/onboarding/onboarding.controller';
import { ConsentController } from '../src/consent/consent.controller';
import { AiConsentController } from '../src/ai-consent/ai-consent.controller';
import { ProfileController } from '../src/profile/profile.controller';
import { AccountDeletionController } from '../src/account-deletion/account-deletion.controller';
import { DataExportController } from '../src/data-export/data-export.controller';
import { ClientMacrosController } from '../src/macros/macros.controller';
import { LogController } from '../src/log/log.controller';
import { ClientMessagingController } from '../src/messaging/client-messaging.controller';
import { RomanController } from '../src/roman/roman.controller';
import { VALIDATORS } from '../src/onboarding/consultation-answers';

// AGEGATE16 (owner #C8-UNDER18-B): "if they dont agree theyre over 16 they
// dont get in the app". The rule lives in JwtAuthGuard and reads only the
// caller's own profile date of birth, so it holds for every way a client
// account is made. The real Reflector reads the real controller metadata.

const NOW = new Date('2026-10-14T12:00:00.000Z');
const dob = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ADULT = dob('1990-01-01');
const SIXTEEN_TODAY = dob('2010-10-14');
const SIXTEEN_TOMORROW = dob('2010-10-15');

type Cls = abstract new (...args: never[]) => unknown;
const methodsOf = (cls: Cls): Array<(...a: unknown[]) => unknown> =>
  Object.getOwnPropertyNames(cls.prototype)
    .filter((n) => n !== 'constructor')
    .map((n) => (cls.prototype as Record<string, (...a: unknown[]) => unknown>)[n])
    .filter((m) => typeof m === 'function');

function harness(users: Record<string, Record<string, unknown>>, profiles: Record<string, Date | null>) {
  const profileReads: unknown[] = [];
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { supabase_id: string } }) => {
        const u = users[where.supabase_id];
        return u ? { deleted_at: null, deletion_scheduled_at: null, ...u } : null;
      }),
    },
    userProfile: {
      findUnique: jest.fn(async (args: { where: { user_id: string } }) => {
        profileReads.push(args.where);
        const d = profiles[args.where.user_id];
        return d === undefined ? null : { date_of_birth: d };
      }),
    },
  };
  const jwks: any = { verify: jest.fn(async (t: string) => ({ sub: t })) };
  const ptm: any = { emit: jest.fn() };
  const guard = new JwtAuthGuard(prisma, jwks, new Reflector(), ptm);
  const call = async (sub: string, cls: Cls, handler: (...a: unknown[]) => unknown) => {
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${sub}` } };
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => cls,
    };
    const outcome = await guard.canActivate(ctx).catch((e: unknown) => e);
    return { outcome, req };
  };
  return { call, profileReads };
}

const refused = (outcome: unknown) =>
  outcome instanceof ForbiddenException &&
  (outcome.getResponse() as { code?: string }).code === AGE_CONFIRMATION_REQUIRED;

// A client route: the client's own targets, food log, coach thread and Roman.
const CLIENT_ROUTES: Array<[string, Cls, (...a: unknown[]) => unknown]> = [
  ['GET /me/macros/current', ClientMacrosController, methodsOf(ClientMacrosController)[0]],
  ...methodsOf(LogController).slice(0, 2).map((m) => ['food log', LogController, m] as [string, Cls, typeof m]),
  ['coach thread', ClientMessagingController, methodsOf(ClientMessagingController)[0]],
  ['Roman', RomanController, methodsOf(RomanController)[0]],
];

// Every way a client account reaches the server, with the row it leaves
// (reports/AGEGATE16.md entry-path map). None of them writes a date of birth.
const JOIN_PATHS: Array<[string, Record<string, unknown>, Date | null | undefined]> = [
  ['POST /auth/register (email sign-up)', { role: 'student', coach_id: null }, undefined],
  ['POST /auth/signup-with-code (coach invite code)', { role: 'student', coach_id: 'coach-1' }, undefined],
  ['POST /auth/google (social sign-in, new account)', { role: 'student', coach_id: null }, undefined],
  ['POST /auth/apple (social sign-in, new account)', { role: 'student', coach_id: null }, undefined],
  ['POST /auth/select-role student (social sign-up role choice)', { role: 'student', coach_id: null }, undefined],
  ['POST /auth/attach-invite-code (join code after sign-up)', { role: 'student', coach_id: 'coach-1' }, undefined],
  ['POST /invites/accept/:token (coach email invite)', { role: 'student', coach_id: 'coach-1' }, undefined],
  ['coachless join code redeemed later', { role: 'student', coach_id: 'coach-1' }, undefined],
  ['storefront guest checkout (account made at payment)', { role: 'student', coach_id: 'coach-1' }, undefined],
  ['talent marketplace apply, later linked (import)', { role: 'student', coach_id: null }, undefined],
  ['consultation started, B2 not answered yet', { role: 'student', coach_id: null }, null],
  ['PUT /profile onboardingCompleted true without the consultation', { role: 'student', coach_id: null }, null],
  ['date of birth under 16 saved through PUT /profile', { role: 'student', coach_id: null }, SIXTEEN_TOMORROW],
];

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('AGEGATE16: every client confirms 16 or older before client routes answer', () => {
  it.each(JOIN_PATHS)('%s: refused on every client route until confirmed', async (_path, row, stored) => {
    const h = harness({ joiner: { id: 'u-join', ...row } }, stored === undefined ? {} : { 'u-join': stored });
    for (const [name, cls, handler] of CLIENT_ROUTES) {
      const { outcome, req } = await h.call('joiner', cls, handler);
      expect([name, refused(outcome)]).toEqual([name, true]);
      expect(req.user).toBeUndefined();
    }
  });

  it.each(JOIN_PATHS)('%s: the routes needed to get in still answer', async (_path, row, stored) => {
    const h = harness({ joiner: { id: 'u-join', ...row } }, stored === undefined ? {} : { 'u-join': stored });
    for (const cls of [
      AuthController,
      OnboardingController,
      ConsentController,
      AiConsentController,
      ProfileController,
      AccountDeletionController,
      DataExportController,
    ] as Cls[]) {
      for (const handler of methodsOf(cls)) {
        const { outcome } = await h.call('joiner', cls, handler);
        expect([cls.name, handler.name, outcome]).toEqual([cls.name, handler.name, true]);
      }
    }
  });

  it('a client who confirmed 16 or older is unchanged: same user on the request, no extra refusal', async () => {
    const user = { id: 'u-ok', role: 'student', coach_id: 'coach-1' };
    for (const born of [ADULT, SIXTEEN_TODAY]) {
      const h = harness({ ok: user }, { 'u-ok': born });
      for (const [, cls, handler] of CLIENT_ROUTES) {
        const { outcome, req } = await h.call('ok', cls, handler);
        expect(outcome).toBe(true);
        expect(req.user).toEqual(expect.objectContaining(user));
      }
    }
  });

  it('coaches, sub-coaches and owners are never asked and their profile is never read', async () => {
    const h = harness(
      {
        coach: { id: 'c-1', role: 'coach', coach_id: null },
        sub: { id: 's-1', role: 'sub_coach', coach_id: 'c-1' },
        owner: { id: 'o-1', role: 'owner', coach_id: null },
      },
      {},
    );
    for (const who of ['coach', 'sub', 'owner']) {
      for (const [, cls, handler] of CLIENT_ROUTES) {
        expect((await h.call(who, cls, handler)).outcome).toBe(true);
      }
    }
    expect(h.profileReads).toEqual([]);
  });

  it('cross-tenant: one client is decided by their own profile only, never by another client\'s', async () => {
    const h = harness(
      {
        a: { id: 'client-a', role: 'student', coach_id: 'coach-1' },
        b: { id: 'client-b', role: 'student', coach_id: 'coach-1' },
      },
      { 'client-b': ADULT },
    );
    const [, cls, handler] = CLIENT_ROUTES[0];
    expect(refused((await h.call('a', cls, handler)).outcome)).toBe(true);
    expect((await h.call('b', cls, handler)).outcome).toBe(true);
    expect(h.profileReads).toEqual([{ user_id: 'client-a' }, { user_id: 'client-b' }]);
  });

  it('the refusal is a 403 with a stable code, and 16 is the same number the consultation uses', () => {
    expect(MIN_CLIENT_AGE).toBe(16);
    expect(VALIDATORS.B2('2010-10-14', NOW)).toBeNull();
    expect(VALIDATORS.B2('2010-10-15', NOW)).toBe('age must be 16-100');
    expect(confirmsMinClientAge(SIXTEEN_TODAY, NOW)).toBe(true);
    expect(confirmsMinClientAge(SIXTEEN_TOMORROW, NOW)).toBe(false);
    expect(confirmsMinClientAge(null, NOW)).toBe(false);
    expect(confirmsMinClientAge(new Date('nope'), NOW)).toBe(false);
  });
});
