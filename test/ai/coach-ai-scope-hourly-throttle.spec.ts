import { ExecutionContext, HttpException, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { AiController } from '../../src/ai/ai.controller';
import { CoachAIExecutionController } from '../../src/ai/coach/coach-ai-execution.controller';
import { AiGatewayController } from '../../src/ai/gateway/ai-gateway.controller';
import { THROTTLER_LIMITS } from '../../src/throttler/throttler.config';
import { UserThrottlerGuard } from '../../src/throttler/user-throttler.guard';

// ROMAN-HOURLY-SCOPE: real guard, controller metadata and storage, as in #983.
// These are throttle-layer proofs, not permission grants: CoachGuard still
// rejects clients on the draft routes; JWT, tenant fences and pool gates stay.
type Handler = (...args: never[]) => unknown;
type Route = { path: string; controller: Type; handler: Handler; oldLimit: number };
const ROUTES: Route[] = [
  { path: '/v1/coach/ai/draft/assign-workout', controller: CoachAIExecutionController,
    handler: CoachAIExecutionController.prototype.draftAssignWorkout, oldLimit: 30 },
  { path: '/v1/coach/ai/draft/assign-meal-plan', controller: CoachAIExecutionController,
    handler: CoachAIExecutionController.prototype.draftAssignMealPlan, oldLimit: 30 },
  { path: '/v1/coach/ai/draft/send-notification', controller: CoachAIExecutionController,
    handler: CoachAIExecutionController.prototype.draftSendNotification, oldLimit: 10 },
  { path: '/ai/gateway/invoke', controller: AiGatewayController,
    handler: AiGatewayController.prototype.invoke, oldLimit: 20 },
  { path: '/ai/chat', controller: AiController,
    handler: AiController.prototype.chat, oldLimit: 20 },
];

let storage: ThrottlerStorageService;
beforeEach(() => { storage = new ThrottlerStorageService(); });
afterEach(() => { storage.onApplicationShutdown(); });

async function makeGuard(): Promise<UserThrottlerGuard> {
  const guard = new UserThrottlerGuard(
    { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) }, storage, new Reflector(),
  );
  await guard.onModuleInit();
  return guard;
}

function ctxFor(route: Route, id: string, role?: string): ExecutionContext {
  const req = { route: { path: route.path }, url: route.path,
    user: { id, role }, headers: {}, ip: '198.51.100.1' };
  const res = { header: (): void => undefined, setHeader: (): void => undefined };
  return new ExecutionContextHost([req, res, undefined], route.controller, route.handler);
}

async function expectCeiling(
  guard: UserThrottlerGuard, context: ExecutionContext, limit: number,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    expect(await guard.canActivate(context)).toBe(true);
  }
  // Fail on non-HTTP errors too: only a real 429 proves the ceiling.
  try {
    await guard.canActivate(context);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    return;
  }
  throw new Error(`Request ${limit + 1} was not limited`);
}

describe.each(ROUTES)('ROMAN-HOURLY-SCOPE POST $path', (route) => {
  it('keeps the one-hour window', () => {
    expect(new Reflector().getAllAndOverride(THROTTLER_TTL + 'default',
      [route.handler, route.controller])).toBe(3_600_000);
  });

  it('accepts 60 coach requests and limits the 61st', async () => {
    await expectCeiling(await makeGuard(), ctxFor(route, 'coach-a', 'coach'), 60);
  });

  it.each(['student', 'owner', undefined])('keeps the old ceiling for role %s', async (role) => {
    await expectCeiling(await makeGuard(), ctxFor(route, 'other', role), route.oldLimit);
  });

  it('never counts another coach or client against this coach, even on one IP', async () => {
    const guard = await makeGuard();
    await expectCeiling(guard, ctxFor(route, 'coach-a', 'coach'), 60);
    await expectCeiling(guard, ctxFor(route, 'client', 'student'), route.oldLimit);
    await expectCeiling(guard, ctxFor(route, 'coach-b', 'coach'), 60);
  });
});

it('keeps each route allowance separate for the same coach', async () => {
  const guard = await makeGuard();
  for (const route of ROUTES) {
    await expectCeiling(guard, ctxFor(route, 'coach-a', 'coach'), 60);
  }
});
