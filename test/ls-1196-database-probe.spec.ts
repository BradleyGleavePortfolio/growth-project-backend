/**
 * LS-1196 independent review evidence, never merge this test branch.
 * Starts the runner's local Postgres; uses peer authentication, no secrets.
 * Only the touched generated table cluster is materialized. This is a DDL
 * and real-Prisma service probe, not a substitute for the required RLS lane.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { userInfo } from 'os';
import { resolve } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { PtmService } from '../src/ptm/ptm.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WorkoutService } from '../src/workout/workout.service';
import type { CreateWorkoutDto } from '../src/workout/workout.dto';

function stub<T>(value: unknown): T { return value as T; }

const root = resolve(__dirname, '..');
const migration = 'prisma/migrations/20270502010500_workout_session_client_key/';
const up = readFileSync(resolve(root, migration, 'migration.sql'), 'utf8');
const down = readFileSync(resolve(root, migration, 'down.sql'), 'utf8');
const database = 'ls_1196_review';
const username = userInfo().username;
let prisma: PrismaClient;
let baseSql: string;

function admin(sql: string) {
  return execFileSync('sudo', ['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
  });
}

function sql(statement: string) {
  return execFileSync('psql', ['-h', '/var/run/postgresql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], {
    encoding: 'utf8',
  });
}

beforeAll(async () => {
  execFileSync('sudo', ['systemctl', 'start', 'postgresql']);
  if (admin(`SELECT count(*) FROM pg_roles WHERE rolname = '${username}'`).trim() === '0') {
    admin(`CREATE ROLE "${username}" LOGIN SUPERUSER`);
  }
  admin(`DROP DATABASE IF EXISTS "${database}"`);
  admin(`CREATE DATABASE "${database}" OWNER "${username}"`);
  const ddl = execFileSync('npx', [
    'prisma', 'migrate', 'diff', '--from-empty',
    '--to-schema-datamodel', resolve(root, 'prisma/schema.prisma'), '--script',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const statements = ddl.split(/;\s*\n/).map((s) =>
    s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim(),
  );
  const cluster = statements.filter((s) =>
    /^CREATE TYPE "(Intensity|MuscleGroup)"/.test(s) ||
    /^CREATE TABLE "(WorkoutSession|ExerciseSet)"/.test(s),
  );
  expect(cluster).toHaveLength(4);
  baseSql = `CREATE TABLE "User" ("id" TEXT PRIMARY KEY);\n` +
    cluster.map((s) => s.replace(/^\s*"client_key" TEXT,?\s*$/m, '') + ';').join('\n') +
    `\nALTER TABLE "WorkoutSession" ADD FOREIGN KEY ("user_id") REFERENCES "User"("id");
     ALTER TABLE "ExerciseSet" ADD FOREIGN KEY ("workout_id") REFERENCES "WorkoutSession"("id");`;
  expect(baseSql).not.toMatch(/"client_key"/);
  prisma = new PrismaClient({
    datasources: { db: { url: `postgresql://${encodeURIComponent(username)}@localhost/${database}?host=/var/run/postgresql` } },
  });
  await prisma.$connect();
}, 120000);

beforeEach(() => {
  sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  sql(baseSql);
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  admin(`DROP DATABASE IF EXISTS "${database}"`);
});

describe('LS-1196 actual migration and real database behavior', () => {
  it('forward/down/forward preserves existing workouts and sets and restores nullable per-user uniqueness', async () => {
    sql(`INSERT INTO "User" VALUES ('member-a'), ('member-b');
      INSERT INTO "WorkoutSession" ("id", "user_id", "date", "workout_name", "workout_type")
        VALUES ('before', 'member-a', CURRENT_DATE, 'Before migration', 'strength');
      INSERT INTO "ExerciseSet" ("id", "workout_id", "exercise_name", "muscle_group", "sets_completed", "reps_per_set", "weight_per_set")
        VALUES ('before-set', 'before', 'Bench', 'chest', 1, ARRAY[8], ARRAY[100.0]);`);
    sql(up);
    expect(await prisma.workoutSession.findUnique({ where: { id: 'before' }, include: { exercises: true } }))
      .toMatchObject({ client_key: null, exercises: [{ id: 'before-set', reps_per_set: [8], weight_per_set: [100] }] });
    const create = (user: string, key: string | null) => prisma.workoutSession.create({
      data: { user_id: user, client_key: key, date: new Date(), workout_name: 'Check', workout_type: 'strength' },
    });
    await create('member-a', null);
    await create('member-a', null);
    await create('member-a', 'member-key-1');
    await create('member-b', 'member-key-1');
    await expect(create('member-a', 'member-key-1')).rejects.toMatchObject({ code: 'P2002' });
    sql(down);
    expect(sql(`SELECT count(*) FROM information_schema.columns WHERE table_name='WorkoutSession' AND column_name='client_key'`).trim()).toBe('0');
    expect(sql(`SELECT count(*) FROM "WorkoutSession"`).trim()).toBe('5');
    expect(sql(`SELECT count(*) FROM "ExerciseSet"`).trim()).toBe('1');
    sql(up);
    expect(await prisma.workoutSession.count({ where: { client_key: null } })).toBe(5);
    await create('member-a', 'member-key-1');
    await expect(create('member-a', 'member-key-1')).rejects.toMatchObject({ code: 'P2002' });
  }, 30000);

  it('two requests forced past the lookup get the same full workout after a real P2002 with no extra signal', async () => {
    sql(up);
    sql(`INSERT INTO "User" VALUES ('member-a'), ('member-b');`);
    const emit = jest.fn();
    const invalidateForUser = jest.fn();
    const service = new WorkoutService(
      stub<PrismaService>(prisma), stub<PtmService>({ emit }),
      stub<ClientAIContextService>({ invalidateForUser }),
    );
    const body: CreateWorkoutDto = {
      workout_name: 'Real race', workout_type: 'strength', duration_minutes: 20,
      exercises: [{
        exercise_name: 'Bench', muscle_group: 'chest', sets_completed: 1,
        reps_per_set: [8], weight_per_set: [100],
      }],
    };
    let reads = 0;
    let release: () => void = () => undefined;
    const bothRead = new Promise<void>((r) => { release = r; });
    const originalFind = prisma.workoutSession.findUnique.bind(prisma.workoutSession);
    const originalCreate = prisma.workoutSession.create.bind(prisma.workoutSession);
    let realConflicts = 0;
    const findSpy = jest.spyOn(prisma.workoutSession, 'findUnique').mockImplementation(async (args) => {
      const result = await originalFind(args);
      reads += 1;
      if (reads <= 2) {
        expect(result).toBeNull();
        if (reads === 2) release();
        await bothRead;
      }
      return result;
    });
    const createSpy = jest.spyOn(prisma.workoutSession, 'create').mockImplementation(async (args) => {
      try { return await originalCreate(args); } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') realConflicts += 1;
        throw error;
      }
    });
    let first;
    let second;
    try {
      [first, second] = await Promise.all([
        service.createWorkout('member-a', body, 'same-queue-key'),
        service.createWorkout('member-a', body, 'same-queue-key'),
      ]);
    } finally {
      findSpy.mockRestore();
      createSpy.mockRestore();
    }
    expect(realConflicts).toBe(1);
    expect(second).toEqual(first);
    expect(second.exercises).toHaveLength(1);
    expect(await service.getWorkouts('member-a')).toHaveLength(1);
    expect(await service.getVolume('member-a')).toEqual([{ muscle_group: 'chest', total_volume: 800, period: 'week' }]);
    expect(await prisma.exerciseSet.count()).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(invalidateForUser).toHaveBeenCalledTimes(1);
    const theirs = await service.createWorkout('member-b', body, 'same-queue-key');
    expect(theirs.user_id).toBe('member-b');
    expect(theirs.id).not.toBe(first.id);
    await service.createWorkout('member-a', body);
    await service.createWorkout('member-a', body);
    await service.createWorkout('member-a', body, 'different-queue-key');
    expect(await service.getWorkouts('member-a')).toHaveLength(4);
  }, 30000);
});
