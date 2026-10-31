import type { AuthedRequest } from '../src/auth/auth-request';
import { ExerciseCatalogController } from '../src/exercise-catalog/exercise-catalog.controller';
import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import type { PrismaService } from '../src/prisma.service';
import type { MuxService } from '../src/video/mux.service';

// R75: the repo's typed test double (as in test/gc2-pay-done.spec.ts), in place of inline casts.
function stub<T>(value: unknown): T {
  return value as T;
}

const row = {
  id: 'catalog-bench',
  slug: 'barbell-bench-press',
  source_ref: 'seed:barbell-bench-press',
  name: 'Barbell Bench Press',
  category: 'push',
  primary_muscle: 'chest',
  secondary_muscles: [],
  equipment: ['barbell'],
  difficulty: 'beginner',
  instructions: ['Lower under control.'],
  mux_playback_id: 'fixture-playback',
  mux_playback_policy: 'signed',
  mux_asset_status: 'ready',
};
const playback = 'https://stream.example.invalid/fixture.m3u8';
const request = { user: { id: 'member-one', role: 'student' } } as AuthedRequest;

function controller(assignedRef: string, assignedMember = 'member-one') {
  const prisma = stub<PrismaService>({
    exerciseCatalogItem: {
      findFirst: jest.fn(async ({ where }: {
        where: { OR: Array<Partial<typeof row>> };
      }) => where.OR.some((part) =>
        Object.entries(part).some(([key, value]) => row[key as keyof typeof row] === value),
      ) ? row : null),
    },
    clientWorkoutAssignment: {
      findFirst: jest.fn(async ({ where }: {
        where: {
          client_id: string;
          workout_plan: { exercises: { some: { exercise_external_id: { in: string[] } } } };
        };
      }) => where.client_id === assignedMember &&
        where.workout_plan.exercises.some.exercise_external_id.in.includes(assignedRef)
        ? { id: 'assignment-one' }
        : null),
    },
  });
  const mux = stub<MuxService>({
    mintPlaybackUrl: jest.fn(() => playback),
  });
  return new ExerciseCatalogController(new ExerciseCatalogService(prisma, mux));
}

describe('LS-WORKOUTB exercise identity through the real detail controller', () => {
  it.each([
    ['catalog id', row.id],
    ['slug', row.slug],
    ['external source reference', row.source_ref],
  ])('B-LS-WORKOUT-2 keeps an assigned signed video playable for its %s', async (_kind, assignedRef) => {
    const detail = await controller(assignedRef).detail(row.source_ref, request);
    // Lookup succeeds for the external reference in every case. The matrix
    // varies only the legitimate identifier stored in the client's assignment.
    expect(detail.name).toBe(row.name);
    expect(detail.instructions).toEqual(row.instructions);
    expect(detail.playbackUrl).toBe(playback);
  });

  it.each([row.id, row.slug, row.source_ref])(
    'does not authorize another member through the matching reference %s',
    async (assignedRef) => {
      const detail = await controller(assignedRef, 'member-two').detail(row.source_ref, request);
      expect(detail.name).toBe(row.name);
      expect(detail.playbackUrl).toBeNull();
    },
  );

  it('does not authorize a different exercise assigned to the same member', async () => {
    const detail = await controller('seed:dumbbell-row').detail(row.source_ref, request);
    expect(detail.playbackUrl).toBeNull();
  });
});
