/**
 * Stream 2 — AI Execution Capabilities behavioural tests.
 *
 * Covers all four spec §4 deliverables for the three new materialisers
 * plus the gateway role-gate (spec §3 layer 2). Each `describe` block
 * carries the spec section so an auditor can grep.
 *
 * Per the spec §4.6 acceptance bar, each materialiser MUST have:
 *   - Happy path (row created, ai_draft_id set)
 *   - Idempotency (second call returns already_materialised, no dup row)
 *   - Race path (P2002 thrown → re-query returns existing)
 *   - Client-role creator → ForbiddenException, no row
 *   - Payload schema invalid → ZodError, no row
 *
 * And the gateway role-gate (layer 2) MUST refuse any `draft.*` from a
 * non-coach/non-owner role.
 */

import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  AssignWorkoutMaterializer,
  ASSIGN_WORKOUT_CAPABILITY,
  AssignWorkoutPayloadSchema,
  assertAssignWorkoutPayload,
} from '../src/ai/gateway/materialisers/assign-workout.materialiser';
import {
  AssignMealPlanMaterializer,
  ASSIGN_MEAL_PLAN_CAPABILITY,
  AssignMealPlanPayloadSchema,
  assertAssignMealPlanPayload,
} from '../src/ai/gateway/materialisers/assign-meal-plan.materialiser';
import {
  SendNotificationMaterializer,
  SEND_NOTIFICATION_CAPABILITY,
  SendNotificationPayloadSchema,
  assertSendNotificationPayload,
} from '../src/ai/gateway/materialisers/send-notification.materialiser';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';

// ---------------------------------------------------------------------------
// Mini Prisma mock. Shared across the three materialiser sub-tests so we
// only have to teach one harness about the user-role lookup +
// workout-plan/meal-plan tenant checks + P2002 emulation.
// ---------------------------------------------------------------------------

// D8 (PR #593): users carry the roster/sub-coach fields SubCoachScopeService
// reads (coach_id, deleted_at) and the store carries SubCoachAssignment rows,
// so the REAL SubCoachScopeService can evaluate the coach-client tenancy rule
// over this mock exactly as it does over Prisma.
interface MiniUser {
  id: string;
  role: string;
  coach_id?: string | null;
  deleted_at?: Date | null;
}
interface MiniStore {
  users: Map<string, MiniUser>;
  subCoachAssignments: Array<{ sub_coach_id: string; client_id: string; unassigned_at: Date | null }>;
  workoutPlans: Map<string, { id: string; coach_id: string }>;
  dailyMealPlans: Map<string, { id: string; coach_id: string }>;
  workoutAssignments: any[];
  mealPlanAssignments: any[];
  notifications: any[];
}

function newStore(): MiniStore {
  return {
    users: new Map(),
    subCoachAssignments: [],
    workoutPlans: new Map(),
    dailyMealPlans: new Map(),
    workoutAssignments: [],
    mealPlanAssignments: [],
    notifications: [],
  };
}

function matchUser(u: MiniUser, where: any): boolean {
  if (where.id && typeof where.id === 'object' && Array.isArray(where.id.in)) {
    if (!where.id.in.includes(u.id)) return false;
  } else if (typeof where.id === 'string' && u.id !== where.id) return false;
  if ('coach_id' in where && (u.coach_id ?? null) !== where.coach_id) return false;
  if ('role' in where && u.role !== where.role) return false;
  if ('deleted_at' in where && (u.deleted_at ?? null) !== where.deleted_at) return false;
  return true;
}

interface MockOpts {
  /** When true, the next workoutAssignment / mealPlanAssignment / notification
   *  create() throws a synthetic P2002 — used to exercise the race path. */
  failNextCreateWithP2002?: boolean;
}

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${target.join('`, `')}\`)`,
    { code: 'P2002', clientVersion: '6.0.0', meta: { target } },
  );
}

function makePrismaMock(store: MiniStore, opts: MockOpts = {}): any {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const u = store.users.get(where.id);
        return u ? { coach_id: null, deleted_at: null, ...u } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        [...store.users.values()]
          .filter((u) => matchUser(u, where ?? {}))
          .map((u) => ({ coach_id: null, deleted_at: null, ...u })),
      ),
    },
    subCoachAssignment: {
      findMany: jest.fn(async ({ where }: any) =>
        store.subCoachAssignments.filter(
          (a) =>
            (!where?.sub_coach_id || a.sub_coach_id === where.sub_coach_id) &&
            (!('unassigned_at' in (where ?? {})) || a.unassigned_at === where.unassigned_at),
        ),
      ),
    },
    workoutPlan: {
      findUnique: jest.fn(async ({ where }: any) => {
        const plan = store.workoutPlans.get(where.id);
        if (!plan) return null;
        // MWB-1 (§3.3): the materialiser now selects plan metadata + live
        // exercises so it can freeze a snapshot. Provide defaults for the
        // fields the store doesn't model so the snapshot write succeeds.
        return {
          name: 'AI Plan',
          type: 'strength',
          version: 1,
          exercises: [],
          ...plan,
        };
      }),
    },
    clientWorkoutAssignmentSnapshot: {
      create: jest.fn(async ({ data }: any) => ({ id: 'snap_1', ...data })),
      findUnique: jest.fn(async () => null),
    },
    dailyMealPlan: {
      findUnique: jest.fn(async ({ where }: any) =>
        store.dailyMealPlans.get(where.id) ?? null,
      ),
    },
    clientWorkoutAssignment: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.failNextCreateWithP2002) {
          opts.failNextCreateWithP2002 = false;
          throw p2002(['ai_draft_id']);
        }
        // Enforce schema-level @unique on ai_draft_id locally.
        if (
          data.ai_draft_id &&
          store.workoutAssignments.some((a) => a.ai_draft_id === data.ai_draft_id)
        ) {
          throw p2002(['ai_draft_id']);
        }
        const row = { id: `cwa_${store.workoutAssignments.length + 1}`, ...data };
        store.workoutAssignments.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          store.workoutAssignments.find(
            (a) => a.ai_draft_id === where.ai_draft_id,
          ) ?? null
        );
      }),
    },
    dailyMealPlanAssignment: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.failNextCreateWithP2002) {
          opts.failNextCreateWithP2002 = false;
          throw p2002(['ai_draft_id']);
        }
        if (
          data.ai_draft_id &&
          store.mealPlanAssignments.some((a) => a.ai_draft_id === data.ai_draft_id)
        ) {
          throw p2002(['ai_draft_id']);
        }
        const row = { id: `dmpa_${store.mealPlanAssignments.length + 1}`, ...data };
        store.mealPlanAssignments.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          store.mealPlanAssignments.find(
            (a) => a.ai_draft_id === where.ai_draft_id,
          ) ?? null
        );
      }),
    },
    notification: {
      create: jest.fn(async ({ data }: any) => {
        if (opts.failNextCreateWithP2002) {
          opts.failNextCreateWithP2002 = false;
          throw p2002(['ai_draft_id']);
        }
        if (
          data.ai_draft_id &&
          store.notifications.some((n) => n.ai_draft_id === data.ai_draft_id)
        ) {
          throw p2002(['ai_draft_id']);
        }
        const row = { id: `notif_${store.notifications.length + 1}`, ...data };
        store.notifications.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          store.notifications.find((n) => n.ai_draft_id === where.ai_draft_id) ??
          null
        );
      }),
    },
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  return prisma;
}

function mockNotifications() {
  return {
    createNotification: jest.fn(async () => ({ id: 'notif_pushed_x' })),
  } as any;
}

/** The real tenancy rule over the mock store (D8). */
function scopeOver(prisma: any): SubCoachScopeService {
  return new SubCoachScopeService(prisma);
}

// Common draft factory.
const COACH_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const WORKOUT_PLAN_ID = '33333333-3333-3333-3333-333333333333';
const MEAL_PLAN_ID = '44444444-4444-4444-4444-444444444444';

function draftBase(overrides: Partial<any> = {}): any {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    capability: 'draft.assign_workout',
    status: 'pending',
    requester_id: COACH_ID,
    subject_user_id: CLIENT_ID,
    tenant_coach_id: COACH_ID,
    payload: {},
    materialised_at: null,
    materialised_ref: null,
    decided_by_id: null,
    ...overrides,
  };
}

// ===========================================================================
// Spec §4.2 — AssignWorkoutMaterializer
// ===========================================================================

describe('Stream 2 §4.2 — AssignWorkoutMaterializer', () => {
  describe('payload schema', () => {
    it('accepts the canonical payload', () => {
      const r = AssignWorkoutPayloadSchema.safeParse({
        workoutPlanId: WORKOUT_PLAN_ID,
        clientId: CLIENT_ID,
        scheduledFor: '2026-06-01T09:00:00Z',
      });
      expect(r.success).toBe(true);
    });
    it('rejects non-UUID workoutPlanId', () => {
      const r = AssignWorkoutPayloadSchema.safeParse({
        workoutPlanId: 'not-a-uuid',
        clientId: CLIENT_ID,
        scheduledFor: '2026-06-01T09:00:00Z',
      });
      expect(r.success).toBe(false);
    });
    it('rejects malformed scheduledFor', () => {
      const r = AssignWorkoutPayloadSchema.safeParse({
        workoutPlanId: WORKOUT_PLAN_ID,
        clientId: CLIENT_ID,
        scheduledFor: 'not-a-date',
      });
      expect(r.success).toBe(false);
    });
    it('rejects extra properties (strict mode)', () => {
      const r = AssignWorkoutPayloadSchema.safeParse({
        workoutPlanId: WORKOUT_PLAN_ID,
        clientId: CLIENT_ID,
        scheduledFor: '2026-06-01T09:00:00Z',
        smuggled: 'value',
      });
      expect(r.success).toBe(false);
    });
    it('assertAssignWorkoutPayload throws on malformed input', () => {
      expect(() => assertAssignWorkoutPayload({ junk: true })).toThrow();
    });
  });

  describe('canHandle', () => {
    it('claims only its capability string', () => {
      const m = new AssignWorkoutMaterializer({} as any, {} as any, {} as any);
      expect(m.canHandle('draft.assign_workout')).toBe(true);
      expect(m.canHandle('draft.assign_meal_plan')).toBe(false);
      expect(m.canHandle('')).toBe(false);
    });
  });

  function seedStore(): MiniStore {
    const store = newStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'coach', coach_id: null });
    // D8: the subject is on the coach's roster (User.coach_id = coach).
    store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: COACH_ID });
    store.workoutPlans.set(WORKOUT_PLAN_ID, { id: WORKOUT_PLAN_ID, coach_id: COACH_ID });
    return store;
  }

  function happyDraft(): any {
    return draftBase({
      capability: 'draft.assign_workout',
      payload: {
        workoutPlanId: WORKOUT_PLAN_ID,
        clientId: CLIENT_ID,
        scheduledFor: '2026-06-01T09:00:00Z',
      },
    });
  }

  it('happy path → creates ClientWorkoutAssignment with ai_draft_id, fires push', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const notifications = mockNotifications();
    const m = new AssignWorkoutMaterializer(prisma, notifications, scopeOver(prisma));

    const result = await m.materialize(happyDraft());
    expect(result.status).toBe('sent');
    expect(result.ref).toBeTruthy();
    expect(store.workoutAssignments).toHaveLength(1);
    const row = store.workoutAssignments[0];
    expect(row.ai_draft_id).toBe('55555555-5555-5555-5555-555555555555');
    expect(row.client_id).toBe(CLIENT_ID);
    expect(row.workout_plan_id).toBe(WORKOUT_PLAN_ID);
    expect(row.assigned_by_coach_id).toBe(COACH_ID);
    // Push dispatched (fire-and-forget; the mock resolves immediately).
    // We can't await the void in our mat, but if the call lands the
    // mock's .mock.calls captures it.
    await new Promise((r) => setImmediate(r));
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    const pushArgs = notifications.createNotification.mock.calls[0][0];
    expect(pushArgs.user_id).toBe(CLIENT_ID);
    expect(pushArgs.kind).toBe('workout_assigned');
  });

  it('idempotency → second call with same draft id returns already_materialised, no duplicate row', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const notifications = mockNotifications();
    const m = new AssignWorkoutMaterializer(prisma, notifications, scopeOver(prisma));

    const first = await m.materialize(happyDraft());
    expect(first.status).toBe('sent');
    const firstRef = first.ref;
    expect(store.workoutAssignments).toHaveLength(1);

    const second = await m.materialize(happyDraft());
    expect(second.status).toBe('already_materialised');
    expect(second.ref).toBe(firstRef);
    expect(store.workoutAssignments).toHaveLength(1);
  });

  it('race path → P2002 on create() → re-query → already_materialised', async () => {
    const store = seedStore();
    // Pre-seed the row so the re-query path finds it after the synthetic
    // P2002 fires. This emulates: caller A's create commits, caller B's
    // create fires after and trips the UNIQUE constraint.
    store.workoutAssignments.push({
      id: 'cwa_pre_existing',
      ai_draft_id: '55555555-5555-5555-5555-555555555555',
      client_id: CLIENT_ID,
      workout_plan_id: WORKOUT_PLAN_ID,
    });
    const prisma = makePrismaMock(store, { failNextCreateWithP2002: true });
    const notifications = mockNotifications();
    const m = new AssignWorkoutMaterializer(prisma, notifications, scopeOver(prisma));

    const result = await m.materialize(happyDraft());
    expect(result.status).toBe('already_materialised');
    expect(result.ref).toBe('cwa_pre_existing');
    // create() was attempted once and trapped; no duplicate row created.
    expect(store.workoutAssignments).toHaveLength(1);
  });

  it('layer-3 role rejection → ForbiddenException when draft.requester_id is a client', async () => {
    const store = seedStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'client' });
    const prisma = makePrismaMock(store);
    const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));

    await expect(m.materialize(happyDraft())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(store.workoutAssignments).toHaveLength(0);
  });

  it('payload schema rejection at materialise time surfaces ZodError', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
    const bad = draftBase({
      capability: 'draft.assign_workout',
      payload: { workoutPlanId: 'not-a-uuid', clientId: CLIENT_ID, scheduledFor: '2026-06-01T00:00:00Z' },
    });
    await expect(m.materialize(bad)).rejects.toThrow();
    expect(store.workoutAssignments).toHaveLength(0);
  });

  it('plan-tenant cross-check → refuses to assign a plan from another coach', async () => {
    const store = seedStore();
    // Plan belongs to a different coach than draft.tenant_coach_id.
    store.workoutPlans.set(WORKOUT_PLAN_ID, { id: WORKOUT_PLAN_ID, coach_id: 'other-coach' });
    const prisma = makePrismaMock(store);
    const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
    await expect(m.materialize(happyDraft())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(store.workoutAssignments).toHaveLength(0);
  });

  // ── D8 (PR #593, R593-c7A-01 / R593-c7B-01): coach-client tenancy at approval time ──
  // These fail on the pre-fix materialiser (it wrote payload.clientId with no
  // client-scope check) and pass now. The rule is SubCoachScopeService.canActOnClient
  // == WorkoutBuilderService.assertCanAccessClient, evaluated with the REAL service.
  describe('D8 — coach-client tenancy is enforced on the service-role write path', () => {
    const OTHER_COACH = '66666666-6666-6666-6666-666666666666';
    const SUB_COACH = '77777777-7777-7777-7777-777777777777';

    it("cross-tenant: the payload client belongs to ANOTHER coach → 403 AI_DRAFT_CLIENT_SCOPE_FORBIDDEN, no row, no push", async () => {
      const store = seedStore();
      store.users.set(OTHER_COACH, { id: OTHER_COACH, role: 'coach', coach_id: null });
      store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: OTHER_COACH });
      const prisma = makePrismaMock(store);
      const notifications = mockNotifications();
      const m = new AssignWorkoutMaterializer(prisma, notifications, scopeOver(prisma));
      const err = await m.materialize(happyDraft()).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
      });
      expect(store.workoutAssignments).toHaveLength(0);
      expect(prisma.clientWorkoutAssignment.create).not.toHaveBeenCalled();
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it('unknown client id → refused (no row)', async () => {
      const store = seedStore();
      store.users.delete(CLIENT_ID);
      const prisma = makePrismaMock(store);
      const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
      await expect(m.materialize(happyDraft())).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.workoutAssignments).toHaveLength(0);
    });

    it('subject binding: payload.clientId differs from draft.subject_user_id → 403 AI_DRAFT_CLIENT_SUBJECT_MISMATCH before any read/write', async () => {
      const store = seedStore();
      const prisma = makePrismaMock(store);
      const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
      // Authorised for S (the subject) but proposing the coach's own roster client.
      const draft = happyDraft();
      draft.subject_user_id = '88888888-8888-8888-8888-888888888888';
      const err = await m.materialize(draft).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SUBJECT_MISMATCH',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(store.workoutAssignments).toHaveLength(0);
    });

    it('sub-coach with an OPEN delegation to the student → allowed; row is assigned_by the sub-coach (tenant)', async () => {
      const store = newStore();
      store.users.set(COACH_ID, { id: COACH_ID, role: 'coach', coach_id: null });
      store.users.set(SUB_COACH, { id: SUB_COACH, role: 'coach', coach_id: COACH_ID });
      store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: COACH_ID });
      store.subCoachAssignments.push({ sub_coach_id: SUB_COACH, client_id: CLIENT_ID, unassigned_at: null });
      store.workoutPlans.set(WORKOUT_PLAN_ID, { id: WORKOUT_PLAN_ID, coach_id: SUB_COACH });
      const prisma = makePrismaMock(store);
      const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
      const draft = happyDraft();
      draft.requester_id = SUB_COACH;
      draft.tenant_coach_id = SUB_COACH;
      const r = await m.materialize(draft);
      expect(r.status).toBe('sent');
      expect(store.workoutAssignments).toHaveLength(1);
      expect(store.workoutAssignments[0].assigned_by_coach_id).toBe(SUB_COACH);
    });

    it('delegation CLOSED between draft and approval → refused at approval time (revocation is live)', async () => {
      const store = newStore();
      store.users.set(COACH_ID, { id: COACH_ID, role: 'coach', coach_id: null });
      store.users.set(SUB_COACH, { id: SUB_COACH, role: 'coach', coach_id: COACH_ID });
      store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: COACH_ID });
      store.subCoachAssignments.push({ sub_coach_id: SUB_COACH, client_id: CLIENT_ID, unassigned_at: new Date() });
      store.workoutPlans.set(WORKOUT_PLAN_ID, { id: WORKOUT_PLAN_ID, coach_id: SUB_COACH });
      const prisma = makePrismaMock(store);
      const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
      const draft = happyDraft();
      draft.requester_id = SUB_COACH;
      draft.tenant_coach_id = SUB_COACH;
      const err = await m.materialize(draft).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
      });
      expect(store.workoutAssignments).toHaveLength(0);
    });

    it('the tenancy check reads through the write transaction client (tx), not a separate connection', async () => {
      const store = seedStore();
      const prisma = makePrismaMock(store);
      // A distinct tx client: if the materialiser passed `tx`, the reads land here.
      const tx: any = { ...prisma, user: { ...prisma.user, findUnique: jest.fn(prisma.user.findUnique) } };
      prisma.$transaction = jest.fn(async (cb: any) => cb(tx));
      const m = new AssignWorkoutMaterializer(prisma, mockNotifications(), scopeOver(prisma));
      const r = await m.materialize(happyDraft());
      expect(r.status).toBe('sent');
      expect(tx.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CLIENT_ID } }),
      );
    });
  });
});

// ===========================================================================
// Spec §4.2 — AssignMealPlanMaterializer
// ===========================================================================

describe('Stream 2 §4.2 — AssignMealPlanMaterializer', () => {
  describe('payload schema', () => {
    it('accepts canonical { dailyMealPlanId, clientId, startsOn } shape', () => {
      const r = AssignMealPlanPayloadSchema.safeParse({
        dailyMealPlanId: MEAL_PLAN_ID,
        clientId: CLIENT_ID,
        startsOn: '2026-06-01',
      });
      expect(r.success).toBe(true);
    });
    it('rejects endsOn earlier than startsOn', () => {
      const r = AssignMealPlanPayloadSchema.safeParse({
        dailyMealPlanId: MEAL_PLAN_ID,
        clientId: CLIENT_ID,
        startsOn: '2026-06-10',
        endsOn: '2026-06-01',
      });
      expect(r.success).toBe(false);
    });
    it('rejects malformed startsOn', () => {
      const r = AssignMealPlanPayloadSchema.safeParse({
        dailyMealPlanId: MEAL_PLAN_ID,
        clientId: CLIENT_ID,
        startsOn: '2026/06/01',
      });
      expect(r.success).toBe(false);
    });
    it('assertAssignMealPlanPayload throws on malformed input', () => {
      expect(() => assertAssignMealPlanPayload({ junk: true })).toThrow();
    });
  });

  function seedStore(): MiniStore {
    const store = newStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'coach', coach_id: null });
    // D8: the subject is on the coach's roster (User.coach_id = coach).
    store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: COACH_ID });
    store.dailyMealPlans.set(MEAL_PLAN_ID, { id: MEAL_PLAN_ID, coach_id: COACH_ID });
    return store;
  }

  function happyDraft(): any {
    return draftBase({
      capability: 'draft.assign_meal_plan',
      payload: {
        dailyMealPlanId: MEAL_PLAN_ID,
        clientId: CLIENT_ID,
        startsOn: '2026-06-01',
        endsOn: '2026-06-30',
      },
    });
  }

  it('happy path → creates DailyMealPlanAssignment with ai_draft_id', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const notifications = mockNotifications();
    const m = new AssignMealPlanMaterializer(prisma, notifications, scopeOver(prisma));
    const r = await m.materialize(happyDraft());
    expect(r.status).toBe('sent');
    expect(store.mealPlanAssignments).toHaveLength(1);
    const row = store.mealPlanAssignments[0];
    expect(row.ai_draft_id).toBe('55555555-5555-5555-5555-555555555555');
    expect(row.client_id).toBe(CLIENT_ID);
    await new Promise((res) => setImmediate(res));
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification.mock.calls[0][0].kind).toBe('meal_plan_assigned');
  });

  it('idempotency → second call returns already_materialised', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const m = new AssignMealPlanMaterializer(prisma, mockNotifications(), scopeOver(prisma));
    await m.materialize(happyDraft());
    const r2 = await m.materialize(happyDraft());
    expect(r2.status).toBe('already_materialised');
    expect(store.mealPlanAssignments).toHaveLength(1);
  });

  it('race path → P2002 → re-query → already_materialised', async () => {
    const store = seedStore();
    store.mealPlanAssignments.push({
      id: 'dmpa_pre_existing',
      ai_draft_id: '55555555-5555-5555-5555-555555555555',
      client_id: CLIENT_ID,
      daily_meal_plan_id: MEAL_PLAN_ID,
    });
    const prisma = makePrismaMock(store, { failNextCreateWithP2002: true });
    const m = new AssignMealPlanMaterializer(prisma, mockNotifications(), scopeOver(prisma));
    const r = await m.materialize(happyDraft());
    expect(r.status).toBe('already_materialised');
    expect(r.ref).toBe('dmpa_pre_existing');
  });

  it('layer-3 role rejection → client requester is refused', async () => {
    const store = seedStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'client' });
    const prisma = makePrismaMock(store);
    const m = new AssignMealPlanMaterializer(prisma, mockNotifications(), scopeOver(prisma));
    await expect(m.materialize(happyDraft())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(store.mealPlanAssignments).toHaveLength(0);
  });

  it('plan-tenant cross-check → refuses to assign a plan from another coach', async () => {
    const store = seedStore();
    store.dailyMealPlans.set(MEAL_PLAN_ID, { id: MEAL_PLAN_ID, coach_id: 'other-coach' });
    const prisma = makePrismaMock(store);
    const m = new AssignMealPlanMaterializer(prisma, mockNotifications(), scopeOver(prisma));
    await expect(m.materialize(happyDraft())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(store.mealPlanAssignments).toHaveLength(0);
  });

  // ── D8 (PR #593): the same tenancy rule on the meal-plan assignment writer ──
  describe('D8 — coach-client tenancy is enforced on the service-role write path', () => {
    const OTHER_COACH = '66666666-6666-6666-6666-666666666666';

    it("cross-tenant: the payload client belongs to ANOTHER coach → 403, no DailyMealPlanAssignment row", async () => {
      const store = seedStore();
      store.users.set(OTHER_COACH, { id: OTHER_COACH, role: 'coach', coach_id: null });
      store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: OTHER_COACH });
      const prisma = makePrismaMock(store);
      const notifications = mockNotifications();
      const m = new AssignMealPlanMaterializer(prisma, notifications, scopeOver(prisma));
      const err = await m.materialize(happyDraft()).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
      });
      expect(store.mealPlanAssignments).toHaveLength(0);
      expect(prisma.dailyMealPlanAssignment.create).not.toHaveBeenCalled();
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it('subject binding: payload.clientId differs from draft.subject_user_id → 403 AI_DRAFT_CLIENT_SUBJECT_MISMATCH', async () => {
      const store = seedStore();
      const prisma = makePrismaMock(store);
      const m = new AssignMealPlanMaterializer(prisma, mockNotifications(), scopeOver(prisma));
      const draft = happyDraft();
      draft.subject_user_id = '88888888-8888-8888-8888-888888888888';
      const err = await m.materialize(draft).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SUBJECT_MISMATCH',
      });
      expect(store.mealPlanAssignments).toHaveLength(0);
    });
  });
});

// ===========================================================================
// Spec §4.2 — SendNotificationMaterializer
// ===========================================================================

describe('Stream 2 §4.2 — SendNotificationMaterializer', () => {
  describe('payload schema', () => {
    it('accepts canonical payload', () => {
      const r = SendNotificationPayloadSchema.safeParse({
        clientId: CLIENT_ID,
        kind: 'coach_nudge',
        body: 'Quick check-in for tonight?',
      });
      expect(r.success).toBe(true);
    });
    it('rejects body > 160 chars', () => {
      const r = SendNotificationPayloadSchema.safeParse({
        clientId: CLIENT_ID,
        kind: 'coach_nudge',
        body: 'x'.repeat(161),
      });
      expect(r.success).toBe(false);
    });
    it('rejects channel=email (out of scope)', () => {
      const r = SendNotificationPayloadSchema.safeParse({
        clientId: CLIENT_ID,
        kind: 'coach_nudge',
        body: 'hi',
        channel: 'email',
      });
      expect(r.success).toBe(false);
    });
    it('assertSendNotificationPayload throws on malformed input', () => {
      expect(() => assertSendNotificationPayload({ junk: true })).toThrow();
    });
  });

  function seedStore(): MiniStore {
    const store = newStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'coach' });
    return store;
  }

  function happyDraft(): any {
    return draftBase({
      capability: 'draft.send_notification',
      payload: {
        clientId: CLIENT_ID,
        kind: 'coach_nudge',
        body: 'Quick check-in for tonight?',
        channel: 'push',
      },
    });
  }

  it('happy path → creates Notification with ai_draft_id', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const m = new SendNotificationMaterializer(prisma);
    const r = await m.materialize(happyDraft());
    expect(r.status).toBe('sent');
    expect(store.notifications).toHaveLength(1);
    const row = store.notifications[0];
    expect(row.ai_draft_id).toBe('55555555-5555-5555-5555-555555555555');
    expect(row.user_id).toBe(CLIENT_ID);
    expect(row.kind).toBe('coach_nudge');
    expect(row.channel).toBe('push');
  });

  it('idempotency → second call returns already_materialised', async () => {
    const store = seedStore();
    const prisma = makePrismaMock(store);
    const m = new SendNotificationMaterializer(prisma);
    await m.materialize(happyDraft());
    const r2 = await m.materialize(happyDraft());
    expect(r2.status).toBe('already_materialised');
    expect(store.notifications).toHaveLength(1);
  });

  it('race path → P2002 → re-query → already_materialised', async () => {
    const store = seedStore();
    store.notifications.push({
      id: 'notif_pre_existing',
      ai_draft_id: '55555555-5555-5555-5555-555555555555',
    });
    const prisma = makePrismaMock(store, { failNextCreateWithP2002: true });
    const m = new SendNotificationMaterializer(prisma);
    const r = await m.materialize(happyDraft());
    expect(r.status).toBe('already_materialised');
    expect(r.ref).toBe('notif_pre_existing');
  });

  it('layer-3 role rejection → client requester is refused', async () => {
    const store = seedStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'client' });
    const prisma = makePrismaMock(store);
    const m = new SendNotificationMaterializer(prisma);
    await expect(m.materialize(happyDraft())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(store.notifications).toHaveLength(0);
  });

  it('owner role is accepted (parity with coach)', async () => {
    const store = seedStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'owner' });
    const prisma = makePrismaMock(store);
    const m = new SendNotificationMaterializer(prisma);
    const r = await m.materialize(happyDraft());
    expect(r.status).toBe('sent');
  });
});

// ===========================================================================
// Spec §3 layer-2 — Gateway role-gate
// ===========================================================================

describe('Stream 2 §3 — AiGatewayService draft.* role-gate (layer 2)', () => {
  function buildPrisma() {
    return {
      aiRequestAudit: { create: jest.fn(async ({ data }: any) => ({ id: 'a', ...data })) },
      aiActionDraft: { create: jest.fn(async ({ data }: any) => ({ id: 'd', ...data })) },
      user: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          role: 'coach',
          coach_id: null,
        })),
      },
    } as any;
  }
  function buildSvc(audit?: any) {
    const config = new AiGatewayConfig();
    const redaction = new AiRedactionService();
    const stub = new StubProviderAdapter();
    const fakeAnthropic = { name: 'anthropic', complete: jest.fn() } as any;
    const registry = new AiProviderRegistry(stub, fakeAnthropic);
    return new AiGatewayService(buildPrisma(), config, redaction, registry, undefined, audit);
  }

  it.each([
    'draft.coach_message',
    'draft.assign_workout',
    'draft.assign_meal_plan',
    'draft.send_notification',
    // MWB-5 (P2.1) — the two live-create capabilities are draft.* and so are
    // subject to the same gateway role-gate. A client/student JWT must be
    // refused with a 403 BEFORE any draft row is created, regardless of the
    // FEATURE_MWB_AI_LIVE_CREATE flag (the role-gate runs before the
    // capability allow-list).
    'draft.create_workout_plan',
    'draft.edit_workout_plan',
  ])('refuses %s when requester.role=client', async (capability) => {
    const audit = { write: jest.fn(async () => undefined) };
    const svc = buildSvc(audit);
    await expect(
      svc.invoke({
        capability,
        requester: { id: 'u-1', role: 'client' },
        userMessage: 'do the thing',
        systemPrompt: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Audit log fired with the canonical action string.
    expect(audit.write).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auditArg = (audit.write.mock.calls[0] as any[])[0];
    expect(auditArg.action).toBe('AI_GATEWAY_DRAFT_ROLE_REJECTED');
    expect(auditArg.targetId).toBe(capability);
    expect(auditArg.actorRole).toBe('client');
  });

  it.each(['student', 'staff', 'guest', 'anonymous'])(
    'refuses draft.assign_workout when requester.role=%s (any non-coach/non-owner role)',
    async (role) => {
      const audit = { write: jest.fn() };
      const svc = buildSvc(audit);
      await expect(
        svc.invoke({
          capability: 'draft.assign_workout',
          requester: { id: 'u-1', role },
          userMessage: 'x',
          systemPrompt: 'y',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('does NOT refuse non-draft capabilities even from client role (only draft.* is gated)', async () => {
    const audit = { write: jest.fn() };
    const svc = buildSvc(audit);
    // chat.client_self is the canonical client-allowed capability; the
    // gateway should pass the role-gate (it will then run the rest of
    // invoke and may still 503 on disabled gateway, but the role-gate
    // is NOT what rejects it).
    process.env.AI_GATEWAY_ENABLED = 'false';
    const out = await svc.invoke({
      capability: 'chat.client_self',
      requester: { id: 'u-1', role: 'client' },
      userMessage: 'hello',
      systemPrompt: 'be helpful',
    });
    expect(out).toBeTruthy();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('passes the role-gate when requester.role=coach', async () => {
    const audit = { write: jest.fn() };
    const svc = buildSvc(audit);
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = 'draft.assign_workout';
    try {
      // The call will reach the payload-validator and FAIL there (we did
      // not pass a valid proposedActionPayload) — but the role-gate
      // permitted it. A BadRequestException here means the role-gate
      // accepted the call.
      await expect(
        svc.invoke({
          capability: 'draft.assign_workout',
          requester: { id: COACH_ID, role: 'coach' },
          userMessage: 'x',
          systemPrompt: 'y',
          tenantCoachId: COACH_ID,
          proposedActionPayload: { junk: true },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.write).not.toHaveBeenCalled();
    } finally {
      delete process.env.AI_GATEWAY_ENABLED;
      delete process.env.AI_GATEWAY_PROVIDER;
      delete process.env.AI_GATEWAY_CAPABILITIES;
    }
  });
});

// ===========================================================================
// D8 (PR #593, R593-c7A-01) — gateway draft-time client binding + tenancy
// ===========================================================================

describe('D8 — AiGatewayService binds proposed clientId to the subject and applies coach-client tenancy at draft time', () => {
  const OTHER_COACH = '66666666-6666-6666-6666-666666666666';
  const OTHER_CLIENT = '99999999-9999-9999-9999-999999999999';

  function buildStore(): MiniStore {
    const store = newStore();
    store.users.set(COACH_ID, { id: COACH_ID, role: 'coach', coach_id: null });
    store.users.set(OTHER_COACH, { id: OTHER_COACH, role: 'coach', coach_id: null });
    store.users.set(CLIENT_ID, { id: CLIENT_ID, role: 'student', coach_id: COACH_ID });
    store.users.set(OTHER_CLIENT, { id: OTHER_CLIENT, role: 'student', coach_id: OTHER_COACH });
    return store;
  }
  function buildSvc(store: MiniStore, opts: { withScope?: boolean } = { withScope: true }) {
    const prisma = makePrismaMock(store);
    prisma.aiRequestAudit = { create: jest.fn(async ({ data }: any) => ({ id: 'a', ...data })) };
    prisma.aiActionDraft = { create: jest.fn(async ({ data }: any) => ({ id: 'd', ...data })) };
    const config = new AiGatewayConfig();
    const redaction = new AiRedactionService();
    const stub = new StubProviderAdapter();
    const fakeAnthropic = { name: 'anthropic', complete: jest.fn() } as any;
    const registry = new AiProviderRegistry(stub, fakeAnthropic);
    const svc = new AiGatewayService(
      prisma,
      config,
      redaction,
      registry,
      undefined,
      undefined,
      opts.withScope === false ? undefined : scopeOver(prisma),
    );
    return { svc, prisma };
  }
  const payloadFor = (clientId: string) => ({
    workoutPlanId: WORKOUT_PLAN_ID,
    clientId,
    scheduledFor: '2026-06-01T09:00:00Z',
  });

  beforeEach(() => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = 'draft.assign_workout,draft.assign_meal_plan';
  });
  afterEach(() => {
    delete process.env.AI_GATEWAY_ENABLED;
    delete process.env.AI_GATEWAY_PROVIDER;
    delete process.env.AI_GATEWAY_CAPABILITIES;
  });

  it("cross-tenant proposal (another coach's client) → 403 AI_DRAFT_CLIENT_SCOPE_FORBIDDEN and NO draft row", async () => {
    const { svc, prisma } = buildSvc(buildStore());
    const err = await svc
      .invoke({
        capability: 'draft.assign_workout',
        requester: { id: COACH_ID, role: 'coach' },
        subjectUserId: OTHER_CLIENT,
        tenantCoachId: COACH_ID,
        userMessage: 'x',
        systemPrompt: 'y',
        proposedActionPayload: payloadFor(OTHER_CLIENT),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
    });
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it('subject / payload mismatch (authorised subject is own client, payload names another) → 403 AI_DRAFT_CLIENT_SUBJECT_MISMATCH, no draft', async () => {
    const { svc, prisma } = buildSvc(buildStore());
    const err = await svc
      .invoke({
        capability: 'draft.assign_workout',
        requester: { id: COACH_ID, role: 'coach' },
        subjectUserId: CLIENT_ID,
        tenantCoachId: COACH_ID,
        userMessage: 'x',
        systemPrompt: 'y',
        proposedActionPayload: payloadFor(OTHER_CLIENT),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      error: 'AI_DRAFT_CLIENT_SUBJECT_MISMATCH',
    });
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it('own roster client, bound subject → draft persisted (pending approval)', async () => {
    const { svc, prisma } = buildSvc(buildStore());
    const out = await svc.invoke({
      capability: 'draft.assign_workout',
      requester: { id: COACH_ID, role: 'coach' },
      subjectUserId: CLIENT_ID,
      tenantCoachId: COACH_ID,
      userMessage: 'x',
      systemPrompt: 'y',
      proposedActionPayload: payloadFor(CLIENT_ID),
    });
    expect(out.approvalRequired).toBe(true);
    expect(prisma.aiActionDraft.create).toHaveBeenCalledTimes(1);
  });

  it('meal plan: cross-tenant proposal → 403, no draft', async () => {
    const { svc, prisma } = buildSvc(buildStore());
    const err = await svc
      .invoke({
        capability: 'draft.assign_meal_plan',
        requester: { id: COACH_ID, role: 'coach' },
        subjectUserId: OTHER_CLIENT,
        tenantCoachId: COACH_ID,
        userMessage: 'x',
        systemPrompt: 'y',
        proposedActionPayload: { dailyMealPlanId: MEAL_PLAN_ID, clientId: OTHER_CLIENT, startsOn: '2026-06-01' },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it('fails CLOSED when SubCoachScopeService is not wired: an assignment draft is refused, never persisted unchecked', async () => {
    const { svc, prisma } = buildSvc(buildStore(), { withScope: false });
    await expect(
      svc.invoke({
        capability: 'draft.assign_workout',
        requester: { id: COACH_ID, role: 'coach' },
        subjectUserId: CLIENT_ID,
        tenantCoachId: COACH_ID,
        userMessage: 'x',
        systemPrompt: 'y',
        proposedActionPayload: payloadFor(CLIENT_ID),
      }),
    ).rejects.toThrow(/SubCoachScopeService is not wired/);
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Sanity: capability strings + DEFAULT_APPROVAL_REQUIRED set
// ===========================================================================

describe('Stream 2 — capability constants are stable', () => {
  it('exports the locked capability strings', () => {
    expect(ASSIGN_WORKOUT_CAPABILITY).toBe('draft.assign_workout');
    expect(ASSIGN_MEAL_PLAN_CAPABILITY).toBe('draft.assign_meal_plan');
    expect(SEND_NOTIFICATION_CAPABILITY).toBe('draft.send_notification');
  });
});
