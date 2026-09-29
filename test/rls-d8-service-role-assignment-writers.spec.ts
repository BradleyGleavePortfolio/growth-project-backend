/**
 * D8 (owner decision 2026-09-29; PR #593 fix round 2, R593-c7A-01 / R593-c7B-01) — the SERVICE-ROLE
 * assignment writers apply the same coach-client tenancy rule the RLS policy applies.
 *
 * The backend's Prisma connection is the `postgres` owner role (BYPASSRLS; not the PostgREST service_role): `assignment_coach_manage`
 * never runs for it, so the application must be the gate. Before this round the two AI approval
 * materialisers (`draft.assign_workout` -> AssignWorkoutMaterializer, `draft.assign_meal_plan` ->
 * AssignMealPlanMaterializer) wrote `payload.clientId` with no client-scope check. This spec drives the
 * REAL materialisers and the REAL SubCoachScopeService against a REAL PostgreSQL on which the full
 * migration chain was deployed (the `person-owned-rls-live-tests` CI job), on a connection that is
 * proven BYPASSRLS/superuser first, and asserts:
 *
 *   1. cross-tenant approval (tenant coach A, client of coach B) is refused with
 *      AI_DRAFT_CLIENT_SCOPE_FORBIDDEN and writes NO ClientWorkoutAssignment / snapshot / push;
 *   2. the payload client is bound to the draft's authorised subject (mismatch -> refused, no write);
 *   3. a sub-coach with an OPEN delegation is admitted; once the delegation is CLOSED the same draft is
 *      refused at approval time (revocation is evaluated live, inside the write transaction);
 *   4. the own-roster path still materialises (row + frozen snapshot, assigned_by = tenant coach);
 *   5. the same for the meal-plan writer (cross-tenant refused, own roster admitted);
 *   6. the application predicate and the RLS predicate (app.actor_coaches_client) agree cell-by-cell on
 *      the same fixtures — ONE tenancy rule (D8);
 *   7. (fix round 3, R593-c7A2-01) the authorization is ATOMIC with the write: the tenancy facts are
 *      read `FOR SHARE` inside the write transaction, so a delegation revocation or a roster
 *      reassignment started between the check and the COMMIT is BLOCKED until the writer commits (proved
 *      with a second connection and a gate that pauses the materialiser after its check, before its
 *      INSERT), and once it lands the next write of the same shape is refused. On the pre-round-3 head
 *      (plain findUnique/findMany, no lock) the concurrent UPDATE completes inside the pause and the
 *      "blocked" assertion fails — that is the behavioural discriminator.
 *
 * Fixtures are synthetic, run-prefixed UUIDs and are removed in afterAll. Notifications are a stub
 * (no push is sent). Connection: S8D3_RLS_TEST_DATABASE_URL > TEST_DATABASE_URL; skipped when neither
 * is set (the default jest lane never selects this file); HARD-FAILS when set but unreachable.
 */
import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { AiActionDraft } from '@prisma/client';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { lockTenancyFacts, type LockedTenancyFacts } from '../src/sub-coach/tenancy-lock';
import { AssignWorkoutMaterializer } from '../src/ai/gateway/materialisers/assign-workout.materialiser';
import { AssignMealPlanMaterializer } from '../src/ai/gateway/materialisers/assign-meal-plan.materialiser';

const TEST_DB_URL = process.env.S8D3_RLS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || '';
const describeLive = TEST_DB_URL ? describe : describe.skip;

const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────
const RUN = `d8sr-${randomUUID().slice(0, 8)}`;
const U = {
  coachA: randomUUID(),
  coachB: randomUUID(),
  subCoach: randomUUID(), // role coach, coach_id = A (a sub-coach on A's team)
  s1: randomUUID(), // coach A's student
  s3: randomUUID(), // coach B's student
  // R593-c7B2-C06 divergence-prone cells:
  s5: randomUUID(), // coach A's student, SOFT-DELETED, with an open delegation from the sub-coach
  teamCoach: randomUUID(), // role coach on A's team (a non-student) with an open delegation from the sub-coach
  ownerU: randomUUID(), // role owner acting as a coach
  s6: randomUUID(), // the owner's own student
  weird: randomUUID(), // role student with coach_id set and an open "delegation" row to S7
  s7: randomUUID(), // coach A's student; target of the `weird` row (one OPEN delegation per client is UNIQUE)
};
const PLAN_A = randomUUID();
const PLAN_SC = randomUUID();
const MEAL_A = randomUUID();
const SCA_OPEN = randomUUID();
const SCA_C06 = { deleted: randomUUID(), nonStudent: randomUUID(), weird: randomUUID() };

const draftIds = new Set<string>();
function draft(over: Partial<AiActionDraft> & { payload: unknown }): AiActionDraft {
  const id = randomUUID();
  draftIds.add(id);
  return {
    id,
    capability: 'draft.assign_workout',
    status: 'pending',
    requester_id: U.coachA,
    subject_user_id: null,
    tenant_coach_id: U.coachA,
    ...over,
  } as unknown as AiActionDraft;
}

function notificationsStub() {
  return { createNotification: jest.fn(async () => ({ id: 'stub' })) } as any;
}

async function insertFixtures(): Promise<void> {
  const user = (id: string, role: string, coachId: string | null) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO public."User" ("id","supabase_id","email","name","role","coach_id") VALUES (${lit(id)}, ${lit(randomUUID())}, ${lit(`${RUN}-${id}@example.invalid`)}, 'fixture', ${lit(role)}::"Role", ${coachId ? lit(coachId) : 'NULL'})`,
    );
  await user(U.coachA, 'coach', null);
  await user(U.coachB, 'coach', null);
  await user(U.subCoach, 'coach', U.coachA);
  await user(U.s1, 'student', U.coachA);
  await user(U.s3, 'student', U.coachB);
  await user(U.s5, 'student', U.coachA);
  await prisma.$executeRawUnsafe(
    `UPDATE public."User" SET "deleted_at" = now() WHERE "id" = ${lit(U.s5)}`,
  );
  await user(U.teamCoach, 'coach', U.coachA);
  await user(U.ownerU, 'owner', null);
  await user(U.s6, 'student', U.ownerU);
  await user(U.weird, 'student', U.coachA);
  await user(U.s7, 'student', U.coachA);
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."WorkoutPlan" ("id","coach_id","name","type","updated_at") VALUES
      (${lit(PLAN_A)}, ${lit(U.coachA)}, ${lit(`${RUN}-plan-a`)}, 'strength', now()),
      (${lit(PLAN_SC)}, ${lit(U.subCoach)}, ${lit(`${RUN}-plan-sc`)}, 'strength', now())`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."DailyMealPlan" ("id","coach_id","name") VALUES (${lit(MEAL_A)}, ${lit(U.coachA)}, ${lit(`${RUN}-meal-a`)})`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."SubCoachAssignment" ("id","head_coach_id","sub_coach_id","client_id","assigned_at","unassigned_at") VALUES
      (${lit(SCA_OPEN)}, ${lit(U.coachA)}, ${lit(U.subCoach)}, ${lit(U.s1)}, now(), NULL),
      (${lit(SCA_C06.deleted)}, ${lit(U.coachA)}, ${lit(U.subCoach)}, ${lit(U.s5)}, now(), NULL),
      (${lit(SCA_C06.nonStudent)}, ${lit(U.coachA)}, ${lit(U.subCoach)}, ${lit(U.teamCoach)}, now(), NULL),
      (${lit(SCA_C06.weird)}, ${lit(U.coachA)}, ${lit(U.weird)}, ${lit(U.s7)}, now(), NULL)`,
  );
}

async function removeFixtures(): Promise<void> {
  const ids = [...draftIds].map(lit).join(',');
  if (ids) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM public."ClientWorkoutAssignmentSnapshot" WHERE "assignment_id" IN (SELECT "id" FROM public."ClientWorkoutAssignment" WHERE "ai_draft_id" IN (${ids}))`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM public."ClientWorkoutAssignment" WHERE "ai_draft_id" IN (${ids})`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM public."DailyMealPlanAssignment" WHERE "ai_draft_id" IN (${ids})`,
    );
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM public."SubCoachAssignment" WHERE "id" IN (${[SCA_OPEN, ...Object.values(SCA_C06)].map(lit).join(',')})`,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM public."DailyMealPlan" WHERE "id" = ${lit(MEAL_A)}`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM public."WorkoutPlan" WHERE "id" IN (${lit(PLAN_A)}, ${lit(PLAN_SC)})`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM public."User" WHERE "id" IN (${Object.values(U).map(lit).join(',')})`,
  );
}

async function cwaCountByDraft(draftId: string): Promise<number> {
  const r = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM public."ClientWorkoutAssignment" WHERE "ai_draft_id" = ${lit(draftId)}`,
  )) as Array<{ n: number }>;
  return r[0].n;
}
async function dmpaCountByDraft(draftId: string): Promise<number> {
  const r = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM public."DailyMealPlanAssignment" WHERE "ai_draft_id" = ${lit(draftId)}`,
  )) as Array<{ n: number }>;
  return r[0].n;
}

const workoutPayload = (clientId: string, planId = PLAN_A) => ({
  workoutPlanId: planId,
  clientId,
  scheduledFor: '2026-06-01T09:00:00.000Z',
});
const mealPayload = (clientId: string) => ({
  dailyMealPlanId: MEAL_A,
  clientId,
  startsOn: '2026-06-01',
});

describeLive(
  'D8 — service-role assignment writers apply the coach-client tenancy rule (live PG, BYPASSRLS connection)',
  () => {
    let scope: SubCoachScopeService;
    let workout: AssignWorkoutMaterializer;
    let meal: AssignMealPlanMaterializer;
    let notifications: ReturnType<typeof notificationsStub>;

    beforeAll(async () => {
      await prisma.$connect();
      await insertFixtures();
      scope = new SubCoachScopeService(prisma as any);
      notifications = notificationsStub();
      workout = new AssignWorkoutMaterializer(prisma as any, notifications, scope);
      meal = new AssignMealPlanMaterializer(prisma as any, notifications, scope);
    }, 120_000);

    afterAll(async () => {
      try {
        await removeFixtures();
      } finally {
        await prisma.$disconnect();
      }
    }, 120_000);

    it("the connection under test bypasses RLS (superuser or BYPASSRLS), so any refusal below is the APPLICATION's, not the policy's", async () => {
      const r = (await prisma.$queryRawUnsafe(
        `SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
      )) as Array<{ bypass: boolean }>;
      expect(r).toEqual([{ bypass: true }]);
      // RLS is enabled + forced on the table; it simply does not apply to this principal.
      const rls = (await prisma.$queryRawUnsafe(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public."ClientWorkoutAssignment"'::regclass`,
      )) as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
      expect(rls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    });

    it("cross-tenant approval: tenant coach A, payload client = coach B's student → AI_DRAFT_CLIENT_SCOPE_FORBIDDEN; no assignment, no snapshot, no push", async () => {
      const d = draft({ subject_user_id: U.s3, payload: workoutPayload(U.s3) });
      const err = await workout.materialize(d).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
      });
      expect(await cwaCountByDraft(d.id)).toBe(0);
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it('subject binding: draft authorised for S1 but payload names S3 → AI_DRAFT_CLIENT_SUBJECT_MISMATCH; no write', async () => {
      const d = draft({ subject_user_id: U.s1, payload: workoutPayload(U.s3) });
      const err = await workout.materialize(d).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SUBJECT_MISMATCH',
      });
      expect(await cwaCountByDraft(d.id)).toBe(0);
    });

    it("a coach as the target: coach A cannot assign to coach B (not on A's roster) → refused", async () => {
      const d = draft({ subject_user_id: U.coachB, payload: workoutPayload(U.coachB) });
      await expect(workout.materialize(d)).rejects.toBeInstanceOf(ForbiddenException);
      expect(await cwaCountByDraft(d.id)).toBe(0);
    });

    it('own roster: tenant coach A → S1 materialises a ClientWorkoutAssignment (assigned_by = A) with its frozen snapshot', async () => {
      const d = draft({ subject_user_id: U.s1, payload: workoutPayload(U.s1) });
      const r = await workout.materialize(d);
      expect(r.status).toBe('sent');
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT a."client_id", a."assigned_by_coach_id", a."workout_plan_id", (s."id" IS NOT NULL) AS has_snapshot
         FROM public."ClientWorkoutAssignment" a LEFT JOIN public."ClientWorkoutAssignmentSnapshot" s ON s."assignment_id" = a."id"
        WHERE a."ai_draft_id" = ${lit(d.id)}`,
      )) as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        {
          client_id: U.s1,
          assigned_by_coach_id: U.coachA,
          workout_plan_id: PLAN_A,
          has_snapshot: true,
        },
      ]);
      // Idempotency is unchanged: a second approval of the same draft returns the existing row.
      const again = await workout.materialize(d);
      expect(again.status).toBe('already_materialised');
      expect(await cwaCountByDraft(d.id)).toBe(1);
    });

    it('sub-coach with an OPEN delegation to S1 materialises (own plan; assigned_by = the sub-coach); after the delegation is CLOSED the same shape is refused at approval time', async () => {
      const open = draft({
        requester_id: U.subCoach,
        tenant_coach_id: U.subCoach,
        subject_user_id: U.s1,
        payload: workoutPayload(U.s1, PLAN_SC),
      });
      const r = await workout.materialize(open);
      expect(r.status).toBe('sent');
      expect(await cwaCountByDraft(open.id)).toBe(1);

      await prisma.$executeRawUnsafe(
        `UPDATE public."SubCoachAssignment" SET "unassigned_at" = now() WHERE "id" = ${lit(SCA_OPEN)}`,
      );
      try {
        const closed = draft({
          requester_id: U.subCoach,
          tenant_coach_id: U.subCoach,
          subject_user_id: U.s1,
          payload: workoutPayload(U.s1, PLAN_SC),
        });
        const err = await workout.materialize(closed).catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
        });
        expect(await cwaCountByDraft(closed.id)).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE public."SubCoachAssignment" SET "unassigned_at" = NULL WHERE "id" = ${lit(SCA_OPEN)}`,
        );
      }
    });

    it("meal plan writer: cross-tenant (A → coach B's student) refused with no DailyMealPlanAssignment; own roster (A → S1) admitted", async () => {
      const bad = draft({
        capability: 'draft.assign_meal_plan',
        subject_user_id: U.s3,
        payload: mealPayload(U.s3),
      });
      const err = await meal.materialize(bad).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
      });
      expect(await dmpaCountByDraft(bad.id)).toBe(0);

      const good = draft({
        capability: 'draft.assign_meal_plan',
        subject_user_id: U.s1,
        payload: mealPayload(U.s1),
      });
      const r = await meal.materialize(good);
      expect(r.status).toBe('sent');
      expect(await dmpaCountByDraft(good.id)).toBe(1);
    });

    it('ONE rule: SubCoachScopeService.canActOnClient and the RLS helper app.actor_coaches_client agree on every (actor, client) cell of the fixtures', async () => {
      const actors = {
        coachA: U.coachA,
        coachB: U.coachB,
        subCoach: U.subCoach,
        s1: U.s1,
        ownerU: U.ownerU,
        weird: U.weird,
      };
      const clients = {
        s1: U.s1,
        s3: U.s3,
        coachB: U.coachB,
        subCoach: U.subCoach,
        unknown: randomUUID(),
        s5: U.s5,
        teamCoach: U.teamCoach,
        s6: U.s6,
        s7: U.s7,
      };
      const cells: Array<{ actor: string; client: string; app: boolean; sql: boolean }> = [];
      for (const [an, actor] of Object.entries(actors)) {
        for (const [cn, client] of Object.entries(clients)) {
          const app = await scope.canActOnClient(actor, client);
          const r = (await prisma.$queryRawUnsafe(
            `SELECT app.actor_coaches_client(${lit(actor)}, ${lit(client)}) AS ok`,
          )) as Array<{ ok: boolean }>;
          cells.push({ actor: an, client: cn, app, sql: r[0].ok });
        }
      }
      for (const c of cells) expect(c).toEqual({ ...c, sql: c.app });
      // And the matrix is the one the app intends (not vacuously all-false).
      const truth = Object.fromEntries(cells.map((c) => [`${c.actor}->${c.client}`, c.app]));
      expect(truth).toMatchObject({
        'coachA->s1': true,
        'coachA->subCoach': true, // roster branch: the sub-coach's User.coach_id is A (stated, mirrors the app)
        'coachA->s3': false,
        'coachA->coachB': false,
        'coachB->s3': true,
        'coachB->s1': false,
        'subCoach->s1': true, // open delegation
        'subCoach->s3': false,
        's1->s1': false,
        'coachA->unknown': false,
        // R593-c7B2-C06 — the divergence-prone cells, executable:
        'subCoach->s5': false, // open delegation to a SOFT-DELETED student → denied
        'subCoach->teamCoach': false, // open delegation to a non-student → denied
        'coachA->s5': true, // roster branch does not test deletion (mirrors assertCanAccessClient)
        'coachA->teamCoach': true, // roster branch: the team coach's User.coach_id is A
        'ownerU->s6': true, // owner-role actor on their own roster
        'ownerU->s1': false,
        'weird->s7': false, // coach_id set + open delegation, but role ≠ coach: the delegated branch requires role coach
        'weird->s1': false,
        'coachA->s7': true,
        'subCoach->s7': false, // no delegation to S7
      } as Record<string, boolean>);
    });
    // ─── Round 3 (R593-c7A2-01): authorization atomic with the write ─────────────────────────────
    describe('R593-c7A2-01 — the tenancy check is atomic with the write (row locks, two connections)', () => {
      // Second, independent pool for the concurrent reassignment / revocation and for observing state
      // while the writer's transaction holds `prisma`'s only connection (CI pins connection_limit=1;
      // querying through `prisma` inside the pause would wait for that connection and expire the
      // writer's 5 s interactive transaction).
      const prisma2 = new PrismaClient({
        datasources: {
          db: {
            url: /connection_limit=\d+/.test(TEST_DB_URL)
              ? TEST_DB_URL.replace(/connection_limit=\d+/, 'connection_limit=4')
              : `${TEST_DB_URL}${TEST_DB_URL.includes('?') ? '&' : '?'}connection_limit=4`,
          },
        },
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      /** A one-shot gate: `reached` resolves when the writer is about to INSERT (its check has passed). */
      function makeGate() {
        let openGate!: () => void;
        let markReached!: () => void;
        const opened = new Promise<void>((r) => (openGate = r));
        const reached = new Promise<void>((r) => (markReached = r));
        return { opened, reached, open: openGate, markReached };
      }

      /**
       * Wrap the real Prisma client so the materialiser's write transaction pauses at the assignment
       * INSERT (after its in-transaction tenancy check) until `gate.open()`. Everything else — including
       * the `$queryRaw ... FOR SHARE` reads — goes straight to the real transaction client.
       */
      function gatedPrisma(
        gate: ReturnType<typeof makeGate>,
        table: 'clientWorkoutAssignment' | 'dailyMealPlanAssignment',
      ) {
        const gateTable = (delegate: any) =>
          new Proxy(delegate, {
            get(d, method) {
              if (method !== 'create') return d[method];
              return async (...args: unknown[]) => {
                gate.markReached();
                await gate.opened;
                return d.create(...args);
              };
            },
          });
        const gateTx = (tx: any) =>
          new Proxy(tx, {
            get(t, p) {
              return p === table ? gateTable(t[p]) : t[p];
            },
          });
        return new Proxy(prisma as any, {
          get(target, prop) {
            if (prop !== '$transaction') return target[prop];
            return (cb: (tx: any) => Promise<unknown>, opts?: unknown) =>
              target.$transaction((tx: any) => cb(gateTx(tx)), opts);
          },
        });
      }

      /** Start `sql` on the second connection and report whether it settled within `ms`. */
      function concurrent(sql: string) {
        let settled = false;
        const done = prisma2.$executeRawUnsafe(sql).then(
          () => {
            settled = true;
          },
          (e) => {
            settled = true;
            throw e;
          },
        );
        return { done, isSettled: () => settled };
      }

      beforeAll(async () => {
        await prisma2.$connect();
      }, 60_000);
      // Each test restores its own fixture mutation; this guards the later tests if one aborts midway.
      afterEach(async () => {
        await prisma2.$executeRawUnsafe(
          `UPDATE public."SubCoachAssignment" SET "unassigned_at" = NULL WHERE "id" = ${lit(SCA_OPEN)}`,
        );
        await prisma2.$executeRawUnsafe(
          `UPDATE public."User" SET "coach_id" = ${lit(U.coachA)} WHERE "id" = ${lit(U.s1)}`,
        );
      });
      afterAll(async () => {
        await prisma2.$disconnect();
      }, 60_000);

      it('sub-coach delegation REVOCATION started between the check and the INSERT blocks until the writer commits; the next write is refused (workout writer)', async () => {
        const gate = makeGate();
        const gp = gatedPrisma(gate, 'clientWorkoutAssignment');
        const m = new AssignWorkoutMaterializer(
          gp,
          notificationsStub(),
          new SubCoachScopeService(gp),
        );
        const d = draft({
          requester_id: U.subCoach,
          tenant_coach_id: U.subCoach,
          subject_user_id: U.s1,
          payload: workoutPayload(U.s1, PLAN_SC),
        });
        const write = m.materialize(d);
        let revoke: ReturnType<typeof concurrent> | undefined;
        try {
          await gate.reached; // check passed, FOR SHARE locks held, no row yet
          revoke = concurrent(
            `UPDATE public."SubCoachAssignment" SET "unassigned_at" = now() WHERE "id" = ${lit(SCA_OPEN)}`,
          );
          await sleep(750);
          // THE discriminator: without the row lock the revocation lands here and the assignment is then
          // committed against a closed delegation.
          expect(revoke.isSettled()).toBe(false);
          // No row yet (observed through the second pool; `prisma`'s connection is inside the writer's tx).
          const n = (await prisma2.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM public."ClientWorkoutAssignment" WHERE "ai_draft_id" = ${lit(d.id)}`,
          )) as Array<{ n: number }>;
          expect(n[0].n).toBe(0);
        } finally {
          gate.open();
        }
        const r = await write;
        expect(r.status).toBe('sent');
        await revoke!.done; // released by the writer's COMMIT
        expect(revoke!.isSettled()).toBe(true);
        expect(await cwaCountByDraft(d.id)).toBe(1); // serialised as assignment THEN revocation

        try {
          // Now the revocation is committed: the same shape is refused, no row.
          const again = draft({
            requester_id: U.subCoach,
            tenant_coach_id: U.subCoach,
            subject_user_id: U.s1,
            payload: workoutPayload(U.s1, PLAN_SC),
          });
          const err = await workout.materialize(again).catch((e) => e);
          expect(err).toBeInstanceOf(ForbiddenException);
          expect((err as ForbiddenException).getResponse()).toMatchObject({
            error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
          });
          expect(await cwaCountByDraft(again.id)).toBe(0);
        } finally {
          await prisma.$executeRawUnsafe(
            `UPDATE public."SubCoachAssignment" SET "unassigned_at" = NULL WHERE "id" = ${lit(SCA_OPEN)}`,
          );
        }
      }, 30_000);

      it('roster REASSIGNMENT (User.coach_id A → B) started between the check and the INSERT blocks until the writer commits; the next write is refused (workout writer)', async () => {
        const gate = makeGate();
        const gp = gatedPrisma(gate, 'clientWorkoutAssignment');
        const m = new AssignWorkoutMaterializer(
          gp,
          notificationsStub(),
          new SubCoachScopeService(gp),
        );
        const d = draft({ subject_user_id: U.s1, payload: workoutPayload(U.s1) });
        const write = m.materialize(d);
        let move: ReturnType<typeof concurrent> | undefined;
        try {
          await gate.reached;
          move = concurrent(
            `UPDATE public."User" SET "coach_id" = ${lit(U.coachB)} WHERE "id" = ${lit(U.s1)}`,
          );
          await sleep(750);
          expect(move.isSettled()).toBe(false);
        } finally {
          gate.open();
        }
        const r = await write;
        expect(r.status).toBe('sent');
        await move!.done;
        expect(await cwaCountByDraft(d.id)).toBe(1);
        try {
          const again = draft({ subject_user_id: U.s1, payload: workoutPayload(U.s1) });
          const err = await workout.materialize(again).catch((e) => e);
          expect(err).toBeInstanceOf(ForbiddenException);
          expect((err as ForbiddenException).getResponse()).toMatchObject({
            error: 'AI_DRAFT_CLIENT_SCOPE_FORBIDDEN',
          });
          expect(await cwaCountByDraft(again.id)).toBe(0);
        } finally {
          await prisma.$executeRawUnsafe(
            `UPDATE public."User" SET "coach_id" = ${lit(U.coachA)} WHERE "id" = ${lit(U.s1)}`,
          );
        }
      }, 30_000);

      it('roster REASSIGNMENT started between the check and the INSERT blocks until the writer commits (meal-plan writer)', async () => {
        const gate = makeGate();
        const gp = gatedPrisma(gate, 'dailyMealPlanAssignment');
        const m = new AssignMealPlanMaterializer(
          gp,
          notificationsStub(),
          new SubCoachScopeService(gp),
        );
        const d = draft({
          capability: 'draft.assign_meal_plan',
          subject_user_id: U.s1,
          payload: mealPayload(U.s1),
        });
        const write = m.materialize(d);
        let move: ReturnType<typeof concurrent> | undefined;
        try {
          await gate.reached;
          move = concurrent(
            `UPDATE public."User" SET "coach_id" = ${lit(U.coachB)} WHERE "id" = ${lit(U.s1)}`,
          );
          await sleep(750);
          expect(move.isSettled()).toBe(false);
        } finally {
          gate.open();
        }
        const r = await write;
        expect(r.status).toBe('sent');
        await move!.done;
        expect(await dmpaCountByDraft(d.id)).toBe(1);
        try {
          const again = draft({
            capability: 'draft.assign_meal_plan',
            subject_user_id: U.s1,
            payload: mealPayload(U.s1),
          });
          const err = await meal.materialize(again).catch((e) => e);
          expect(err).toBeInstanceOf(ForbiddenException);
          expect(await dmpaCountByDraft(again.id)).toBe(0);
        } finally {
          await prisma.$executeRawUnsafe(
            `UPDATE public."User" SET "coach_id" = ${lit(U.coachA)} WHERE "id" = ${lit(U.s1)}`,
          );
        }
      }, 30_000);

      it('the protocol itself: lockTenancyFacts inside a transaction holds FOR SHARE on the client row and the open delegation until COMMIT; a revocation that commits FIRST is what the locked read sees', async () => {
        // (a) locks held for the transaction's lifetime.
        const gate = makeGate();
        let facts!: LockedTenancyFacts;
        const tx = prisma.$transaction(async (t) => {
          facts = await lockTenancyFacts(t, U.subCoach, U.s1);
          gate.markReached();
          await gate.opened;
        });
        await gate.reached;
        expect(facts.openDelegation).toBe(true);
        const revoke = concurrent(
          `UPDATE public."SubCoachAssignment" SET "unassigned_at" = now() WHERE "id" = ${lit(SCA_OPEN)}`,
        );
        const move = concurrent(
          `UPDATE public."User" SET "coach_id" = ${lit(U.coachB)} WHERE "id" = ${lit(U.s1)}`,
        );
        await sleep(750);
        expect(revoke.isSettled()).toBe(false);
        gate.open();
        await tx;
        await revoke.done;
        await move.done;
        try {
          // (b) committed-first: the locked read observes the committed state.
          const after = await prisma.$transaction((t) => lockTenancyFacts(t, U.subCoach, U.s1));
          expect(after.openDelegation).toBe(false);
          expect(after.client?.coach_id).toBe(U.coachB);
          expect(await scope.canActOnClient(U.subCoach, U.s1)).toBe(false);
          expect(await scope.canActOnClient(U.coachA, U.s1)).toBe(false);
        } finally {
          await prisma.$executeRawUnsafe(
            `UPDATE public."SubCoachAssignment" SET "unassigned_at" = NULL WHERE "id" = ${lit(SCA_OPEN)}`,
          );
          await prisma.$executeRawUnsafe(
            `UPDATE public."User" SET "coach_id" = ${lit(U.coachA)} WHERE "id" = ${lit(U.s1)}`,
          );
        }
      }, 30_000);
    });
  },
);
