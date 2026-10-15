/**
 * HIST2A fix round 1 (owner 4, 139-13): once a client moves to another coach,
 * the former coach cannot edit or archive the client's meal plan, and cannot
 * use the client's program copy as the source of a fork, a clone or a program
 * assignment. Each call first succeeds before the move (the control), then is
 * the existing not-found with no write. The client keeps the plan and the copy
 * unchanged; library programs and the new coach's own work go on as before.
 * Real services on the superuser connection (service_role, as the API runs),
 * so the service rule is what decides, not row security.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { MealPlansService } from '../../src/meal-plans/meal-plans.service';
import { PrismaService } from '../../src/prisma.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('moved-client-copy-sources: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)("A moved client's plan and copy leave the former coach", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const meals = new MealPlansService(prisma);
  const builder = new WorkoutBuilderService(prisma);
  // Fictional people, fresh ids per run. Coaches a and b. c: a's client who
  // moves to b. d: a's client who stays.
  const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID());
  const ids: Record<string, string> = {};
  const start = { start_date: '2027-06-07' };
  /** The existing not-found of that endpoint. */
  const notFound = async (call: Promise<unknown>, message: string) => {
    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    await expect(call).rejects.toThrow(message);
  };
  /** Every row these calls could write: programs, days and assignments. */
  const rows = async () => [
    await prisma.workoutProgram.count(),
    await prisma.workoutPlan.count(),
    await prisma.clientWorkoutAssignment.count(),
  ];
  /** A program of `coach` with one day; a client copy when `client` is given. */
  const program = async (coach: string, client?: string) => {
    const kind = { coach_id: coach, is_template: !client };
    const shape = { name: 'Block', weeks: 1, days_per_week: 1 };
    const p = await prisma.workoutProgram.create({
      data: { ...kind, ...shape, owner_user_id: coach, client_id: client },
    });
    const day = { ...kind, name: 'Day 1', type: 'strength' as const, week_index: 0, day_index: 0 };
    await prisma.workoutPlan.create({ data: { ...day, program_id: p.id } });
    return p.id;
  };

  beforeAll(async () => {
    const people: Array<[string, 'coach' | 'student', string | null]> = [
      [a, 'coach', null],
      [b, 'coach', null],
      [c, 'student', a],
      [d, 'student', a],
    ];
    for (const [id, role, coach_id] of people) {
      const email = `move-${id}`;
      await prisma.user.create({
        data: { id, supabase_id: id, email, name: 'Live person', role, coach_id },
      });
    }
    ids.library = await program(a);
    ids.copy = await program(a, c);
    ids.libraryB = await program(b);
    for (const key of ['plan', 'archiveControl']) {
      const data = { coach_id: a, client_id: c, title: 'Week 1', items: [{ name: 'Oats' }] };
      ids[key] = (await prisma.mealPlan.create({ data })).id;
    }
    process.env.FEATURE_MWB_TEMPLATES = 'true';
  });
  afterAll(() => prisma.$disconnect());

  it("before the move: edit, archive, and fork, clone and assign the client's copy", async () => {
    expect((await meals.updateByCoach(a, ids.plan, { title: 'Week 2' })).title).toBe('Week 2');
    expect(await meals.archiveByCoach(a, ids.archiveControl)).toEqual({ archived: 1 });
    const before = await rows();
    const fork = await builder.forkTemplate(ids.copy, a);
    expect(fork.program.forked_from_id).toBe(ids.copy);
    const clone = await builder.cloneProgramToClient(ids.copy, d, a);
    expect(clone.program.cloned_from_id).toBe(ids.copy);
    const assigned = await builder.assignProgramToClient(a, ids.copy, { client_id: d, ...start });
    expect(assigned.assignments).toHaveLength(1);
    // Fork and clone: a program and a day each; the assignment: one row.
    expect(await rows()).toEqual([before[0] + 2, before[1] + 2, before[2] + 1]);
  });

  it('after the move: each call is not found, writes nothing; the client keeps all', async () => {
    await prisma.user.update({ where: { id: c }, data: { coach_id: b } });
    // Archive the control clone, so only the move can refuse the same clone again.
    const archived = { archived_at: new Date() };
    await prisma.workoutProgram.updateMany({ where: { cloned_from_id: ids.copy }, data: archived });
    const plan = await prisma.mealPlan.findUniqueOrThrow({ where: { id: ids.plan } });
    const before = await rows();

    await notFound(meals.updateByCoach(a, ids.plan, { title: 'Week 3' }), 'Meal plan not found');
    await notFound(meals.archiveByCoach(a, ids.plan), 'Meal plan not found');
    await notFound(builder.forkTemplate(ids.copy, a), 'Source template not found');
    await notFound(builder.cloneProgramToClient(ids.copy, d, a), 'Master program not found');
    const assign = builder.assignProgramToClient(a, ids.copy, { client_id: d, ...start });
    await notFound(assign, 'Program not found');

    expect(await prisma.mealPlan.findUniqueOrThrow({ where: { id: ids.plan } })).toEqual(plan);
    expect(await rows()).toEqual(before);
    const kept = (await meals.listForClient(c)).map((p) => [p.id, p.title]);
    expect(kept).toEqual([[ids.plan, 'Week 2']]);
    const copyDays = { program_id: ids.copy, archived_at: null };
    expect(await prisma.workoutPlan.count({ where: copyDays })).toBe(1);
  });

  it("the former coach's library and the new coach's own work go on as before", async () => {
    const before = await rows();
    await builder.forkTemplate(ids.library, a);
    await builder.cloneProgramToClient(ids.library, d, a);
    await builder.assignProgramToClient(a, ids.library, { client_id: d, ...start });
    await builder.cloneProgramToClient(ids.libraryB, c, b);
    await builder.assignProgramToClient(b, ids.libraryB, { client_id: c, ...start });
    expect(await rows()).toEqual([before[0] + 3, before[1] + 3, before[2] + 2]);

    const own = await meals.createForClient(b, c, { title: 'B week 1', items: [{ name: 'Rice' }] });
    expect((await meals.updateByCoach(b, own.id, { title: 'B week 2' })).title).toBe('B week 2');
    expect(await meals.archiveByCoach(b, own.id)).toEqual({ archived: 1 });
  });
});
