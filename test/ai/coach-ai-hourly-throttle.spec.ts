import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { CoachAIController } from '../../src/ai/coach/coach-ai.controller';
import { THROTTLER_LIMITS } from '../../src/throttler/throttler.config';
import { UserThrottlerGuard } from '../../src/throttler/user-throttler.guard';

/**
 * ROMAN-HOURLY (owner 2026-10-13, Option 1): the three coach AI generation routes each allow
 * 60 calls an hour per coach (were workout program 5, meal plan 5, client insight 10). The
 * coach AI credit pool stays the real limit (test/ai/coach-ai-metering.spec.ts).
 *
 * Runs the REAL global guard (UserThrottlerGuard + the full THROTTLER_LIMITS list + a real
 * Reflector + in-memory storage) against the real CoachAIController metadata.
 */

type Handler = (...args: never[]) => unknown;

const ROUTES: Array<[string, Handler]> = [
  ['/coach/ai/workout-program', CoachAIController.prototype.generateWorkoutProgram as Handler],
  ['/coach/ai/meal-plan', CoachAIController.prototype.generateMealPlan as Handler],
  ['/coach/ai/client-insight', CoachAIController.prototype.generateClientInsight as Handler],
];

let storage: ThrottlerStorageService | undefined;
afterEach(() => {
  // In-memory storage arms expiry timers; clear them so jest exits cleanly.
  storage?.onApplicationShutdown();
  storage = undefined;
});

async function makeGuard(): Promise<UserThrottlerGuard> {
  storage = new ThrottlerStorageService();
  const guard = new UserThrottlerGuard(
    { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) },
    storage,
    new Reflector(),
  );
  await guard.onModuleInit();
  return guard;
}

function ctxFor(path: string, handler: Handler, coachId: string): ExecutionContext {
  const req = { route: { path }, url: path, user: { id: coachId }, headers: {} };
  const res = { header: (): void => undefined, setHeader: (): void => undefined };
  return new ExecutionContextHost([req, res, undefined], CoachAIController, handler);
}

async function countUntilBlocked(
  guard: UserThrottlerGuard,
  ctx: ExecutionContext,
  max: number,
): Promise<{ accepted: number; status: number | null }> {
  let accepted = 0;
  for (let i = 0; i < max; i += 1) {
    try {
      await guard.canActivate(ctx);
      accepted += 1;
    } catch (err) {
      return { accepted, status: err instanceof HttpException ? err.getStatus() : -1 };
    }
  }
  return { accepted, status: null };
}

describe('ROMAN-HOURLY — coach AI generation allows 60 calls an hour per route', () => {
  it.each(ROUTES)('POST %s: 60 accepted in an hour, the 61st is a 429', async (path, handler) => {
    const guard = await makeGuard();
    expect(await countUntilBlocked(guard, ctxFor(path, handler, 'coach-a'), 70)).toEqual({
      accepted: 60,
      status: 429,
    });
  });

  it('each route has its own 60: a coach who used up workout programs can still generate the other two', async () => {
    const guard = await makeGuard();
    const [[workoutPath, workout], [mealPath, meal], [insightPath, insight]] = ROUTES;
    await countUntilBlocked(guard, ctxFor(workoutPath, workout, 'coach-a'), 61);
    expect(await countUntilBlocked(guard, ctxFor(mealPath, meal, 'coach-a'), 60)).toEqual({
      accepted: 60,
      status: null,
    });
    expect(await countUntilBlocked(guard, ctxFor(insightPath, insight, 'coach-a'), 60)).toEqual({
      accepted: 60,
      status: null,
    });
  });

  it("another coach's use never counts against this coach's hour", async () => {
    const guard = await makeGuard();
    const [[path, handler]] = ROUTES;
    expect(await countUntilBlocked(guard, ctxFor(path, handler, 'coach-a'), 70)).toEqual({
      accepted: 60,
      status: 429,
    });
    expect(await countUntilBlocked(guard, ctxFor(path, handler, 'coach-b'), 60)).toEqual({
      accepted: 60,
      status: null,
    });
  });
});
