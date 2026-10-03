/**
 * S-MWB-3 (OR-112-18) — autosave / undo edit scope.
 *
 * Before this fix any in-team sub-coach could autosave or undo ANY plan in the
 * tenant (the gate only compared the sub-coach's head coach to plan.coach_id).
 * The gate now mirrors the explicit-Save rule for the tenant owner and the
 * Programs library edit rule for sub-coaches: an in-team sub-coach may edit
 * only a day of a library master they authored. No DB: Prisma and the
 * sub-coach scope are mocked; reaching `$transaction` proves the gate passed.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../src/prisma.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import type { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import {
  PLAN_NOT_EDITABLE_CODE,
  WorkoutBuilderAutosaveService,
} from '../src/workout-builder/workout-builder-autosave.service';

function fake<T>(value: unknown): T {
  return value as T;
}

const HEAD = 'head-coach';
const SUB = 'sub-coach';
const OTHER_SUB = 'other-sub-coach';
const FOREIGN_SUB = 'foreign-sub-coach';
const PLAN = 'plan-1';
const PROGRAM = 'program-1';

const REACHED_TX = new Error('reached the transaction');

interface Fixture {
  plan: { coach_id: string; program_id: string | null } | null;
  program?: { coach_id: string; owner_user_id: string; is_template: boolean } | null;
  headOf?: Record<string, string>;
}

function build(f: Fixture) {
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({ coach_id: where.id === HEAD ? null : HEAD }),
        ),
    },
    workoutPlan: { findUnique: jest.fn().mockResolvedValue(f.plan) },
    workoutProgram: {
      findUnique: jest.fn().mockResolvedValue(f.program ?? null),
    },
    $transaction: jest.fn().mockRejectedValue(REACHED_TX),
  };
  const scope = {
    getHeadCoachIdForSubCoach: jest
      .fn()
      .mockImplementation((id: string) => Promise.resolve(f.headOf?.[id] ?? null)),
  };
  const service = new WorkoutBuilderAutosaveService(
    fake<PrismaService>(prisma),
    fake<WorkoutBuilderService>({}),
    fake<AnalyticsService>({ track: jest.fn() }),
    fake<SubCoachScopeService>(scope),
  );
  return { service, prisma, scope };
}

const autosaveBody = {
  base_revision_index: 0,
  lock_token: '0123456789abcdef',
  ops: [
    {
      op: 'upsert_exercise',
      payload: {
        exercise_external_id: 'squat',
        order: 1,
        sets: 3,
        reps_or_duration_seconds: 10,
      },
    },
  ],
  cause: 'manual_edit',
};
const undoBody = { to_revision_index: 0 };

const team = { [SUB]: HEAD, [OTHER_SUB]: HEAD, [FOREIGN_SUB]: 'other-head' };

const ORIGINAL = {
  flag: process.env.FEATURE_MWB_AUTOSAVE_UNDO,
  secret: process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET,
};

beforeEach(() => {
  process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
  process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET = 'scope-spec-secret-0123456789abcdef';
});

afterAll(() => {
  if (ORIGINAL.flag === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL.flag;
  if (ORIGINAL.secret === undefined) delete process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET;
  else process.env.MWB_AUTOSAVE_LOCK_TOKEN_SECRET = ORIGINAL.secret;
});

async function expectForbidden(p: Promise<unknown>) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ForbiddenException);
  expect(fake<ForbiddenException>(err).getResponse()).toEqual(
    expect.objectContaining({
      code: PLAN_NOT_EDITABLE_CODE,
      message: expect.stringMatching(/Duplicate the program/),
    }),
  );
}

describe('S-MWB-3 OR-112-18: autosave and undo edit scope', () => {
  describe.each([
    [
      'autosave',
      (s: WorkoutBuilderAutosaveService, actor: string) =>
        s.applyAutosave(PLAN, { userId: actor }, autosaveBody),
    ],
    [
      'undo',
      (s: WorkoutBuilderAutosaveService, actor: string) =>
        s.applyUndo(PLAN, { userId: actor }, undoBody),
    ],
  ] as const)('%s', (_name, call) => {
    it('an in-team sub-coach is refused a standalone plan of the head coach (the open gap)', async () => {
      const { service, prisma } = build({
        plan: { coach_id: HEAD, program_id: null },
        headOf: team,
      });
      await expectForbidden(call(service, SUB));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("an in-team sub-coach is refused a day of the head coach's owner-only master", async () => {
      const { service, prisma } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: HEAD, owner_user_id: HEAD, is_template: true },
        headOf: team,
      });
      await expectForbidden(call(service, SUB));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("an in-team sub-coach is refused a day of another sub-coach's master, even when shared with the team", async () => {
      const { service, prisma } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: HEAD, owner_user_id: OTHER_SUB, is_template: true },
        headOf: team,
      });
      await expectForbidden(call(service, SUB));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('an in-team sub-coach is refused a client copy (not a library master)', async () => {
      const { service } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: HEAD, owner_user_id: SUB, is_template: false },
        headOf: team,
      });
      await expectForbidden(call(service, SUB));
    });

    it('a master whose tenant does not match the plan tenant is refused', async () => {
      const { service } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: 'other-head', owner_user_id: SUB, is_template: true },
        headOf: team,
      });
      await expectForbidden(call(service, SUB));
    });

    it('an in-team sub-coach may edit a day of a master they authored', async () => {
      const { service, prisma } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: HEAD, owner_user_id: SUB, is_template: true },
        headOf: team,
      });
      await expect(call(service, SUB)).rejects.toBe(REACHED_TX);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('the tenant owner may edit any plan in the tenant (same rule as explicit Save)', async () => {
      const { service, scope } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: HEAD, owner_user_id: SUB, is_template: true },
        headOf: team,
      });
      await expect(call(service, HEAD)).rejects.toBe(REACHED_TX);
      expect(scope.getHeadCoachIdForSubCoach).not.toHaveBeenCalled();
    });

    it('a sub-coach of another tenant is refused even for a master id they own elsewhere', async () => {
      const { service } = build({
        plan: { coach_id: HEAD, program_id: PROGRAM },
        program: { coach_id: HEAD, owner_user_id: FOREIGN_SUB, is_template: true },
        headOf: team,
      });
      await expectForbidden(call(service, FOREIGN_SUB));
    });

    it('a missing plan is a 404', async () => {
      const { service } = build({ plan: null, headOf: team });
      await expect(call(service, SUB)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
