/**
 * SUBREVOKE (owner decision SUB-REINVITE, option 1): removing or revoking a
 * sub-coach ends their client assignments, and a re-invited sub-coach starts
 * with no clients. Runs the real removal, revoke, invite-accept and assign
 * code on the replayed migration chain, then reads ClientWorkoutAssignment as
 * the API role `authenticated` through main's app.caller_coaches_client
 * (policy assignment_coach_manage). Each sub-coach reads their row first (the
 * control), so a zero means the row rule refused it, not that it is missing.
 * Also: a never-seated (legacy) delegation keeps working, the head coach's
 * and the seller's own rows are kept, the 20270418000000 data migration closes
 * delegations earlier removals left open and its down.sql reopens exactly
 * those, and coach B reads none of coach A's CoachAIBudget (the live case for
 * the old T10 placeholder in test/ai-credits-stream1.spec.ts).
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { fakeOf } from '../ai-egress/ai-egress.fakes';
import type { StripeApiService } from '../../src/billing/stripe-api.service';
import type { PrismaService } from '../../src/prisma.service';
import { SubCoachCapacityService } from '../../src/sub-coach/sub-coach-capacity.service';
import { SubCoachIdempotencyService } from '../../src/sub-coach/sub-coach-idempotency.service';
import { SubCoachReassignService } from '../../src/sub-coach/sub-coach-reassign.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { SubCoachesService } from '../../src/sub-coaches/sub-coaches.service';
import type { TeamService } from '../../src/team/team.service';
import { TeamModeService } from '../../src/team-mode/team-mode.service';
import type { TeamModeTierResolverService } from '../../src/team-mode/tier-resolver.service';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('sub-coach-removal-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270418000000_close_removed_sub_coach_delegations';
const ACTION = 'sub_coach.assignment_closed_on_removal';

(DB_URL ? describe : describe.skip)('SUBREVOKE: a removed sub-coach loses their clients at the row layer', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = fakeOf<PrismaService>(prisma);
  const team = new TeamModeService(db, fakeOf<StripeApiService>({ isConfigured: () => false }), fakeOf<TeamModeTierResolverService>({}));
  const subCoaches = new SubCoachesService(db, fakeOf<TeamService>({ refreshCounters: async () => undefined }));
  const reassign = new SubCoachReassignService(db, new SubCoachCapacityService(db), new SubCoachIdempotencyService(db));
  const scope = new SubCoachScopeService(db);
  // Fictional people, fresh ids per run. Heads h and b. Sub-coaches: s (seat
  // under h), r (seats under h and b), l (never seated, legacy delegation),
  // z (seat under h archived by an earlier removal, delegation left open).
  const [h, b, s, r, l, z, c1, c2, c3, cb, cl, cz, c5] = Array.from({ length: 13 }, () => randomUUID());
  const cwa: Record<string, string> = {};
  const ids: Record<string, string> = {};

  /** Runs `fn` in one transaction as the API role `authenticated`, signed in as `who`. */
  const asUser = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', 'coach', true)`);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return fn(tx);
    });
  /** Rows with this id that `who` reads in `table`. */
  const seen = async (table: string, rowId: string, who: string): Promise<number> => {
    const [{ n }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, rowId));
    return n;
  };
  const open = (head: string, sub: string) =>
    prisma.subCoachAssignment.count({ where: { head_coach_id: head, sub_coach_id: sub, unassigned_at: null } });
  const seat = (head: string, sub: string) =>
    prisma.teamSubCoachAssignment.findUniqueOrThrow({ where: { head_coach_id_sub_coach_id: { head_coach_id: head, sub_coach_id: sub } } });
  /** Applies a migration file's statements in one transaction (comments dropped, BEGIN/COMMIT handled here). */
  const runSql = (file: 'migration.sql' | 'down.sql') => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, file), 'utf8');
    const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
      .split(';').map((st) => st.trim()).filter((st) => st && !/^(BEGIN|COMMIT)$/i.test(st));
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
    });
  };
  const assign = (clientId: string, targetSubCoachId: string) =>
    reassign.reassignClient(h, h, 'coach', { clientId, targetSubCoachId, idempotency_key: randomUUID() }, 'assign');

  beforeAll(async () => {
    const people: Array<[string, 'coach' | 'student', string | null]> = [
      [h, 'coach', null], [b, 'coach', null], [s, 'coach', h], [r, 'coach', h], [l, 'coach', h], [z, 'coach', h],
      [c1, 'student', h], [c2, 'student', h], [c3, 'student', h], [cb, 'student', b], [cl, 'student', h],
      [cz, 'student', h], [c5, 'student', h],
    ];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    for (const [head, sub] of [[h, s], [h, r], [b, r]]) {
      await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: head, sub_coach_id: sub } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: z, archived_at: new Date('2027-04-01') } });
    for (const [head, sub, client] of [[h, s, c1], [h, s, c2], [h, r, c3], [b, r, cb], [h, l, cl], [h, z, cz]]) {
      const row = await prisma.subCoachAssignment.create({ data: { head_coach_id: head, sub_coach_id: sub, client_id: client } });
      ids[`${sub}:${client}`] = row.id;
    }
    for (const [coach, client] of [[s, c1], [r, c3], [l, cl], [z, cz], [h, c2]]) {
      const plan = await prisma.workoutPlan.create({ data: { coach_id: coach, name: 'RLS plan', type: 'strength' } });
      const row = await prisma.clientWorkoutAssignment.create({
        data: { workout_plan_id: plan.id, client_id: client, assigned_by_coach_id: coach, scheduled_for: new Date() },
      });
      cwa[coach] = row.id;
    }
    const pkg = await prisma.coachPackage.create({ data: { coach_id: s, name: 'RLS plan', amount_cents: 10000 } });
    ids.sale = (await prisma.clientPurchase.create({
      data: {
        client_user_id: c1, coach_user_id: s, amount_cents: 10000, package_id: pkg.id,
        stripe_checkout_session_id: `cs_${randomUUID()}`, idempotency_key: randomUUID(),
      },
    })).id;
    for (const coach of [h, b]) {
      const budget = await prisma.coachAIBudget.create({
        data: { coach_user_id: coach, period_start: new Date(), period_end: new Date(Date.now() + 864e5) },
      });
      ids[`budget:${coach}`] = budget.id;
    }
  });
  afterAll(() => prisma.$disconnect());

  it('control: each sub-coach reads the workout row they assigned to a delegated client', async () => {
    for (const coach of [s, r, l]) expect(await seen('ClientWorkoutAssignment', cwa[coach], coach)).toBe(1);
    // main's gap: z's seat was archived but the delegation stayed open, so z still reads it.
    expect(await seen('ClientWorkoutAssignment', cwa[z], z)).toBe(1);
  });

  it('removing a sub-coach closes every client assignment from that head coach and they read 0 rows', async () => {
    await team.removeSubCoach({ headCoachId: h, subCoachId: s });
    expect((await seat(h, s)).archived_at).not.toBeNull();
    expect(await open(h, s)).toBe(0);
    expect(await seen('ClientWorkoutAssignment', cwa[s], s)).toBe(0);
    const scoped = await scope.getAuthorizedClientIds(s);
    expect(scoped).not.toContain(c1);
    expect(scoped).not.toContain(c2);
    const event = await prisma.teamAuditEvent.findFirst({ where: { head_coach_id: h, event_kind: 'sub_coach_removed' } });
    expect(event?.metadata).toMatchObject({ sub_coach_id: s, closed_assignment_count: 2 });
  });

  it('the head coach\'s and the seller\'s own rows are kept', async () => {
    expect(await seen('ClientWorkoutAssignment', cwa[h], h)).toBe(1);
    expect(await open(h, l)).toBe(1);
    expect(await seen('ClientPurchase', ids.sale, s)).toBe(1);
  });

  it('revoking a sub-coach who serves two head coaches closes only this head coach\'s assignments', async () => {
    await subCoaches.revoke(h, r, {});
    expect(await open(h, r)).toBe(0);
    expect(await open(b, r)).toBe(1);
    expect((await seat(b, r)).archived_at).toBeNull();
    expect(await seen('ClientWorkoutAssignment', cwa[r], r)).toBe(0);
  });

  it('a re-invited sub-coach gets their seat back with no clients', async () => {
    const token = randomUUID();
    await prisma.subCoachInvite.create({
      data: {
        head_coach_id: h, email: `${s}@example.test`, expires_at: new Date(Date.now() + 864e5),
        token_hash: createHash('sha256').update(token).digest('hex'),
      },
    });
    await subCoaches.accept(s, 'coach', `${s}@example.test`, token);
    expect((await seat(h, s)).archived_at).toBeNull();
    expect(await open(h, s)).toBe(0);
    expect(await seen('ClientWorkoutAssignment', cwa[s], s)).toBe(0);
    const scoped = await scope.getAuthorizedClientIds(s);
    expect(scoped).not.toContain(c1);
    expect(scoped).not.toContain(c2);
  });

  it('a new assignment needs an active seat when the pair ever had one; a never-seated pair still gets one', async () => {
    await expect(assign(c5, r)).rejects.toThrow(NotFoundException);
    expect(await prisma.subCoachAssignment.count({ where: { client_id: c5, unassigned_at: null } })).toBe(0);
    await expect(assign(c5, s)).resolves.toMatchObject({ newSubCoachId: s });
    await expect(assign(c5, l)).resolves.toMatchObject({ previousSubCoachId: s, newSubCoachId: l });
    expect(await open(h, l)).toBe(2);
  });

  it('a never-seated (legacy) delegation still works', async () => {
    expect(await seen('ClientWorkoutAssignment', cwa[l], l)).toBe(1);
    expect(await scope.getAuthorizedClientIds(l)).toEqual(expect.arrayContaining([cl, c5]));
  });

  it('the data migration closes delegations earlier removals left open and records each one', async () => {
    await runSql('migration.sql');
    expect(await open(h, z)).toBe(0);
    expect(await seen('ClientWorkoutAssignment', cwa[z], z)).toBe(0);
    const records = await prisma.auditLog.findMany({ where: { action: ACTION, target_id: ids[`${z}:${cz}`] } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ target_user_id: cz, tenant_coach_id: h, metadata: { migration: MIGRATION, sub_coach_id: z } });
    // Untouched: the never-seated pair and the pair with an active seat.
    expect(await open(h, l)).toBe(2);
    expect(await open(b, r)).toBe(1);
  });

  it('down.sql reopens exactly what the migration closed; the migration then closes it again', async () => {
    await runSql('down.sql');
    expect(await open(h, z)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: ACTION, target_id: ids[`${z}:${cz}`] } })).toBe(0);
    // Closed by the removal code, not the migration: stays closed.
    expect(await open(h, s)).toBe(0);
    expect(await open(h, r)).toBe(0);
    await runSql('migration.sql');
    expect(await open(h, z)).toBe(0);
    expect(await seen('ClientWorkoutAssignment', cwa[z], z)).toBe(0);
  });

  it('CoachAIBudget: coach A reads their own budget; coach B and A\'s sub-coach read none of it', async () => {
    expect(await seen('CoachAIBudget', ids[`budget:${h}`], h)).toBe(1);
    expect(await seen('CoachAIBudget', ids[`budget:${h}`], b)).toBe(0);
    expect(await seen('CoachAIBudget', ids[`budget:${h}`], s)).toBe(0);
    expect(await seen('CoachAIBudget', ids[`budget:${b}`], h)).toBe(0);
  });
});
