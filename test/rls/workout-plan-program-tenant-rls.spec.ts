/**
 * PLANPROG: a workout plan points only at a program of its own tenant and at
 * its own head revision. Migration 20270428000000_plan_days_stay_in_program_tenant
 * adds two RESTRICTIVE policies on WorkoutPlan (insert; update before and
 * after the change) through app.workout_plan_links_in_tenant, and the server's
 * program copy, clone and assign paths read only days whose coach_id is the
 * program's tenant (programDaysWhere), so a day planted before the fix never
 * reaches a client.
 * Row writes run as the API role `authenticated` (no RLS bypass) on the
 * replayed migration chain. Every zero has a control (a read of 1 of the same
 * row, or a count on the superuser connection), so a zero means the rule
 * refused the row, not that it is missing. The first case runs down.sql to
 * show the old hole on this data, then re-applies the migration. The service
 * cases call the real services on the superuser connection, as the API does.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { ProgramDeliveryService } from '../../src/workout-builder/program-delivery.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('workout-plan-program-tenant-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270428000000_plan_days_stay_in_program_tenant';
const RLS = /row-level security/;

(DB_URL ? describe : describe.skip)('PLANPROG: a plan points only at a program of its own tenant', () => {
  // PrismaService is the app's own client class, so the services take it as is.
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run. Head coaches h and b. s: a coach
  // seated on h's team. ch: h's client. cb: b's client. o: an owner admin.
  const [h, b, s, ch, cb, o] = Array.from({ length: 6 }, () => randomUUID());
  const roleOf: Record<string, string> = { [ch]: 'student', [cb]: 'student', [o]: 'owner' };
  // Master programs: h's (with one real day hDay and its revision hRev), and
  // one in each of b's, s's and o's own tenants.
  let hProg = '';
  let hDay = '';
  let hRev = '';
  const own: Record<string, string> = {};

  /** Runs `fn` in one transaction as the API role `authenticated`, signed in as `who`. */
  const asUser = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, roleOf[who] ?? 'coach');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return fn(tx);
    });
  /** Rows with this id that `who` reads. */
  const seen = async (rowId: string, who: string): Promise<number> => {
    const [{ n }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM public."WorkoutPlan" WHERE "id" = $1', rowId));
    return n;
  };
  /** `who` inserts a plan of their own (coach_id = who) into `program` (null: standalone); resolves to its id. */
  const insertPlan = (who: string, program: string | null, opts: { day?: number; head?: string } = {}, id = randomUUID()) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO public."WorkoutPlan" ("id","coach_id","name","type","updated_at","program_id","week_index","day_index","is_template","head_revision_id")
       VALUES ($1, $2, 'RLS day', 'strength', now(), $3, $4, $5, $6, $7)`,
      id, who, program, program ? 0 : null, program ? opts.day ?? 0 : null, program !== null, opts.head ?? null)).then(() => id);
  /** Rows `who` renames (a plain edit). */
  const rename = (who: string, rowId: string) => asUser(who, (tx) =>
    tx.$executeRawUnsafe(`UPDATE public."WorkoutPlan" SET "name" = 'RLS renamed' WHERE "id" = $1`, rowId));
  /** `who` moves their plan into `program`. */
  const move = (who: string, rowId: string, program: string) => asUser(who, (tx) =>
    tx.$executeRawUnsafe(`UPDATE public."WorkoutPlan" SET "program_id" = $2, "week_index" = 0, "day_index" = 1 WHERE "id" = $1`, rowId, program));
  /** `who` points their plan's head at `revision`. */
  const setHead = (who: string, rowId: string, revision: string) => asUser(who, (tx) =>
    tx.$executeRawUnsafe(`UPDATE public."WorkoutPlan" SET "head_revision_id" = $2 WHERE "id" = $1`, rowId, revision));
  /** A day row whose coach_id is not its program's tenant, as one planted before the fix. */
  const plantDay = (planter: string, program: string, day: number) =>
    prisma.workoutPlan.create({
      data: { coach_id: planter, name: 'RLS planted', type: 'strength', program_id: program, week_index: 0, day_index: day, is_template: true },
    }).then((p) => p.id);
  /** The source day ids a copy program was made from. */
  const copiedFrom = async (programId: string) =>
    (await prisma.workoutPlan.findMany({ where: { program_id: programId }, select: { cloned_from_plan_id: true } }))
      .map((p) => p.cloned_from_plan_id);
  /** Applies a migration file's statements in one transaction (comments dropped, BEGIN/COMMIT handled here). */
  const runSql = (file: 'migration.sql' | 'down.sql') => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION, file), 'utf8');
    const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
      .split(';').map((st) => st.trim()).filter((st) => st && !/^(BEGIN|COMMIT)$/i.test(st));
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
    });
  };

  beforeAll(async () => {
    const people: Array<[string, 'coach' | 'student' | 'owner', string | null]> = [
      [h, 'coach', null], [b, 'coach', null], [s, 'coach', h], [ch, 'student', h], [cb, 'student', b], [o, 'owner', null],
    ];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: s } });
    const master = (coach: string) => prisma.workoutProgram.create({
      data: { coach_id: coach, owner_user_id: coach, visibility: 'owner_only', name: 'RLS program', weeks: 4, days_per_week: 3, is_template: true },
    }).then((p) => p.id);
    hProg = await master(h);
    for (const who of [b, s, o]) own[who] = await master(who);
    hDay = (await prisma.workoutPlan.create({
      data: { coach_id: h, name: 'RLS real day', type: 'strength', program_id: hProg, week_index: 0, day_index: 0, is_template: true },
    })).id;
    hRev = (await prisma.workoutPlanRevision.create({
      data: { workout_plan_id: hDay, revision_index: 0, exercises_json: [], plan_meta_json: {}, author_id: h, author_kind: 'coach', cause: 'initial' },
    })).id;
    process.env.FEATURE_MWB_TEMPLATES = 'true';
  });
  afterAll(() => prisma.$disconnect());

  it("down.sql brings back the hole on this data; the migration closes it again", async () => {
    await runSql('down.sql');
    const planted = await insertPlan(b, hProg, { day: 2 });
    expect(await seen(planted, b)).toBe(1);
    await expect(insertPlan(ch, hProg, { day: 2 })).resolves.toBeDefined();
    const moved = await insertPlan(b, null);
    expect(await move(b, moved, hProg)).toBe(1);
    await runSql('migration.sql');
    await expect(insertPlan(b, hProg, { day: 2 })).rejects.toThrow(RLS);
    await expect(insertPlan(ch, hProg, { day: 2 })).rejects.toThrow(RLS);
    const later = await insertPlan(b, null);
    await expect(move(b, later, hProg)).rejects.toThrow(RLS);
    // Rows planted before the fix stay (no data change), but their planter can no longer edit them.
    expect(await prisma.workoutPlan.count({ where: { id: { in: [planted, moved] } } })).toBe(2);
    expect(await rename(b, planted)).toBe(0);
    expect(await rename(b, moved)).toBe(0);
  });

  it("another coach, a client or a team member cannot add a day of their own to a coach's program", async () => {
    const tried: string[] = [];
    for (const who of [b, ch, cb, s, o]) {
      const id = randomUUID();
      tried.push(id);
      await expect(insertPlan(who, hProg, { day: 1 }, id)).rejects.toThrow(RLS);
    }
    // A client cannot add one to their own coach's program either.
    const id = randomUUID();
    tried.push(id);
    await expect(insertPlan(cb, own[b], {}, id)).rejects.toThrow(RLS);
    expect(await prisma.workoutPlan.count({ where: { id: { in: tried } } })).toBe(0);
  });

  it("nobody moves their own plan into another coach's program", async () => {
    for (const who of [b, ch, s]) {
      const mine = await insertPlan(who, null);
      expect(await seen(mine, who)).toBe(1);
      await expect(move(who, mine, hProg)).rejects.toThrow(RLS);
      expect((await prisma.workoutPlan.findUnique({ where: { id: mine } }))?.program_id).toBeNull();
    }
  });

  it("a plan cannot point its head at another plan's revision", async () => {
    await expect(insertPlan(b, null, { head: hRev })).rejects.toThrow(RLS);
    const mine = await insertPlan(b, null);
    await expect(setHead(b, mine, hRev)).rejects.toThrow(RLS);
    expect((await prisma.workoutPlan.findUnique({ where: { id: mine } }))?.head_revision_id).toBeNull();
    // The head coach still points their own day at its own revision.
    expect(await setHead(h, hDay, hRev)).toBe(1);
  });

  it('the head coach, a seated sub-coach, an owner admin and everyone else still write in their own tenant', async () => {
    expect(await rename(h, hDay)).toBe(1);
    const hNew = await insertPlan(h, hProg, { day: 1 });
    expect(await seen(hNew, h)).toBe(1);
    expect(await rename(h, hNew)).toBe(1);
    for (const who of [s, o, b]) {
      const day = await insertPlan(who, own[who]);
      expect(await seen(day, who)).toBe(1);
      expect(await rename(who, day)).toBe(1);
    }
    for (const who of [h, s, o, b, ch, cb]) {
      const solo = await insertPlan(who, null);
      expect(await seen(solo, who)).toBe(1);
      expect(await rename(who, solo)).toBe(1);
    }
  });

  it('deletes are unchanged: a planter may still remove their own row, nobody else can', async () => {
    const planted = await plantDay(b, hProg, 3);
    expect(await asUser(h, (tx) => tx.$executeRawUnsafe('DELETE FROM public."WorkoutPlan" WHERE "id" = $1', planted))).toBe(0);
    expect(await asUser(b, (tx) => tx.$executeRawUnsafe('DELETE FROM public."WorkoutPlan" WHERE "id" = $1', planted))).toBe(1);
    expect(await prisma.workoutPlan.count({ where: { id: planted } })).toBe(0);
  });

  it("copy, clone, assign and delivery read only the program's own days, never a planted one", async () => {
    // Real days only: rows with coach_id = h. Planted rows (b's and ch's) sit
    // in the same program, one sharing a real day's slot.
    const real = (await prisma.workoutPlan.findMany({
      where: { program_id: hProg, coach_id: h, archived_at: null },
      select: { id: true },
    })).map((p) => p.id).sort();
    const planted = [await plantDay(b, hProg, 0), await plantDay(ch, hProg, 4)];
    expect(await prisma.workoutPlan.count({ where: { program_id: hProg, id: { in: planted } } })).toBe(2);
    const service = new WorkoutBuilderService(prisma);

    await service.cloneProgramToClient(hProg, ch, h);
    const clone = await prisma.workoutProgram.findFirstOrThrow({ where: { cloned_from_id: hProg, client_id: ch } });
    expect((await copiedFrom(clone.id)).sort()).toEqual(real);

    const fork = await service.forkTemplate(hProg, h);
    expect(fork.program.forked_from_id).toBe(hProg);
    expect((await copiedFrom(fork.program.id)).sort()).toEqual(real);

    await service.assignProgramToClient(h, hProg, { client_id: ch, start_date: '2027-05-03' });
    const assigned = await prisma.clientWorkoutAssignment.findMany({
      where: { client_id: ch, workout_plan: { program_id: hProg } },
      select: { workout_plan_id: true },
    });
    expect(assigned.map((a) => a.workout_plan_id).sort()).toEqual(real);

    const delivered = await new ProgramDeliveryService(prisma).deliver({
      masterProgramId: hProg,
      tenantCoachId: h,
      actingUserId: h,
      authorKind: 'coach',
      clientId: ch,
      startAt: new Date('2027-05-03T00:00:00Z'),
      deliveryKey: `planprog:${randomUUID()}`,
      source: 'bulk_assign',
    });
    expect((await copiedFrom(delivered.program_id)).sort()).toEqual(real);
    expect(delivered.assignment_ids).toHaveLength(real.length);
  });
});
