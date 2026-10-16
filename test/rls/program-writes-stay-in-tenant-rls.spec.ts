/**
 * PROGINSERT: a program is written only into a tenant its writer belongs to.
 * Migration 20270422000000_program_writes_stay_in_tenant adds two RESTRICTIVE
 * policies on WorkoutProgram: an insert, and an update (before and after the
 * change), pass only for an owner admin, a row in the writer's own tenant, or
 * a member of the tenant coach's team (app.is_subcoach_on_coach_team).
 * Reads and writes run as the API role `authenticated` (no RLS bypass) on the
 * replayed migration chain. Every zero has a control (a read of 1 of the same
 * row by its owner, or a count of 1 on the superuser connection), so a zero
 * means the rule refused the row, not that it is missing. The first case runs
 * down.sql to show the old hole on this data, then re-applies the migration.
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
  throw new Error('program-writes-stay-in-tenant-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATION = '20270422000000_program_writes_stay_in_tenant';
const RLS = /row-level security/;

(DB_URL ? describe : describe.skip)('PROGINSERT: a program is written only into a tenant its writer belongs to', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  // Fictional people, fresh ids per run. Head coaches h and b. s: a coach
  // seated on h's team. p: a coach whose coach_id is h with no seat and no
  // delegation (an old guest checkout). ch: h's client. cb: b's client.
  // o: an owner admin.
  const [h, b, s, p, ch, cb, o] = Array.from({ length: 7 }, () => randomUUID());
  const roleOf: Record<string, string> = { [ch]: 'student', [cb]: 'student', [o]: 'owner' };
  let hOwn = '';

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
      tx.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM public."WorkoutProgram" WHERE "id" = $1', rowId));
    return n;
  };
  /** app.is_subcoach_on_coach_team(head) as `who`. */
  const onTeam = async (who: string, head: string): Promise<boolean> => {
    const [{ t }] = await asUser(who, (tx) =>
      tx.$queryRawUnsafe<{ t: boolean }[]>('SELECT app.is_subcoach_on_coach_team($1) AS t', head));
    return t;
  };
  /** `who` inserts an owner_only program owned by `owner` into tenant `coach`; resolves to its id. */
  const insertProgram = (who: string, coach: string, owner = who, id = randomUUID()) =>
    asUser(who, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO public."WorkoutProgram" ("id","coach_id","owner_user_id","visibility","name","weeks","days_per_week","updated_at")
       VALUES ($1, $2, $3, 'owner_only', 'RLS program', 4, 3, now())`, id, coach, owner)).then(() => id);
  /** Rows `who` renames (a plain edit). */
  const rename = (who: string, rowId: string) => asUser(who, (tx) =>
    tx.$executeRawUnsafe(`UPDATE public."WorkoutProgram" SET "name" = 'RLS renamed' WHERE "id" = $1`, rowId));
  /** `who` moves their row into tenant `coach`. */
  const move = (who: string, rowId: string, coach: string) => asUser(who, (tx) =>
    tx.$executeRawUnsafe(`UPDATE public."WorkoutProgram" SET "coach_id" = $2 WHERE "id" = $1`, rowId, coach));
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
      [h, 'coach', null], [b, 'coach', null], [s, 'coach', h], [p, 'coach', h],
      [ch, 'student', h], [cb, 'student', b], [o, 'owner', null],
    ];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'RLS person', role, coach_id } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: s } });
    hOwn = (await prisma.workoutProgram.create({
      data: { coach_id: h, owner_user_id: h, visibility: 'owner_only', name: 'RLS program', weeks: 4, days_per_week: 3 },
    })).id;
  });
  afterAll(() => prisma.$disconnect());

  it('down.sql brings back the hole on this data; the migration closes it again', async () => {
    await runSql('down.sql');
    const planted = await insertProgram(b, h);
    expect(await seen(planted, b)).toBe(1);
    expect(await rename(b, planted)).toBe(1);
    await expect(insertProgram(ch, h)).resolves.toBeDefined();
    await runSql('migration.sql');
    await expect(insertProgram(b, h)).rejects.toThrow(RLS);
    await expect(insertProgram(ch, h)).rejects.toThrow(RLS);
    // A row planted before the fix stays (no data change) but its planter can no longer edit it.
    expect(await prisma.workoutProgram.count({ where: { id: planted } })).toBe(1);
    expect(await rename(b, planted)).toBe(0);
  });

  it("another coach or a client cannot insert a program into a coach's tenant", async () => {
    const tried = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await expect(insertProgram(b, h, b, tried[0])).rejects.toThrow(RLS);
    await expect(insertProgram(ch, h, ch, tried[1])).rejects.toThrow(RLS);
    await expect(insertProgram(cb, h, cb, tried[2])).rejects.toThrow(RLS);
    // A client cannot add one to their own coach's tenant either.
    await expect(insertProgram(cb, b, cb, tried[3])).rejects.toThrow(RLS);
    expect(await prisma.workoutProgram.count({ where: { id: { in: tried } } })).toBe(0);
  });

  it("nobody moves their own program into another coach's tenant", async () => {
    for (const who of [b, ch]) {
      const own = await insertProgram(who, who);
      expect(await seen(own, who)).toBe(1);
      await expect(move(who, own, h)).rejects.toThrow(RLS);
      expect((await prisma.workoutProgram.findUnique({ where: { id: own } }))?.coach_id).toBe(who);
    }
  });

  it("another coach or a client cannot read a coach's owner-only program", async () => {
    expect(await seen(hOwn, h)).toBe(1);
    for (const who of [b, s, p, ch, cb]) expect(await seen(hOwn, who)).toBe(0);
  });

  it("the head coach, a seated sub-coach and an owner admin still write into the head coach's tenant", async () => {
    expect(await rename(h, hOwn)).toBe(1);
    const mine = await insertProgram(h, h);
    expect(await seen(mine, h)).toBe(1);
    // A seated sub-coach's fork lands in the head coach's tenant and stays theirs alone.
    const fork = await insertProgram(s, h);
    expect(await seen(fork, s)).toBe(1);
    expect(await rename(s, fork)).toBe(1);
    for (const who of [b, ch, cb]) expect(await seen(fork, who)).toBe(0);
    const admin = await insertProgram(o, h, h);
    expect(await seen(admin, h)).toBe(1);
  });

  it('everyone still writes into their own tenant (a coachless client included)', async () => {
    for (const who of [b, ch, p]) {
      const own = await insertProgram(who, who);
      expect(await seen(own, who)).toBe(1);
      expect(await rename(who, own)).toBe(1);
    }
  });

  it('a bare coach_id is judged by the shared team helper, never by this rule alone', async () => {
    // p has coach_id = h and nothing else. On main the helper still trusts a
    // bare coach_id; #980 makes it judge real membership. The write rule
    // follows the helper in either merge order (the API refuses p already).
    const admitted = await insertProgram(p, h).then(
      () => true,
      (err: unknown) => {
        if (!RLS.test(String(err))) throw err;
        return false;
      },
    );
    expect(admitted).toBe(await onTeam(p, h));
    expect(await onTeam(s, h)).toBe(true);
    for (const who of [b, ch, cb]) expect(await onTeam(who, h)).toBe(false);
  });
});
