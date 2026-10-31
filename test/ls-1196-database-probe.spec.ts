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
import { ExerciseCatalogService } from '../src/exercise-catalog/exercise-catalog.service';
import { ExerciseCatalogController } from '../src/exercise-catalog/exercise-catalog.controller';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import type { MuxService } from '../src/video/mux.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { Test } from '@nestjs/testing';
import { ExecutionContext, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { WorkoutController } from '../src/workout/workout.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { CoachService } from '../src/coach/coach.service';
import type { AuditService } from '../src/audit/audit.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';

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
    /^CREATE TYPE "(Intensity|MuscleGroup|WorkoutPlanType|ExerciseVideoStatus)"/.test(s) ||
    /^CREATE TABLE "(WorkoutSession|ExerciseSet|WorkoutPlan|WorkoutPlanExercise|ClientWorkoutAssignment|ClientWorkoutAssignmentSnapshot|ExerciseCatalogItem)"/.test(s),
  );
  expect(cluster).toHaveLength(11);
  baseSql = `CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT DEFAULT 'Review member', "coach_id" TEXT DEFAULT 'coach-a', "archived_at" TIMESTAMP(3));\n` +
    cluster.map((s) => s.replace(/^\s*"client_key" TEXT,?\s*$/m, '') + ';').join('\n') +
    `\nALTER TABLE "WorkoutSession" ADD FOREIGN KEY ("user_id") REFERENCES "User"("id");
     ALTER TABLE "ExerciseSet" ADD FOREIGN KEY ("workout_id") REFERENCES "WorkoutSession"("id");
     CREATE UNIQUE INDEX "ClientWorkoutAssignmentSnapshot_assignment_id_key" ON "ClientWorkoutAssignmentSnapshot"("assignment_id");
     CREATE TABLE "WorkoutComment" ("id" TEXT PRIMARY KEY, "workout_id" TEXT, "coach_id" TEXT, "body" TEXT, "updated_at" TIMESTAMP(3));`;
  expect(baseSql).not.toMatch(/"client_key"/);
  prisma = new PrismaClient({
    datasources: { db: { url: `postgresql://${encodeURIComponent(username)}@localhost/${database}?host=/var/run/postgresql` } },
  });
  await prisma.$connect();
}, 120000);

beforeEach(async () => {
  await prisma.$disconnect();
  sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  sql(baseSql);
  await prisma.$connect();
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

  it('actual relation predicates honor all snapshot and legacy identities and refuse absent or foreign prescriptions', async () => {
    const row = await prisma.exerciseCatalogItem.create({ data: {
      id: 'review-catalog', slug: 'review-bench', source_ref: 'seed:review-bench',
      name: 'Review Bench', category: 'push', primary_muscle: 'chest',
      mux_playback_id: 'review-video', mux_playback_policy: 'signed', mux_asset_status: 'ready',
    } });
    const refs = [row.id, row.slug, row.source_ref!];
    const mintPlaybackUrl = jest.fn(() => 'review-signed-playback');
    const controller = new ExerciseCatalogController(new ExerciseCatalogService(
      stub<PrismaService>(prisma), stub<MuxService>({ mintPlaybackUrl }),
    ));
    const request = stub<AuthedRequest>({ user: { id: 'member-a', role: 'student' } });
    const scenarios = [
      ...refs.flatMap((ref) => [
        { label: `frozen ${ref} removed from current plan`, frozen: [ref], live: 'unassigned', archived: null, member: 'member-a', allowed: true },
        { label: `legacy ${ref} live`, frozen: null, live: ref, archived: null, member: 'member-a', allowed: true },
        { label: `foreign frozen ${ref}`, frozen: [ref], live: ref, archived: null, member: 'member-b', allowed: false },
        { label: `legacy archived ${ref}`, frozen: null, live: ref, archived: new Date(), member: 'member-a', allowed: false },
      ]),
      { label: 'new live but not frozen', frozen: ['unassigned'], live: row.id, archived: null, member: 'member-a', allowed: false },
      { label: 'archived but not frozen', frozen: ['unassigned'], live: row.id, archived: new Date(), member: 'member-a', allowed: false },
      { label: 'empty snapshot never falls back to live', frozen: [], live: row.id, archived: null, member: 'member-a', allowed: false },
    ];
    const exercise = (ref: string) => ({
      exercise_external_id: ref, order: 1, sets: 3, reps_or_duration_seconds: 8,
    });
    for (const scenario of scenarios) {
      sql(`TRUNCATE "ClientWorkoutAssignmentSnapshot", "ClientWorkoutAssignment", "WorkoutPlanExercise", "WorkoutPlan";`);
      const plan = await prisma.workoutPlan.create({ data: {
        coach_id: 'coach-a', name: scenario.label, type: 'strength',
      } });
      await prisma.workoutPlanExercise.create({ data: {
        workout_plan_id: plan.id, ...exercise(scenario.live), archived_at: scenario.archived,
      } });
      const assignment = await prisma.clientWorkoutAssignment.create({ data: {
        workout_plan_id: plan.id, client_id: scenario.member, assigned_by_coach_id: 'coach-a', scheduled_for: new Date(),
      } });
      if (scenario.frozen !== null) {
        await prisma.clientWorkoutAssignmentSnapshot.create({ data: {
          assignment_id: assignment.id, plan_name: plan.name, plan_type: plan.type,
          source_plan_id: plan.id, source_version: 1, exercises_json: scenario.frozen.map(exercise),
        } });
      }
      const loaded = await prisma.clientWorkoutAssignment.findUniqueOrThrow({
        where: { id: assignment.id },
        include: { snapshot: true, workout_plan: { include: { exercises: { where: { archived_at: null } } } } },
      });
      const presented = WorkoutBuilderService.prototype['presentAssignment'](loaded);
      expect(presented.exercises.map((e) => stub<{ exercise_external_id: string }>(e).exercise_external_id))
        .toEqual(scenario.frozen ?? (scenario.archived ? [] : [scenario.live]));
      for (const lookup of refs) {
        mintPlaybackUrl.mockClear();
        const response = await controller.detail(lookup, request);
        expect({ label: scenario.label, lookup, allowed: response.playbackUrl !== null })
          .toEqual({ label: scenario.label, lookup, allowed: scenario.allowed });
        expect(mintPlaybackUrl).toHaveBeenCalledTimes(scenario.allowed ? 1 : 0);
      }
    }
    sql(`TRUNCATE "ClientWorkoutAssignmentSnapshot", "ClientWorkoutAssignment";`);
    expect((await controller.detail(row.id, request)).playbackUrl).toBeNull();
    await expect(controller.detail('missing-catalog-row', request)).rejects.toMatchObject({ status: 404 });
    expect((await controller.detail(row.id, stub<AuthedRequest>({ user: { id: 'staff', role: 'coach' } }))).playbackUrl)
      .toBe('review-signed-playback');
    await prisma.exerciseCatalogItem.update({ where: { id: row.id }, data: { mux_playback_policy: 'public' } });
    expect((await controller.detail(row.id, request)).playbackUrl).toBe('review-signed-playback');
    await prisma.exerciseCatalogItem.update({ where: { id: row.id }, data: { mux_playback_policy: 'signed' } });
    const assignments = Array.from({ length: 101 }, (_, i) => ({
      id: `page-assignment-${i}`, workout_plan_id: 'page-plan', client_id: 'member-a',
      assigned_by_coach_id: 'coach-a', scheduled_for: new Date(),
    }));
    await prisma.clientWorkoutAssignment.createMany({ data: assignments });
    await prisma.clientWorkoutAssignmentSnapshot.createMany({ data: assignments.map((a, i) => ({
      assignment_id: a.id, source_plan_id: 'page-plan', source_version: 1,
      plan_name: 'Page proof', plan_type: 'strength',
      exercises_json: [exercise(i === 100 ? row.source_ref! : `unassigned-page-${i}`)],
    })) });
    expect(await prisma.clientWorkoutAssignment.count()).toBe(101);
    expect((await controller.detail(row.source_ref!, request)).playbackUrl).toBe('review-signed-playback');
    await prisma.exerciseCatalogItem.update({ where: { id: row.id }, data: { mux_playback_policy: 'signed', mux_asset_status: 'processing' } });
    expect((await controller.detail(row.id, request)).playbackUrl).toBeNull();
  }, 60000);

  it('HTTP header replay remains a readable 201 success and the real coach timeline reads one workout', async () => {
    sql(up);
    sql(`INSERT INTO "User" ("id") VALUES ('member-a'), ('member-b');`);
    const service = new WorkoutService(
      stub<PrismaService>(prisma), stub<PtmService>({ emit: jest.fn() }),
      stub<ClientAIContextService>({ invalidateForUser: jest.fn() }),
    );
    const module = await Test.createTestingModule({
      controllers: [WorkoutController],
      providers: [{ provide: WorkoutService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest<AuthedRequest>().user = stub<AuthedRequest['user']>({ id: 'member-a', role: 'student' });
        return true;
      } })
      .overrideGuard(ClientEntitlementGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    try {
      const body = {
        date: new Date().toISOString().slice(0, 10), workout_name: 'HTTP replay',
        workout_type: 'strength', duration_minutes: 20,
        exercises: [{ exercise_name: 'Bench', muscle_group: 'chest', sets_completed: 1, reps_per_set: [8], weight_per_set: [100] }],
      };
      const post = (key?: string) => {
        const req = request(app.getHttpServer()).post('/workouts');
        return key === undefined ? req.send(body) : req.set('Idempotency-Key', key).send(body);
      };
      const first = await post('http-queue-key').expect(201);
      const again = await post('http-queue-key').expect(201);
      expect(again.body).toEqual(first.body);
      expect(typeof again.body.id).toBe('string');
      expect(again.body.id.length).toBeGreaterThan(0);
      expect(again.body.exercises).toHaveLength(1);
      const coach = new CoachService(
        stub<PrismaService>(prisma), stub<AuditService>({ write: jest.fn().mockResolvedValue(undefined) }),
        stub<ConsentService>({ coachCanAccess: jest.fn(async (_coach: string, _client: string, scope: string) =>
          scope === ConsentScope.FITNESS_WORKOUTS) }),
      );
      const timeline = await coach.getClientTimeline('coach-a', 'member-a', 90, 'coach');
      expect(timeline).toMatchObject({ workouts: [{ id: first.body.id }] });
      expect('workouts' in timeline && timeline.workouts).toHaveLength(1);
      await post('short').expect(400);
      expect(await prisma.workoutSession.count()).toBe(1);
      await post().expect(201);
      await post().expect(201);
      expect(await prisma.workoutSession.count()).toBe(3);
    } finally {
      await app.close();
    }
  }, 60000);
});
