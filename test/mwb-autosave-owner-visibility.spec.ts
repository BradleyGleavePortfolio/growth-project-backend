/**
 * OR-112-18 (S-MWB-4): the autosave / undo gate applies the Programs library's
 * owner and visibility rules. Before this change any team sub-coach could
 * autosave (or undo) ANY plan whose coach_id is their head coach: the head
 * coach's private masters, team-shared masters they may only read, client
 * copies of clients delegated to someone else, and the head coach's own
 * standalone plans.
 *
 * Seam: the gate runs before the transaction, so an allowed call reaches
 * `$transaction` (stubbed to throw a sentinel) and a refused call is a typed
 * 403 with a stable code that never opens a transaction.
 */
import { ForbiddenException } from '@nestjs/common';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV } from '../src/workout-builder/lock-token.helper';
import {
  CLIENT_NOT_ASSIGNED_MESSAGE,
  PLAN_ACCESS_DENIED_MESSAGE,
  PLAN_NOT_YOURS_MESSAGE,
  PROGRAM_READ_ONLY_MESSAGE,
  WorkoutBuilderAutosaveService,
} from '../src/workout-builder/workout-builder-autosave.service';

function fake<T>(value: unknown): T {
  return value as T;
}

const PLAN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HEAD = 'head-1';
const SUB = 'sub-1';
const OTHER_SUB = 'sub-2';
const FOREIGN_HEAD = 'head-9';
const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';

class ReachedTransaction extends Error {}

type Program = {
  is_template: boolean;
  owner_user_id: string;
  visibility: string;
  client_id: string | null;
};

function build(opts: {
  program: Program | null;
  planCoachId?: string;
  /** Head coach of each acting user (membership-checked); absent = none. */
  heads?: Record<string, string>;
  /** Clients each acting user holds. */
  held?: Record<string, string[]>;
  /** Clients assigned to the days of the copy (older copies, no client_id). */
  assigned?: string[];
}) {
  const plan = {
    coach_id: opts.planCoachId ?? HEAD,
    program_id: opts.program ? 'program-1' : null,
    program: opts.program,
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => ({
        coach_id: opts.heads?.[args.where.id] ?? null,
      })),
    },
    workoutPlan: { findUnique: jest.fn(async () => plan) },
    clientWorkoutAssignment: {
      findMany: jest.fn(async () => (opts.assigned ?? []).map((client_id) => ({ client_id }))),
    },
    $transaction: jest.fn(async () => {
      throw new ReachedTransaction('gate passed');
    }),
  };
  const scope = {
    getHeadCoachIdForSubCoach: jest.fn(async (id: string) => opts.heads?.[id] ?? null),
    getAuthorizedClientIds: jest.fn(async (id: string) => opts.held?.[id] ?? []),
  };
  const service = new WorkoutBuilderAutosaveService(
    fake(prisma),
    fake(undefined),
    new AnalyticsService(),
    fake(scope),
  );
  return { service, prisma, scope };
}

const BODY = {
  base_revision_index: 0,
  lock_token: '0123456789abcdef',
  ops: [
    {
      op: 'upsert_exercise' as const,
      payload: { exercise_external_id: 'squat', order: 1, sets: 3, reps_or_duration_seconds: 10 },
    },
  ],
  cause: 'manual_edit' as const,
};

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    if (e instanceof ReachedTransaction) return 'allowed';
    if (e instanceof ForbiddenException) {
      const body = e.getResponse() as { code?: string; message?: string };
      return `403 ${body.code}: ${body.message}`;
    }
    throw e;
  }
}

const TEAM = { [SUB]: HEAD, [OTHER_SUB]: HEAD };

describe('autosave owner + visibility gate (OR-112-18)', () => {
  const ORIGINAL_SECRET = process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  beforeEach(() => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = 'mwb-owner-secret-aaaaaaaaaaaaaaaaaaaaaa';
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    else process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = ORIGINAL_SECRET;
    if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL_FLAG;
  });

  const master = (owner: string, visibility = 'owner_only'): Program => ({
    is_template: true,
    owner_user_id: owner,
    visibility,
    client_id: null,
  });
  const copy = (clientId: string | null): Program => ({
    is_template: false,
    owner_user_id: HEAD,
    visibility: 'owner_only',
    client_id: clientId,
  });

  describe('library master days', () => {
    it('a team sub-coach saves a day of a program they made', async () => {
      const { service } = build({ program: master(SUB), heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe('allowed');
    });

    it('the head coach saves a day of their own program', async () => {
      const { service, scope } = build({ program: master(HEAD) });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: HEAD }, BODY))).toBe('allowed');
      expect(scope.getHeadCoachIdForSubCoach).not.toHaveBeenCalled();
    });

    it('a team-shared program of the head coach is read only for a sub-coach', async () => {
      const { service, prisma } = build({ program: master(HEAD, 'tenant_shared'), heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 program_read_only: ${PROGRAM_READ_ONLY_MESSAGE}`,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("the head coach's private program is closed to a sub-coach", async () => {
      const { service } = build({ program: master(HEAD), heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 plan_access_denied: ${PLAN_ACCESS_DENIED_MESSAGE}`,
      );
    });

    it("another sub-coach's program is read only for the head coach (library parity)", async () => {
      const { service } = build({ program: master(OTHER_SUB, 'tenant_shared'), heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: HEAD }, BODY))).toBe(
        `403 program_read_only: ${PROGRAM_READ_ONLY_MESSAGE}`,
      );
    });

    it("another sub-coach's private program is closed to a team sub-coach", async () => {
      const { service } = build({ program: master(OTHER_SUB), heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 plan_access_denied: ${PLAN_ACCESS_DENIED_MESSAGE}`,
      );
    });

    it('a coach who left the team can no longer save the program they made there', async () => {
      const { service } = build({ program: master(SUB) });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 plan_access_denied: ${PLAN_ACCESS_DENIED_MESSAGE}`,
      );
    });
  });

  describe('client copies', () => {
    it('the head coach saves any client copy in the tenant', async () => {
      const { service } = build({ program: copy(CLIENT_A) });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: HEAD }, BODY))).toBe('allowed');
    });

    it('a sub-coach saves the copy of a client they hold', async () => {
      const { service } = build({
        program: copy(CLIENT_A),
        heads: TEAM,
        held: { [SUB]: [CLIENT_A] },
      });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe('allowed');
    });

    it('a sub-coach cannot save the copy of a client delegated to someone else', async () => {
      const { service, prisma } = build({
        program: copy(CLIENT_B),
        heads: TEAM,
        held: { [SUB]: [CLIENT_A], [OTHER_SUB]: [CLIENT_B] },
      });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 client_not_assigned: ${CLIENT_NOT_ASSIGNED_MESSAGE}`,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('an older copy (no client_id) is resolved through its assignments', async () => {
      const held = build({
        program: copy(null),
        heads: TEAM,
        held: { [SUB]: [CLIENT_A] },
        assigned: [CLIENT_A],
      });
      expect(await outcome(held.service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        'allowed',
      );
      const mixed = build({
        program: copy(null),
        heads: TEAM,
        held: { [SUB]: [CLIENT_A] },
        assigned: [CLIENT_A, CLIENT_B],
      });
      expect(await outcome(mixed.service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 client_not_assigned: ${CLIENT_NOT_ASSIGNED_MESSAGE}`,
      );
      const orphan = build({ program: copy(null), heads: TEAM, held: { [SUB]: [CLIENT_A] } });
      expect(await outcome(orphan.service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 client_not_assigned: ${CLIENT_NOT_ASSIGNED_MESSAGE}`,
      );
    });
  });

  describe('standalone plans', () => {
    it('a coach saves their own standalone plan', async () => {
      const { service } = build({ program: null, planCoachId: SUB, heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe('allowed');
    });

    it("a team sub-coach cannot save the head coach's standalone plan", async () => {
      const { service } = build({ program: null, heads: TEAM });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: SUB }, BODY))).toBe(
        `403 plan_not_yours: ${PLAN_NOT_YOURS_MESSAGE}`,
      );
    });

    it('a foreign head coach is refused with plan_access_denied', async () => {
      const { service } = build({ program: null });
      expect(await outcome(service.applyAutosave(PLAN_ID, { userId: FOREIGN_HEAD }, BODY))).toBe(
        `403 plan_access_denied: ${PLAN_ACCESS_DENIED_MESSAGE}`,
      );
    });
  });

  it('undo goes through the same gate', async () => {
    const shared = build({ program: master(HEAD, 'tenant_shared'), heads: TEAM });
    expect(
      await outcome(shared.service.applyUndo(PLAN_ID, { userId: SUB }, { to_revision_index: 0 })),
    ).toBe(`403 program_read_only: ${PROGRAM_READ_ONLY_MESSAGE}`);
    const own = build({ program: master(SUB), heads: TEAM });
    expect(
      await outcome(own.service.applyUndo(PLAN_ID, { userId: SUB }, { to_revision_index: 0 })),
    ).toBe('allowed');
  });
});
