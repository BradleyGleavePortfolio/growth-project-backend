/**
 * MOVEPROG-DRAFTS (owner 4 and 17, LS-1062 OWN-PR-B1): the workout builder's
 * AI edit of a day of a client's program copy is a plan-only draft (its
 * changes and rationale, the day in payload.target_plan_id, no client). It
 * follows the copy: every move path that runs on the server deletes the ones
 * held by anyone but the new coach (deleteDraftsLeftByMove, in the move's
 * transaction), and any other move (support, any path that writes coach_id)
 * leaves them where the former coach can neither list, decide nor read them
 * (the copy's day no longer stays in his tenant: planStaysInTenantWhere, and
 * WorkoutPlan's own row rules under ai_action_draft_day_stays).
 *
 * One fresh team per row: head coach h with seated sub-coach s; client c with
 * a program copy and an older copy (no client_id, its day assigned to c),
 * each with a plan-only draft; h's staying client d with one too (unchanged
 * by every move). Real services on the superuser connection (service_role,
 * as the API runs); the row half runs as the signed-in API role, which does
 * not bypass row security, a control of 1 before each 0.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { WORKOUT_BUILDER_MODEL_DIFF_SOURCE } from '../../src/ai/gateway/ai-gateway.service';
import { EDIT_WORKOUT_PLAN_CAPABILITY } from '../../src/ai/gateway/materialisers/edit-workout-plan.materialiser';
import type { AuditService } from '../../src/audit/audit.service';
import { PrismaService } from '../../src/prisma.service';
import type { StripeApiService } from '../../src/billing/stripe-api.service';
import { SubCoachInviteService } from '../../src/sub-coaches/sub-coach-invite.service';
import { SubCoachesService } from '../../src/sub-coaches/sub-coaches.service';
import { TeamModeService } from '../../src/team-mode/team-mode.service';
import type { TeamModeTierResolverService } from '../../src/team-mode/tier-resolver.service';
import type { TeamService } from '../../src/team/team.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-plan-drafts: CI=true but no TEST_DATABASE_URL; not skipping.');
}

(DB_URL ? describe : describe.skip)("A moved client's plan-only AI drafts leave the former coach", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  /** Only what each path reaches. */
  const stub = <T>(part: Partial<T>) => part as T;
  const team = stub<TeamService>({ refreshCounters: async () => undefined });
  const approvals = new AiApprovalService(prisma, stub<AuditService>({ write: async () => undefined }));
  const role: Record<string, 'coach' | 'student'> = {};

  const person = (id: string, kind: 'coach' | 'student', coach_id: string | null) => {
    role[id] = kind;
    return prisma.user.create({
      data: { id, supabase_id: id, email: `moveprog-drafts-${id}`, name: 'Live person', role: kind, coach_id },
    });
  };
  /** `coach`'s copy of a program for `client` (older copies leave client_id empty): one day, assigned to the client. */
  const copy = async (coach: string, client: string, older = false) => {
    const program = await prisma.workoutProgram.create({
      data: {
        id: randomUUID(), name: 'Block', weeks: 1, days_per_week: 1, is_template: false,
        coach_id: coach, owner_user_id: coach, client_id: older ? null : client,
      },
    });
    const day = await prisma.workoutPlan.create({
      data: { id: randomUUID(), coach_id: coach, name: 'Day 1', type: 'strength', program_id: program.id, week_index: 0, day_index: 0 },
    });
    await prisma.clientWorkoutAssignment.create({
      data: { workout_plan_id: day.id, client_id: client, assigned_by_coach_id: coach, scheduled_for: new Date() },
    });
    return day.id;
  };
  /** As the workout builder's AI edit stores it: tenant, requester, the day, no client, the gateway's model marker. */
  const planDraft = async (tenant: string, requester: string, day: string) =>
    (await prisma.aiActionDraft.create({
      data: {
        id: randomUUID(), capability: EDIT_WORKOUT_PLAN_CAPABILITY, tenant_coach_id: tenant, requester_id: requester,
        payload: {
          capability: EDIT_WORKOUT_PLAN_CAPABILITY, target_plan_id: day, base_revision_index: 0,
          diff: [{ kind: 'update_exercise', client_ref: 'a', sets: 5 }, { kind: 'update_exercise', client_ref: 'b', sets: 4 }],
        },
        rationale: 'Fewer sets this week.',
        provenance: [{ source: WORKOUT_BUILDER_MODEL_DIFF_SOURCE, hash: 'live', count: 1 }],
      },
    })).id;

  /** A fresh team: h, seated s, c with three plan-only drafts, staying client d with one. */
  const world = async (cStartsWith: 'h' | 's') => {
    const [h, s, c, d] = Array.from({ length: 4 }, () => randomUUID());
    await person(h, 'coach', null);
    await person(s, 'coach', h);
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: s } });
    await person(c, 'student', cStartsWith === 'h' ? h : s);
    await person(d, 'student', h);
    const [copyDay, olderDay, stayDay] = [await copy(h, c), await copy(h, c, true), await copy(h, d)];
    const draft = {
      head: await planDraft(h, h, copyDay), // the head coach's own
      sub: await planDraft(h, s, copyDay), // a sub-coach's carries the head coach's tenant
      older: await planDraft(h, h, olderDay),
      stay: await planDraft(h, h, stayDay),
    };
    return { h, s, c, d, draft };
  };
  type World = Awaited<ReturnType<typeof world>>;
  type Name = keyof World['draft'];
  /** Drafts of `w` that still exist, by name. */
  const stored = async (w: World) => {
    const ids = Object.values(w.draft);
    const rows = await prisma.aiActionDraft.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const there = new Set(rows.map((r) => r.id));
    return (Object.keys(w.draft) as Name[]).filter((n) => there.has(w.draft[n]));
  };
  /** Drafts of `w` in `coach`'s pending list (GET /ai/drafts). */
  const listed = async (w: World, coach: string) => {
    const ids = new Set((await approvals.listPending({ tenantCoachId: coach, limit: 200 })).map((r) => r.id));
    return (Object.keys(w.draft) as Name[]).filter((n) => ids.has(w.draft[n]));
  };
  /** 'ok', or the refusal's code or error. */
  type Refusal = { getResponse?: () => { code?: string; error?: string } };
  const outcome = (call: Promise<unknown>) =>
    call.then(() => 'ok', (e: Refusal) => e.getResponse?.()?.code ?? e.getResponse?.()?.error ?? String(e));
  /** Runs `fn` as the signed-in API role for `who` (row security applies). */
  const as = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[who]);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who }));
      return fn(tx);
    });
  /** [read, decide] of a draft at the row layer: rows seen, rows a decision would write. */
  const rowLayer = (who: string, id: string) =>
    as(who, async (tx) => [
      await tx.aiActionDraft.count({ where: { id } }),
      await tx.$executeRawUnsafe(`UPDATE "AiActionDraft" SET "status" = 'pending' WHERE "id" = $1`, id),
    ]);

  afterAll(() => prisma.$disconnect());

  it('runs the row half as a role that does not bypass row security', async () => {
    const [r] = await prisma.$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT "rolbypassrls", "rolsuper" FROM pg_roles WHERE "rolname" = 'authenticated'`;
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
    expect(await as(randomUUID(), (tx) => tx.$queryRaw<{ u: string }[]>`SELECT current_user::text AS u`)).toEqual([{ u: 'authenticated' }]);
  });

  // [move path, where c starts, the move, drafts left after it]
  const paths: Array<[string, 'h' | 's', (w: World) => Promise<unknown>, Name[]]> = [
    ['the head coach hands c to the sub-coach (reassign)', 'h',
      (w) => new SubCoachesService(prisma, team).reassignClient(w.h, w.s, { clientId: w.c }), ['stay']],
    ['the head coach takes c back from the sub-coach (reassign)', 's',
      (w) => new SubCoachesService(prisma, team).reassignClient(w.h, w.h, { clientId: w.c }), ['head', 'older', 'stay']],
    ['the head coach revokes the sub-coach', 's',
      (w) => new SubCoachInviteService(prisma, team).revoke(w.h, w.s, {}), ['head', 'older', 'stay']],
    ['the head coach removes the sub-coach from the team (Team Mode)', 's',
      (w) => new TeamModeService(prisma, stub<StripeApiService>({}), stub<TeamModeTierResolverService>({}))
        .removeSubCoach({ headCoachId: w.h, subCoachId: w.s }), ['head', 'older', 'stay']],
  ];

  it.each(paths)('%s: the drafts of the coach c left are deleted with the move', async (_path, start, move, left) => {
    const w = await world(start);
    expect(await stored(w)).toEqual(['head', 'sub', 'older', 'stay']);
    await move(w);
    expect(await stored(w)).toEqual(left);
    // Nothing passes to the new coach: the head coach's list holds only what stayed his.
    expect(await listed(w, w.h)).toEqual(left);
    expect(await listed(w, w.s)).toEqual([]);
  });

  it('any other move (support, coach_id written directly): the drafts stay but the former coach loses them', async () => {
    const w = await world('h');
    const b = randomUUID();
    await person(b, 'coach', null);
    const moved: Name[] = ['head', 'sub', 'older'];
    expect(await listed(w, w.h)).toEqual(['head', 'sub', 'older', 'stay']);
    // [reader, [read, decide] of the sub-coach's draft before the move, after it]
    const readers: Array<[string, number[], number[]]> = [
      [w.h, [1, 1], [0, 0]], // the coach c left
      [b, [0, 0], [0, 0]], // the new coach inherits nothing
      [w.c, [0, 0], [0, 0]], // a plan-only draft names no client
    ];
    const read = async () => {
      const out: number[][] = [];
      for (const [who] of readers) out.push(await rowLayer(who, w.draft.sub));
      return out;
    };
    expect(await read()).toEqual(readers.map((r) => r[1]));
    expect(await rowLayer(w.h, w.draft.head)).toEqual([1, 0]); // his own: read, never self-decided at the row layer

    await prisma.user.update({ where: { id: w.c }, data: { coach_id: b } });
    expect(await stored(w)).toEqual(['head', 'sub', 'older', 'stay']);
    expect(await listed(w, w.h)).toEqual(['stay']);
    expect(await listed(w, b)).toEqual([]);
    for (const name of moved) {
      const draftId = w.draft[name];
      const decider = { id: w.h, role: 'coach' };
      // Approve in full or in part, or reject (which returned the changes and rationale): refused, nothing written.
      expect([
        await outcome(approvals.decide({ draftId, decider, decision: 'approved' })),
        await outcome(approvals.decide({ draftId, decider, decision: 'approved', acceptedChangeIds: ['c0'] })),
        await outcome(approvals.decide({ draftId, decider, decision: 'rejected' })),
      ]).toEqual(['Forbidden', 'Forbidden', 'Forbidden']);
      expect(await prisma.aiActionDraft.findUniqueOrThrow({ where: { id: draftId } })).toMatchObject({
        status: 'pending', decided_by_id: null, materialised_at: null,
      });
      expect(await rowLayer(w.h, draftId)).toEqual([0, 0]);
    }
    expect(await read()).toEqual(readers.map((r) => r[2]));

    // The staying client's draft: listed, read and decided as before.
    expect(await rowLayer(w.h, w.draft.stay)).toEqual([1, 0]);
    expect(await outcome(approvals.decide({ draftId: w.draft.stay, decider: { id: w.h, role: 'coach' }, decision: 'rejected' })))
      .toBe('ok');
  });
});
