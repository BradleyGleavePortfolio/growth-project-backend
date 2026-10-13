/**
 * SUBREVOKE2: a bare User.coach_id is not team membership at the row layer.
 * Migration 20270421000000_team_rows_need_membership judges membership per
 * head coach: an active seat, or a never-seated pair (coach_id = that head
 * coach plus an open delegation from them). Reads and writes run as the API
 * role `authenticated` (no RLS bypass) on the replayed migration chain. Every
 * zero comes after a read of 1 of the same row by someone the rule admits, so
 * a zero means the rule refused the row, not that it is missing. The first
 * case runs down.sql to show the old leak on this data, then re-applies the
 * migration.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('team-membership-rows-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270421000000_team_rows_need_membership';
const RLS = /row-level security/;

(DB_URL ? describe : describe.skip)('SUBREVOKE2: team rows need team membership, not a bare coach_id', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run. Heads h and b. Coach rows whose
  // coach_id is h: s (active seat under h), x (removed: seat under h archived,
  // a delegation from h left open), l (never seated, open delegation from h),
  // p (coach_id only, nothing else), m (seat under h archived, active seat
  // under b). Clients of h: ch and ch2, plus cx and cl for the delegations.
  const [h, b, s, x, l, p, m, ch, ch2, cx, cl] = Array.from({ length: 11 }, () => randomUUID());
  const students = new Set([ch, ch2, cx, cl]);
  const ids: Record<string, string> = {};

  /** Runs `fn` in one transaction as the API role `authenticated`, signed in as `who`. */
  const asUser = <T>(who: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, students.has(who) ? 'student' : 'coach');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return fn(tx);
    });
  /** Rows with this id that `who` reads in `table`. */
  const seen = async (table: string, rowId: string, who: string): Promise<number> => {
    const [{ n }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table}" WHERE "id" = $1`, rowId));
    return n;
  };
  /** app.is_subcoach_on_coach_team(head) as `who`. */
  const onTeam = async (who: string, head: string): Promise<boolean> => {
    const [{ t }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ t: boolean }[]>('SELECT app.is_subcoach_on_coach_team($1) AS t', head));
    return t;
  };
  /** Rows `who` changes with this statement ($1 = row id). */
  const changed = (who: string, sql: string, rowId: string) => asUser(who, (tx) => tx.$executeRawUnsafe(sql, rowId));
  const insertProgram = (who: string, coach: string, id = randomUUID()) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO public."WorkoutProgram" ("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
       VALUES ($1, $2, $3, 'tenant_shared', 'RLS shared', 4, 3, now())`, id, coach, who)).then(() => id);
  const insertProgramRevision = (who: string, programId: string) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO public."WorkoutProgramRevision" ("id","program_id","revision_index","structure_json","author_id","author_kind","cause")
       VALUES ($1, $2, 99, '{}'::jsonb, $3, 'coach', 'save')`, randomUUID(), programId, who));
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
    const people: Array<[string, 'coach' | 'student', string | null]> = [
      [h, 'coach', null], [b, 'coach', null], [s, 'coach', h], [x, 'coach', h], [l, 'coach', h], [p, 'coach', h],
      [m, 'coach', h], [ch, 'student', h], [ch2, 'student', h], [cx, 'student', h], [cl, 'student', h],
    ];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    const archived = new Date('2027-04-01');
    for (const [head, sub, archived_at] of [[h, s, null], [h, x, archived], [h, m, archived], [b, m, null]] as const) {
      await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: head, sub_coach_id: sub, archived_at } });
    }
    for (const [sub, client] of [[x, cx], [l, cl]]) {
      await prisma.subCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: sub, client_id: client } });
    }
    // Shared library rows: h's and b's masters, and one x published into h's tenant while seated.
    for (const [key, coach, owner] of [['Ph', h, h], ['Pb', b, b], ['Px', h, x]]) {
      const program = await prisma.workoutProgram.create({
        data: { coach_id: coach, owner_user_id: owner, visibility: 'tenant_shared', name: 'RLS shared', weeks: 4, days_per_week: 3 },
      });
      ids[key] = program.id;
      ids[`R${key}`] = (await prisma.workoutProgramRevision.create({
        data: { program_id: program.id, revision_index: 1, structure_json: {}, author_id: owner, author_kind: 'coach', cause: 'save' },
      })).id;
    }
    ids.plan = (await prisma.workoutPlan.create({ data: { coach_id: h, name: 'RLS plan', type: 'strength' } })).id;
    ids.planRevision = (await prisma.workoutPlanRevision.create({
      data: { workout_plan_id: ids.plan, revision_index: 1, exercises_json: [], plan_meta_json: {}, author_id: h, author_kind: 'coach', cause: 'save' },
    })).id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."community_workspaces" ("id","coach_id","name","slug","updated_at") VALUES ($1::uuid, $2, 'RLS team', $3, now())`,
      randomUUID(), h, `rls-${randomUUID()}`);
    ids.win = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."CommunityWin" ("id","user_id","coach_id","title","description") VALUES ($1, $2, $3, 'RLS win', 'RLS win')`,
      ids.win, ch, h);
  });
  afterAll(() => prisma.$disconnect());

  it('down.sql brings back the bare coach_id grant on this data; the migration takes it away again', async () => {
    await runSql('down.sql');
    expect(await onTeam(x, h)).toBe(true);
    expect(await onTeam(p, h)).toBe(true);
    expect(await onTeam(m, b)).toBe(false);
    expect(await seen('WorkoutProgram', ids.Ph, x)).toBe(1);
    expect(await seen('CommunityWin', ids.win, x)).toBe(1);
    expect(await seen('WorkoutProgram', ids.Pb, m)).toBe(0);
    await runSql('migration.sql');
    expect(await seen('WorkoutProgram', ids.Ph, s)).toBe(1);
    expect(await seen('WorkoutProgram', ids.Ph, x)).toBe(0);
    expect(await seen('CommunityWin', ids.win, x)).toBe(0);
    expect(await seen('WorkoutProgram', ids.Pb, m)).toBe(1);
  });

  it('team membership is judged per head coach: a seat, or a never-seated pair with an open delegation', async () => {
    expect(await onTeam(s, h)).toBe(true);
    expect(await onTeam(l, h)).toBe(true);
    expect(await onTeam(m, b)).toBe(true);
    // Removed (even with a delegation left open), coach_id only, removed from h but seated under b.
    expect(await onTeam(x, h)).toBe(false);
    expect(await onTeam(p, h)).toBe(false);
    expect(await onTeam(m, h)).toBe(false);
    // The head coach, the other team's head coach, a client and an unseated coach on the other team.
    for (const who of [h, b, ch]) expect(await onTeam(who, h)).toBe(false);
    for (const who of [s, x, l, p]) expect(await onTeam(who, b)).toBe(false);
  });

  it('shared programs: the head, a seated and a legacy sub-coach read them; a removed, coach_id-only, other-team or client caller reads none', async () => {
    for (const who of [h, s, l]) expect(await seen('WorkoutProgram', ids.Ph, who)).toBe(1);
    for (const who of [x, p, m, b, ch]) expect(await seen('WorkoutProgram', ids.Ph, who)).toBe(0);
    // A sub-coach on two teams keeps the team they are still seated on.
    for (const who of [b, m]) expect(await seen('WorkoutProgram', ids.Pb, who)).toBe(1);
    for (const who of [h, s, x]) expect(await seen('WorkoutProgram', ids.Pb, who)).toBe(0);
  });

  it('a removed sub-coach no longer reads the program they shared into the head coach\'s library', async () => {
    expect(await seen('WorkoutProgram', ids.Px, s)).toBe(1);
    expect(await seen('WorkoutProgram', ids.Px, x)).toBe(0);
  });

  it('program revisions follow their program', async () => {
    for (const who of [h, s, l]) expect(await seen('WorkoutProgramRevision', ids.RPh, who)).toBe(1);
    for (const who of [x, p, m, b, ch]) expect(await seen('WorkoutProgramRevision', ids.RPh, who)).toBe(0);
    for (const who of [b, m]) expect(await seen('WorkoutProgramRevision', ids.RPb, who)).toBe(1);
    expect(await seen('WorkoutProgramRevision', ids.RPb, s)).toBe(0);
    expect(await seen('WorkoutProgramRevision', ids.RPx, s)).toBe(1);
    expect(await seen('WorkoutProgramRevision', ids.RPx, x)).toBe(0);
  });

  it('writes: the head and a seated sub-coach can; a removed sub-coach inserts, updates and deletes nothing', async () => {
    const touch = 'UPDATE public."WorkoutProgram" SET "name" = "name" WHERE "id" = $1';
    const remove = 'DELETE FROM public."WorkoutProgram" WHERE "id" = $1';
    expect(await changed(h, touch, ids.Ph)).toBe(1);
    const ps = await insertProgram(s, h);
    expect(await seen('WorkoutProgram', ps, s)).toBe(1);
    await expect(insertProgramRevision(s, ps)).resolves.toBe(1);
    // x: the head's row and x's own row in the head's tenant.
    for (const row of [ids.Ph, ids.Px]) {
      expect(await changed(x, touch, row)).toBe(0);
      expect(await changed(x, remove, row)).toBe(0);
    }
    expect(await changed(s, touch, ids.Px)).toBe(0); // not s's row: owner-only writes, unchanged
    await expect(insertProgram(x, h)).rejects.toThrow(RLS);
    await expect(insertProgram(p, h)).rejects.toThrow(RLS);
    await expect(insertProgramRevision(x, ids.Px)).rejects.toThrow(RLS);
    expect(await prisma.workoutProgram.count({ where: { id: { in: [ids.Ph, ids.Px] } } })).toBe(2);
    // x still writes into their own tenant.
    const own = await insertProgram(x, x);
    expect(await seen('WorkoutProgram', own, x)).toBe(1);
  });

  it('plan revisions: only the plan\'s coach, as before (sub-coaches never saw the head coach\'s WorkoutPlan rows)', async () => {
    expect(await seen('WorkoutPlan', ids.plan, h)).toBe(1);
    expect(await seen('WorkoutPlanRevision', ids.planRevision, h)).toBe(1);
    for (const who of [s, x, p]) expect(await seen('WorkoutPlanRevision', ids.planRevision, who)).toBe(0);
    const write = (who: string) => asUser(who, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO public."WorkoutPlanRevision" ("id","workout_plan_id","revision_index","exercises_json","plan_meta_json","author_id","author_kind","cause")
       VALUES ($1, $2, 99, '[]'::jsonb, '{}'::jsonb, $3, 'coach', 'save')`, randomUUID(), ids.plan, who));
    await expect(write(x)).rejects.toThrow(RLS);
    await expect(write(h)).resolves.toBe(1);
  });

  it('community wins: a seated sub-coach and the author\'s teammates still see the win; a removed or coach_id-only coach does not', async () => {
    for (const who of [ch2, s]) expect(await seen('CommunityWin', ids.win, who)).toBe(1);
    for (const who of [x, p, m]) expect(await seen('CommunityWin', ids.win, who)).toBe(0);
  });
});
