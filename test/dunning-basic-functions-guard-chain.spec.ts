// test/dunning-basic-functions-guard-chain.spec.ts
//
// B1 (owner 10-08 23:5x: "No reason to ever lock a client from basic
// functions"; Sol B1 on b#899). The request runs the global DunningLockoutGuard
// (FEATURE_DUNNING_V2 is on in production) and then the controller's
// ClientEntitlementGuard. Before this fix a client whose payment had failed
// through Day 10 got 403 LOCKED_DUNNING on food logging even though the package
// guard let them through.
//
// Both real guards run in that order against the real controller metadata, so
// the test fails if either guard, or a marker, changes by mistake.

import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../src/prisma.service';
import { AiController } from '../src/ai/ai.controller';
import { CommunityController } from '../src/community/community.controller';
import { LogController } from '../src/log/log.controller';
import { SchedulingController } from '../src/scheduling/scheduling.controller';
import { WaterController } from '../src/water/water.controller';
import { WorkoutController } from '../src/workout/workout.controller';
import { fakeOf } from './ai-egress/ai-egress.fakes';

type AnyCtor = abstract new (...args: never[]) => unknown;

const FLAG = 'FEATURE_DUNNING_V2';
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

function world(opts: { lockedDay10: boolean; paidPackage: boolean }) {
  const prisma = {
    // effectiveLock: the Day-10 locked cycle, and no other live access.
    dunningState: {
      findFirst: jest.fn(async () => (opts.lockedDay10 ? { id: 'dun-1', purchase_id: 'pur-1' } : null)),
    },
    clientPurchase: {
      findMany: jest.fn(async () => []),
      // ClientEntitlementGuard's package lookup on unmarked routes.
      findFirst: jest.fn(async () => (opts.paidPackage ? { id: 'pur-2' } : null)),
    },
  };
  const asPrisma = fakeOf<PrismaService>(prisma);
  return {
    prisma,
    dunning: new DunningLockoutGuard(asPrisma),
    entitlement: new ClientEntitlementGuard(asPrisma, new Reflector()),
  };
}

function ctx(
  controller: AnyCtor,
  handler: string,
  method: string,
  path: string,
  user: Record<string, unknown>,
): ExecutionContext {
  const fn = (controller.prototype as Record<string, unknown>)[handler];
  if (typeof fn !== 'function') throw new Error(`${controller.name}.${handler} not found`);
  return fakeOf<ExecutionContext>({
    switchToHttp: () => ({ getRequest: () => ({ method, path, user }) }),
    getHandler: () => fn,
    getClass: () => controller,
  });
}

/** Runs the global lockout guard, then the controller's package guard. */
async function chain(w: ReturnType<typeof world>, context: ExecutionContext): Promise<number | string> {
  try {
    await w.dunning.canActivate(context);
    await w.entitlement.canActivate(context);
    return 200;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const body = err.getResponse() as { code?: string };
    return body.code ? `${err.getStatus()} ${body.code}` : err.getStatus();
  }
}

const coached = { id: 'client-b', role: 'student', coach_id: 'coach-1' };
const coachless = { id: 'client-a', role: 'student', coach_id: null };

describe('B1 — a Day-10 locked client still logs; coach services stay locked', () => {
  it.each<[string, AnyCtor, string, string, string]>([
    ['POST /log/food', LogController, 'logFood', 'POST', '/api/log/food'],
    ['GET /log/daily', LogController, 'getDaily', 'GET', '/api/log/daily'],
    ['POST /workouts', WorkoutController, 'createWorkout', 'POST', '/api/workouts'],
    ['POST /nutrition/water', WaterController, 'logWater', 'POST', '/api/nutrition/water'],
  ])('%s: allowed for a Day-10 locked client, no lock lookup', async (_label, controller, handler, method, path) => {
    const w = world({ lockedDay10: true, paidPackage: false });
    expect(await chain(w, ctx(controller, handler, method, path, coached))).toBe(200);
    expect(w.prisma.dunningState.findFirst).not.toHaveBeenCalled();
  });

  it.each<[string, AnyCtor, string, string, string]>([
    ['GET /scheduling/my-coaches', SchedulingController, 'listMyCoaches', 'GET', '/api/scheduling/my-coaches'],
    ['GET /community/feed', CommunityController, 'getFeed', 'GET', '/api/community/feed'],
    // AI guidance is marked open to every client but stays locked, like Roman.
    ['POST /ai/chat', AiController, 'chat', 'POST', '/api/ai/chat'],
  ])('%s: still 403 LOCKED_DUNNING for a Day-10 locked client', async (_label, controller, handler, method, path) => {
    const w = world({ lockedDay10: true, paidPackage: false });
    expect(await chain(w, ctx(controller, handler, method, path, coached))).toBe('403 LOCKED_DUNNING');
  });

  it('a coached client with no package logs food (no lock, no package lookup)', async () => {
    const w = world({ lockedDay10: false, paidPackage: false });
    expect(await chain(w, ctx(LogController, 'logFood', 'POST', '/api/log/food', coached))).toBe(200);
    expect(w.prisma.clientPurchase.findFirst).not.toHaveBeenCalled();
  });

  it('a coached client with no package still gets 402 on an unmarked coach service', async () => {
    const w = world({ lockedDay10: false, paidPackage: false });
    expect(await chain(w, ctx(CommunityController, 'getFeed', 'GET', '/api/community/feed', coached))).toBe(402);
  });

  it('a client with no coach logs food', async () => {
    const w = world({ lockedDay10: false, paidPackage: false });
    expect(await chain(w, ctx(LogController, 'logFood', 'POST', '/api/log/food', coachless))).toBe(200);
  });
});
