import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { AGE_CONFIRMATION_REQUIRED } from '../src/auth/client-age';
import {
  DunningLockoutGuard,
  isAgeConfirmationWhileLocked,
} from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { ProfileController } from '../src/profile/profile.controller';
import { AccountDeletionController } from '../src/account-deletion/account-deletion.controller';
import { DataExportController } from '../src/data-export/data-export.controller';
import { DunningStatusController } from '../src/checkout/dunning-v2/dunning-status.controller';
import { ClientBillingController } from '../src/checkout/client-billing.controller';
import { ClientMacrosController } from '../src/macros/macros.controller';
import { UsersController } from '../src/users/users.controller';

// FIXAGE2 R8: "a billing-locked client the gate refuses can still save their
// date of birth or reach payment recovery." Production runs the global
// JwtAuthGuard (age gate) and then the global DunningLockoutGuard
// (app.module.ts APP_GUARD order). This walks that real chain for one
// client who is both payment-locked and not yet confirmed 16+.

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ADULT = new Date('1990-01-01T00:00:00.000Z');

type Handler = (...a: unknown[]) => unknown;
type Cls = { prototype: object; name: string };
const h = (cls: Cls, name: string): Handler => (cls.prototype as Record<string, Handler>)[name];

function chain() {
  const profile: { date_of_birth: Date | null } = { date_of_birth: null };
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'u-locked',
        role: 'student',
        coach_id: 'coach-1',
        deleted_at: null,
        deletion_scheduled_at: null,
      })),
    },
    userProfile: { findUnique: jest.fn(async () => ({ ...profile })) },
    // Day-10 lock on the client's only purchase; no other live access.
    dunningState: { findFirst: jest.fn(async () => ({ id: 'd1', purchase_id: 'p1' })) },
    clientPurchase: { findMany: jest.fn(async () => []) },
  };
  const jwks: any = { verify: jest.fn(async (t: string) => ({ sub: t })) };
  const ptm: any = { emit: jest.fn() };
  const auth = new JwtAuthGuard(prisma, jwks, new Reflector(), ptm);
  const lock = new DunningLockoutGuard(prisma);
  const send = async (method: string, path: string, body: unknown, cls: Cls, handler: Handler) => {
    const req: Record<string, unknown> = { method, path, body, headers: { authorization: 'Bearer locked' } };
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => cls,
    };
    try {
      await auth.canActivate(ctx);
      await lock.canActivate(ctx);
      return 'answers';
    } catch (e) {
      if (!(e instanceof ForbiddenException)) throw e;
      return (e.getResponse() as { code?: string }).code;
    }
  };
  return { send, profile };
}

const DOB = { date_of_birth: '1990-01-01' };

// [row, method, path, body, controller, handler, before the save, after it]
const ROWS: Array<[string, string, string, unknown, Cls, string, string | undefined, string | undefined]> = [
  ['the age step save (date of birth only)', 'PUT', '/profile', DOB, ProfileController, 'updateProfile', 'answers', 'answers'],
  ['a profile write with any other field', 'PUT', '/profile', { ...DOB, weight_kg: 80 }, ProfileController, 'updateProfile', LOCKED_DUNNING_CODE, LOCKED_DUNNING_CODE],
  ['a profile write without a date of birth', 'PUT', '/profile', { first_name: 'Cam' }, ProfileController, 'updateProfile', LOCKED_DUNNING_CODE, LOCKED_DUNNING_CODE],
  ['the lockout status read', 'GET', '/api/v1/checkout/dunning', undefined, DunningStatusController, 'status', AGE_CONFIRMATION_REQUIRED, 'answers'],
  ['payment recovery: update card', 'POST', '/api/v1/checkout/payment-method/setup-intent', {}, ClientBillingController, 'createSetupIntent', AGE_CONFIRMATION_REQUIRED, 'answers'],
  ['delete my account', 'POST', '/me/delete-account', {}, AccountDeletionController, 'requestDeletion', 'answers', 'answers'],
  ['download my data', 'GET', '/api/v1/me/data-export/status', undefined, DataExportController, 'getStatus', 'answers', 'answers'],
  ['a client route the lock closes', 'PATCH', '/users/me/preferences', {}, UsersController, 'patchPreferences', AGE_CONFIRMATION_REQUIRED, LOCKED_DUNNING_CODE],
  ['a basic function the lock keeps open (food targets)', 'GET', '/api/v1/me/macros/current', undefined, ClientMacrosController, 'current', AGE_CONFIRMATION_REQUIRED, 'answers'],
  // C-PF-2 (PF-3-BE): the lock lets the phone's own push token through too
  // (it was LOCKED_DUNNING after the age step, so sign-out left the token).
  ['sign-out clears the push token (FIXAGE2 R5)', 'PATCH', '/users/me/push-token', { token: null }, UsersController, 'updatePushToken', 'answers', 'answers'],
];

describe('FIXAGE2 R8: age gate then payment lock, one locked client not yet confirmed 16+', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  it.each(ROWS)('%s', async (_row, method, path, body, cls, name, before, after) => {
    const handler = h(cls, name);
    expect(typeof handler).toBe('function');
    const c = chain();
    expect(await c.send(method, path, body, cls, handler)).toBe(before);
    // The age step saved a 16+ date: the ordinary payment lock applies.
    c.profile.date_of_birth = ADULT;
    expect(await c.send(method, path, body, cls, handler)).toBe(after);
  });

  it('the opening is exactly PUT /profile with only date_of_birth', () => {
    expect(isAgeConfirmationWhileLocked('PUT', 'profile', DOB)).toBe(true);
    expect(isAgeConfirmationWhileLocked('put', 'profile', DOB)).toBe(true);
    for (const [m, p, b] of [
      ['POST', 'profile', DOB],
      ['PATCH', 'profile', DOB],
      ['PUT', 'profile/extra', DOB],
      ['PUT', 'users/me', DOB],
      ['PUT', 'profile', { dob: '1990-01-01' }],
      ['PUT', 'profile', {}],
      ['PUT', 'profile', null],
      ['PUT', 'profile', '1990-01-01'],
      [undefined, 'profile', DOB],
    ] as Array<[string | undefined, string, unknown]>) {
      expect([m, p, b, isAgeConfirmationWhileLocked(m, p, b)]).toEqual([m, p, b, false]);
    }
  });
});
