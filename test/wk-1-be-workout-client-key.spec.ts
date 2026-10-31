/**
 * WK-1-BE (agent 188; LO-WORKOUT B1): POST /workouts with a lost answer.
 * The phone times out (30 s), keeps the workout in its queue and the
 * background sync sends it again with the same queue key. One key = one
 * stored workout; a different key or no key = a new one, as at main.
 *
 * The fake store enforces the schema's @@unique([user_id, client_key])
 * (NULLs never collide). The coach's reads (coach.service.ts client detail
 * and timeline) list a client's workouts by user_id, so the rows a coach
 * reads are the rows returned by findMany({ where: { user_id } }).
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { PtmService } from '../src/ptm/ptm.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WorkoutController } from '../src/workout/workout.controller';
import { WorkoutService } from '../src/workout/workout.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import type { CreateWorkoutDto } from '../src/workout/workout.dto';

type Row = Record<string, unknown> & { id: string; user_id: string; client_key?: string | null };

function fakeStore() {
  const rows: Row[] = [];
  let n = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const workoutSession = {
    findUnique: jest.fn(async ({ where }: { where: { user_id_client_key: { user_id: string; client_key: string } } }) => {
      await tick();
      const k = where.user_id_client_key;
      return rows.find((r) => r.user_id === k.user_id && r.client_key === k.client_key) ?? null;
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> & { user_id: string; client_key?: string } }) => {
      await tick();
      if (data.client_key != null && rows.some((r) => r.user_id === data.user_id && r.client_key === data.client_key)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`user_id`,`client_key`)', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const { exercises, ...rest } = data as { exercises?: { create: Record<string, unknown>[] } };
      n += 1;
      const row: Row = {
        id: `workout-${n}`,
        ...(rest as { user_id: string }),
        client_key: data.client_key ?? null,
        created_at: new Date(1_800_000_000_000 + n),
        exercises: (exercises?.create ?? []).map((e, i) => ({ id: `set-${n}-${i}`, workout_id: `workout-${n}`, ...e })),
      };
      rows.push(row);
      return row;
    }),
    findMany: jest.fn(async ({ where }: { where: { user_id: string } }) => rows.filter((r) => r.user_id === where.user_id)),
  };
  return { rows, prisma: { workoutSession } };
}

function setup() {
  const store = fakeStore();
  const emit = jest.fn();
  const invalidateForUser = jest.fn();
  // The real controller and service; the route's guards are covered by the
  // entitlement / guard-chain suites, so they are left out of this unit.
  const controller = new WorkoutController(
    new WorkoutService(
      store.prisma as unknown as PrismaService,
      { emit } as unknown as PtmService,
      { invalidateForUser } as unknown as ClientAIContextService,
    ),
  );
  // POST /workouts as the route sees it: (req, body, Idempotency-Key header).
  const post = (userId: string, body: CreateWorkoutDto, key?: string) =>
    (controller.createWorkout as (...a: unknown[]) => Promise<Row>).call(
      controller,
      { user: { id: userId, role: 'student' } } as AuthedRequest,
      body,
      key,
    );
  const coachReads = (clientId: string) => store.prisma.workoutSession.findMany({ where: { user_id: clientId } });
  return { store, emit, invalidateForUser, post, coachReads };
}

const body: CreateWorkoutDto = {
  date: '2026-10-30',
  workout_name: 'Push day',
  workout_type: 'strength',
  duration_minutes: 45,
  exercises: [
    { exercise_name: 'Bench press', muscle_group: 'chest', sets_completed: 3, reps_per_set: [8, 8, 8], weight_per_set: [135, 135, 135] },
  ],
} as CreateWorkoutDto;
const queueKey = 'client-1:1793402400000';

describe('WK-1-BE POST /workouts with an Idempotency-Key', () => {
  it('B-WK-1: the route passes the Idempotency-Key header as the third argument', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, WorkoutController, 'createWorkout') as Record<
      string,
      { index: number; data?: unknown }
    >;
    expect(Object.values(args ?? {})).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 2, data: 'idempotency-key' })]),
    );
  });

  it('B-WK-1: the same key sent again after a dropped answer stores one workout and the coach reads one', async () => {
    const { post, coachReads, store, emit, invalidateForUser } = setup();
    const first = await post('client-1', body, queueKey);
    // The answer to `first` never reached the phone; the sync retry resends.
    const again = await post('client-1', body, queueKey);
    expect(store.rows).toHaveLength(1);
    expect(await coachReads('client-1')).toHaveLength(1);
    // Same stored workout, same shape (exercises included).
    expect(again).toEqual(first);
    expect(again.id).toBe(first.id);
    expect((again.exercises as unknown[]).length).toBe(1);
    // The repeat is not a second logged workout for signals or the AI cache.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(invalidateForUser).toHaveBeenCalledTimes(1);
  });

  it('B-WK-1: two sends of one key racing past the lookup still store one workout', async () => {
    const { post, coachReads } = setup();
    const [a, b] = await Promise.all([post('client-1', body, queueKey), post('client-1', body, queueKey)]);
    expect(await coachReads('client-1')).toHaveLength(1);
    expect(b.id).toBe(a.id);
  });

  it('a different key stores a second workout', async () => {
    const { post, coachReads } = setup();
    await post('client-1', body, queueKey);
    await post('client-1', body, 'client-1:1793406000000');
    expect(await coachReads('client-1')).toHaveLength(2);
  });

  it('no key behaves exactly as before: every save stores a workout and no key is written', async () => {
    const { post, coachReads, store, emit } = setup();
    await post('client-1', body);
    await post('client-1', body, '   ');
    expect(await coachReads('client-1')).toHaveLength(2);
    expect(store.prisma.workoutSession.findUnique).not.toHaveBeenCalled();
    for (const [args] of store.prisma.workoutSession.create.mock.calls) {
      expect(Object.prototype.hasOwnProperty.call(args.data, 'client_key')).toBe(false);
    }
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('another member sending the same key gets their own workout, never the first member\'s', async () => {
    const { post, coachReads } = setup();
    const mine = await post('client-1', body, queueKey);
    const theirs = await post('client-2', body, queueKey);
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.user_id).toBe('client-2');
    expect(await coachReads('client-1')).toHaveLength(1);
    expect(await coachReads('client-2')).toHaveLength(1);
  });

  it.each(['short', 'x'.repeat(129), 'has space here', 'emoji-\u{1F600}-key'])(
    'refuses a malformed key %p with 400 IDEMPOTENCY_KEY_INVALID and stores nothing',
    async (bad) => {
      const { post, store } = setup();
      await expect(post('client-1', body, bad)).rejects.toBeInstanceOf(BadRequestException);
      await expect(post('client-1', body, bad)).rejects.toMatchObject({
        response: { error: 'IDEMPOTENCY_KEY_INVALID' },
      });
      expect(store.rows).toHaveLength(0);
    },
  );
});
