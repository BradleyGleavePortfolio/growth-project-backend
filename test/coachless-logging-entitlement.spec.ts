// test/coachless-logging-entitlement.spec.ts
//
// B23 (owner 10-08 14:57 and 15:29, COACHLESS-LOG-132): a client with no coach
// uses everything a coached client uses (logging, targets, plans, check-ins,
// fasting, insights, AI guidance), and only places that need a real coach stay
// coach-only. Before this change every paid route answered 402
// CLIENT_ENTITLEMENT_REQUIRED for a coachless client, so the phone locked the
// Food and Train tabs and re-opened the paywall sheet.
//
// The guard runs with the real Reflector against the real controller
// metadata, so the test fails if a marker is removed or added by mistake. The
// contract block classifies every controller that mounts the guard.

import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { OPEN_TO_COACHLESS_CLIENT_KEY } from '../src/common/decorators/open-to-coachless-client.decorator';
import type { PrismaService } from '../src/prisma.service';

import { AiController } from '../src/ai/ai.controller';
import { AiGatewayController } from '../src/ai/gateway/ai-gateway.controller';
import { ClientCheckInsController } from '../src/check-ins/client-check-ins.controller';
import { ClientGuidelinesController } from '../src/coach/client-guidelines.controller';
import { CommunityController } from '../src/community/community.controller';
import { FastingController } from '../src/fasting/fasting.controller';
import { HolisticInsightsController } from '../src/insights/holistic-insights.controller';
import { LogController } from '../src/log/log.controller';
import { ClientMacrosController } from '../src/macros/macros.controller';
import {
  ClientMealPlanAliasController,
  ClientMealPlansController,
} from '../src/meal-plans/client-meal-plans.controller';
import { ClientMessagingController } from '../src/messaging/client-messaging.controller';
import { ClientMealPlanController } from '../src/real-meal-plans/real-meal-plans.controller';
import { SchedulingController } from '../src/scheduling/scheduling.controller';
import { AssignmentController } from '../src/workout-builder/workout-builder.controller';
import { WorkoutController } from '../src/workout/workout.controller';
import { WaterController } from '../src/water/water.controller';

type AnyCtor = abstract new (...args: never[]) => unknown;
type Handler = (...args: unknown[]) => unknown;

function handlerOf(controller: AnyCtor, name: string): Handler {
  const method = (controller.prototype as Record<string, unknown>)[name];
  if (typeof method !== 'function') throw new Error(`${controller.name}.${name} not found`);
  return method as Handler;
}

function ctx(controller: AnyCtor, handler: string, user: Record<string, unknown>): ExecutionContext {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handlerOf(controller, handler),
    getClass: () => controller,
  };
  // @ts-expect-error partial ExecutionContext double: the guard reads only these three
  return context;
}

function makeGuard(purchase: { id: string } | null) {
  const findFirst = jest.fn(async () => purchase);
  const prisma = { clientPurchase: { findFirst } };
  // @ts-expect-error partial PrismaService double: the guard reads only clientPurchase.findFirst
  const asPrisma: PrismaService = prisma;
  return { guard: new ClientEntitlementGuard(asPrisma, new Reflector()), findFirst };
}

async function outcome(guard: ClientEntitlementGuard, context: ExecutionContext): Promise<number> {
  try {
    return (await guard.canActivate(context)) ? 200 : 403;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
}

const coachless = { id: 'client-a', role: 'student', coach_id: null };
const coached = { id: 'client-b', role: 'student', coach_id: 'coach-1' };

// What a coached client uses on their own data: open to a client with no coach.
const OPEN_ROUTES: ReadonlyArray<[AnyCtor, string, string]> = [
  [LogController, 'logFood', 'POST /log/food'],
  [LogController, 'getDaily', 'GET /log/daily'],
  [LogController, 'updateEntry', 'PUT /log/food/:id'],
  [LogController, 'deleteEntry', 'DELETE /log/food/:id'],
  [LogController, 'getWeekly', 'GET /log/weekly'],
  [WorkoutController, 'createWorkout', 'POST /workouts'],
  [WorkoutController, 'getWorkouts', 'GET /workouts'],
  [WorkoutController, 'getVolume', 'GET /workouts/volume'],
  [WorkoutController, 'updateWorkout', 'PUT /workouts/:id'],
  [WorkoutController, 'deleteWorkout', 'DELETE /workouts/:id'],
  [WorkoutController, 'getRoutines', 'GET /routines'],
  [WorkoutController, 'createRoutine', 'POST /routines'],
  [ClientMacrosController, 'current', 'GET /me/macros/current'],
  [FastingController, 'startFast', 'POST /fasting/start'],
  [FastingController, 'getHistory', 'GET /fasting/history'],
  [ClientCheckInsController, 'upsert', 'POST /check-ins'],
  [ClientCheckInsController, 'list', 'GET /check-ins'],
  [HolisticInsightsController, 'generate', 'GET /insights/holistic'],
  [ClientMealPlansController, 'list', 'GET /meal-plans'],
  [ClientMealPlanAliasController, 'current', 'GET /me/meal-plan'],
  [ClientMealPlanController, 'today', 'GET /me/meal-plan/today'],
  [AssignmentController, 'listMine', 'GET /assignments/me'],
  [AssignmentController, 'complete', 'PATCH /assignments/:id/complete'],
  [AiController, 'chat', 'POST /ai/chat'],
  [AiController, 'getStructuredContext', 'GET /ai/structured-context'],
];

// Places that need a real coach: unchanged, still 402 without a package.
const COACH_ONLY_ROUTES: ReadonlyArray<[AnyCtor, string, string]> = [
  [SchedulingController, 'listMyCoaches', 'GET /scheduling/my-coaches'],
  [ClientMessagingController, 'voiceUpload', 'POST /messages/voice-upload'],
  [CommunityController, 'getFeed', 'GET /community/feed'],
  [CommunityController, 'postWin', 'POST /community/wins'],
  [AiGatewayController, 'invoke', 'POST /ai/gateway/invoke'],
  [ClientGuidelinesController, 'getMyGuidelines', 'GET /coach/my-guidelines'],
];

describe('B23 — a client with no coach uses every client feature on their own data', () => {
  for (const [controller, handler, label] of OPEN_ROUTES) {
    it(`${label}: open to a client with no coach, no package lookup`, async () => {
      const { guard, findFirst } = makeGuard(null);
      expect(await outcome(guard, ctx(controller, handler, coachless))).toBe(200);
      expect(findFirst).not.toHaveBeenCalled();
    });

    it(`${label}: a client with a coach and no active package still gets 402`, async () => {
      const { guard } = makeGuard(null);
      expect(await outcome(guard, ctx(controller, handler, coached))).toBe(402);
    });

    it(`${label}: a client with a coach and an active package passes`, async () => {
      const { guard } = makeGuard({ id: 'purchase-1' });
      expect(await outcome(guard, ctx(controller, handler, coached))).toBe(200);
    });
  }

  for (const [controller, handler, label] of COACH_ONLY_ROUTES) {
    it(`${label}: needs a coach, so a client with no coach and no package still gets 402`, async () => {
      const { guard } = makeGuard(null);
      expect(await outcome(guard, ctx(controller, handler, coachless))).toBe(402);
    });
  }

  it('water logging needs no package (WaterController never mounted the guard)', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, WaterController) as unknown[] | undefined) ?? [];
    expect(guards).not.toContain(ClientEntitlementGuard);
  });
});

describe('B23 contract — every controller with the paywall guard is classified', () => {
  const OPEN = new Set<AnyCtor>([
    LogController, WorkoutController, ClientMacrosController, FastingController, ClientCheckInsController,
    HolisticInsightsController, ClientMealPlansController, ClientMealPlanAliasController,
    ClientMealPlanController, AssignmentController, AiController,
  ]);
  const COACH_ONLY = new Set<AnyCtor>([
    SchedulingController, ClientMessagingController, CommunityController, AiGatewayController,
    ClientGuidelinesController,
  ]);

  function marked(target: object): boolean {
    return Reflect.getMetadata(OPEN_TO_COACHLESS_CLIENT_KEY, target) === true;
  }

  // A new controller that mounts the guard must be added to OPEN or COACH_ONLY.
  it('no other controller file mounts the paywall guard', () => {
    const root = join(__dirname, '..', 'src');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.controller.ts')
          && /@UseGuards\([^)]*ClientEntitlementGuard/.test(readFileSync(full, 'utf8'))) {
          found.push(relative(root, full).split('\\').join('/'));
        }
      }
    };
    walk(root);
    expect(found.sort()).toEqual([
      'ai/ai.controller.ts', 'ai/gateway/ai-gateway.controller.ts', 'check-ins/client-check-ins.controller.ts',
      'coach/client-guidelines.controller.ts', 'community/community.controller.ts', 'fasting/fasting.controller.ts',
      'insights/holistic-insights.controller.ts', 'log/log.controller.ts', 'macros/macros.controller.ts',
      'meal-plans/client-meal-plans.controller.ts', 'messaging/client-messaging.controller.ts',
      'real-meal-plans/real-meal-plans.controller.ts', 'scheduling/scheduling.controller.ts',
      'workout-builder/workout-builder.controller.ts', 'workout/workout.controller.ts',
    ]);
  });

  for (const controller of [...OPEN, ...COACH_ONLY]) {
    it(`${controller.name}: ${OPEN.has(controller) ? 'open' : 'coach-only'} for a client with no coach`, () => {
      expect(marked(controller)).toBe(OPEN.has(controller));
      const proto = controller.prototype as Record<string, unknown>;
      const markedHandlers = Object.getOwnPropertyNames(proto)
        .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
        .filter((name) => marked(proto[name] as object));
      expect(markedHandlers).toEqual([]);
    });
  }
});
