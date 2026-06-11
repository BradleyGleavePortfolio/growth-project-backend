/**
 * Community v2-1 plan-context tags — end-to-end spec.
 *
 * Mirrors community-messages.e2e.spec.ts: boots the real Nest HTTP layer for
 * the messages + plan-context controllers wired to the real PrismaService,
 * drives it over Node's http against a live disposable Postgres, and stubs ONLY
 * JwtAuthGuard (header-driven). RolesGuard, CommunityFeatureFlagGuard and the
 * message write kill switch all run for real.
 *
 * GATE INTENT (R66): env-gated on COMMUNITY_TEST_DATABASE_URL. Unset → the
 * whole block is describe.skip-ed with a logged reason (never a silent pass).
 *
 * Covers (brief §Hard gates / §Tests required):
 *  - send with valid plan_context (flag ON) → persisted + echoed back
 *  - send with plan_context (flag OFF) → field dropped (send still 201)
 *  - foreign-coach workout_plan_id → 403
 *  - non-existent workout_plan_id → 422
 *  - malformed plan_context shape → 422
 *  - GET /community/plan-context/resolve per type → snapshot
 *  - resolve foreign id → 404 (existence non-leak)
 *  - resolve flag OFF → 404 across the board
 */

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import * as http from 'http';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { CommunityMessagesController } from '../../src/community/messages/community-messages.controller';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { PlanContextController } from '../../src/community/plan-context/plan-context.controller';
import { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import { PlanContextRepository } from '../../src/community/plan-context/plan-context.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { CommunityMessagesEnabledGuard } from '../../src/community/community-write-flag.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import type { CommunityMessageResponse } from '../../src/community/dto/community-message.dto';
import type { ResolvePlanContextResponse } from '../../src/community/plan-context/plan-context.dto';
import { liveDbUrl } from './_support/community-db';

const itLive = liveDbUrl() ? describe : describe.skip;

/**
 * Parsed JSON body returned by the plan-context HTTP endpoints under test.
 * Success responses are either a created/echoed message envelope or a resolve
 * snapshot envelope; error responses carry a stable `code` discriminator. A
 * single helper drives every endpoint and JSON.parse hands back an untyped
 * value, so this composite envelope lets each assertion read the fields its
 * endpoint returns without per-call casts.
 */
type PlanContextResponseBody = CommunityMessageResponse &
  ResolvePlanContextResponse & { code: string };

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-plan-context] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.',
  );
}

const H_USER = 'x-test-user-id';

interface HttpResult {
  status: number;
  body: PlanContextResponseBody;
}

itLive('community v2-1 plan-context tags (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    coachB: '',
    studentA: '',
    wsA: '',
    cohortA: '',
    planA: '',
    exerciseA: '',
    planB: '',
    mealA: '',
    packageA: '',
    checkInA: '',
  };

  class StubJwtAuthGuard implements CanActivate {
    constructor(private readonly p: PrismaService) {}
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const req = ctx.switchToHttp().getRequest();
      const userId = req.headers[H_USER] as string | undefined;
      if (!userId) throw new UnauthorizedException();
      const rows = await this.p.$queryRaw<
        Array<{ id: string; role: string; coach_id: string | null }>
      >`SELECT id, role, coach_id FROM "User" WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) throw new UnauthorizedException();
      req.user = user;
      return true;
    }
  }

  function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const h: Record<string, string> = { ...headers };
      if (payload !== undefined) {
        h['content-type'] = 'application/json';
        h['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(
        `${baseUrl}${path}`,
        { method, headers: h },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            // JSON.parse hands back an untyped value, which assigns cleanly to
            // the composite PlanContextResponseBody envelope (no cast). Every
            // cohort endpoint under test answers with a JSON body, so an empty
            // or non-JSON payload falls back to an empty envelope.
            let parsed: PlanContextResponseBody = JSON.parse('{}');
            try {
              if (data.length) parsed = JSON.parse(data);
            } catch {
              parsed = JSON.parse('{}');
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const asUser = (id: string) => ({ [H_USER]: id });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = liveDbUrl() as string;
    process.env.FEATURE_COMMUNITY_API = 'true';
    process.env.FEATURE_COMMUNITY_MESSAGES = 'true';
    process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityMessagesController, PlanContextController],
      providers: [
        CommunityMessagesService,
        CommunityMessagesRepository,
        PlanContextService,
        PlanContextRepository,
        CommunityAccessService,
        CommunityFeatureFlagGuard,
        CommunityMessagesEnabledGuard,
        CommunityRealtimeService,
        SupabaseService,
        AnalyticsService,
        Reflector,
        { provide: PrismaService, useValue: prismaForStub },
        { provide: APP_GUARD, useValue: new StubJwtAuthGuard(prismaForStub) },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtAuthGuard(prismaForStub))
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    prisma = prismaForStub;
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    if (app) await app.close();
  });

  async function seed() {
    const tag = randomUUID().slice(0, 8);
    ids.coachA = randomUUID();
    ids.coachB = randomUUID();
    ids.studentA = randomUUID();

    const users: Array<[string, string, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.coachB, 'coach', 'Coach B', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
    ];
    for (const [id, role, name, coachId] of users) {
      await prisma.$executeRaw`
        INSERT INTO "User" (id, role, name, coach_id)
        VALUES (${id}, ${role}::"Role", ${name}, ${coachId})
      `;
    }

    const wsA = await prisma.communityWorkspace.create({
      data: { coach_id: ids.coachA, name: 'WS A', slug: `ws-a-${tag}` },
    });
    ids.wsA = wsA.id;

    const cohortA = await prisma.communityCohort.create({
      data: { workspace_id: wsA.id, name: 'Cohort A', status: 'active', sort_order: 0 },
    });
    ids.cohortA = cohortA.id;

    await prisma.communityMembership.create({
      data: {
        workspace_id: wsA.id,
        cohort_id: cohortA.id,
        user_id: ids.coachA,
        role: 'coach',
        status: 'active',
      },
    });

    // Coach A's plan items.
    const planA = await prisma.workoutPlan.create({
      data: {
        coach_id: ids.coachA,
        name: 'Push Day',
        type: 'strength',
        week_index: 2,
        day_index: 1,
      },
    });
    ids.planA = planA.id;
    const exerciseA = await prisma.workoutPlanExercise.create({
      data: {
        workout_plan_id: planA.id,
        exercise_external_id: 'edb-0001',
        order: 0,
        sets: 5,
        reps_or_duration_seconds: 5,
      },
    });
    ids.exerciseA = exerciseA.id;

    // Coach B's plan (foreign to Coach A).
    const planB = await prisma.workoutPlan.create({
      data: { coach_id: ids.coachB, name: 'Foreign Plan', type: 'cardio' },
    });
    ids.planB = planB.id;

    const mealA = await prisma.mealPlan.create({
      data: { coach_id: ids.coachA, title: 'Cut Phase', items: [] },
    });
    ids.mealA = mealA.id;

    const packageA = await prisma.coachPackage.create({
      data: {
        coach_id: ids.coachA,
        name: '12-week transformation',
        amount_cents: 30000,
        currency: 'usd',
        billing_type: 'one_time',
      },
    });
    ids.packageA = packageA.id;

    const checkInA = await prisma.checkIn.create({
      data: {
        user_id: ids.studentA,
        coach_id: ids.coachA,
        date: new Date('2026-01-05T00:00:00.000Z'),
        soreness: 2,
        type: 'morning',
      },
    });
    ids.checkInA = checkInA.id;
  }

  async function cleanup() {
    const userIds = [ids.coachA, ids.coachB, ids.studentA].filter(Boolean);
    await prisma.communityMessage.deleteMany({
      where: { workspace_id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.communityMembership.deleteMany({
      where: { user_id: { in: userIds } },
    });
    await prisma.communityWorkspace.deleteMany({
      where: { id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.checkIn.deleteMany({ where: { id: { in: [ids.checkInA].filter(Boolean) } } });
    await prisma.coachPackage.deleteMany({ where: { id: { in: [ids.packageA].filter(Boolean) } } });
    await prisma.mealPlan.deleteMany({ where: { id: { in: [ids.mealA].filter(Boolean) } } });
    await prisma.workoutPlanExercise.deleteMany({
      where: { id: { in: [ids.exerciseA].filter(Boolean) } },
    });
    await prisma.workoutPlan.deleteMany({
      where: { id: { in: [ids.planA, ids.planB].filter(Boolean) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  it('1. send with a valid workout plan_context (flag ON) → persisted + echoed', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.coachA),
      {
        body: 'about your push day',
        plan_context: {
          type: 'workout',
          workout_plan_id: ids.planA,
          week_index: 2,
          day_index: 1,
          exercise_id: ids.exerciseA,
        },
      },
    );
    expect(sent.status).toBe(201);
    expect(sent.body.message.plan_context).toMatchObject({
      type: 'workout',
      workout_plan_id: ids.planA,
      exercise_id: ids.exerciseA,
    });

    // Persisted: the row carries the JsonB payload.
    const row = await prisma.communityMessage.findFirst({
      where: { id: sent.body.message.id },
    });
    expect(row?.plan_context_payload).toMatchObject({
      type: 'workout',
      workout_plan_id: ids.planA,
    });
  });

  it('2. send with plan_context when flag OFF → field dropped, send still 201', async () => {
    process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'false';
    try {
      const sent = await call(
        'POST',
        `/api/community/cohorts/${ids.cohortA}/messages`,
        asUser(ids.coachA),
        {
          body: 'flag off send',
          plan_context: { type: 'package', package_id: ids.packageA },
        },
      );
      expect(sent.status).toBe(201);
      expect(sent.body.message.plan_context).toBeNull();

      const row = await prisma.communityMessage.findFirst({
        where: { id: sent.body.message.id },
      });
      expect(row?.plan_context_payload).toBeNull();
    } finally {
      process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'true';
    }
  });

  it('3. send with a foreign-coach workout_plan_id → 403', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.coachA),
      {
        body: 'tagging a foreign plan',
        plan_context: { type: 'workout', workout_plan_id: ids.planB },
      },
    );
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('community.plan_context.foreign_owner');
  });

  it('4. send with a non-existent workout_plan_id → 422', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.coachA),
      {
        body: 'tagging a ghost plan',
        plan_context: { type: 'workout', workout_plan_id: randomUUID() },
      },
    );
    expect(sent.status).toBe(422);
    expect(sent.body.code).toBe('community.plan_context.invalid_reference');
  });

  it('5. send with a malformed plan_context shape → 422', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.coachA),
      {
        body: 'bad tag',
        plan_context: { type: 'workout', workout_plan_id: 'not-a-uuid' },
      },
    );
    expect(sent.status).toBe(422);
    expect(sent.body.code).toBe('community.plan_context.malformed');
  });

  it('6. resolve each type → snapshot', async () => {
    const workout = await call(
      'GET',
      `/api/community/plan-context/resolve?type=workout&id=${ids.planA}&exercise_id=${ids.exerciseA}`,
      asUser(ids.coachA),
    );
    expect(workout.status).toBe(200);
    expect(workout.body.snapshot).toMatchObject({
      type: 'workout',
      name: 'Push Day',
      exercise: { id: ids.exerciseA },
    });

    const meal = await call(
      'GET',
      `/api/community/plan-context/resolve?type=meal&id=${ids.mealA}&meal_id=breakfast`,
      asUser(ids.coachA),
    );
    expect(meal.status).toBe(200);
    expect(meal.body.snapshot).toMatchObject({ type: 'meal', title: 'Cut Phase' });

    const pkg = await call(
      'GET',
      `/api/community/plan-context/resolve?type=package&id=${ids.packageA}`,
      asUser(ids.coachA),
    );
    expect(pkg.status).toBe(200);
    expect(pkg.body.snapshot).toMatchObject({ type: 'package', amount_cents: 30000 });

    const checkIn = await call(
      'GET',
      `/api/community/plan-context/resolve?type=check_in&id=${ids.checkInA}`,
      asUser(ids.coachA),
    );
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.snapshot).toMatchObject({
      type: 'check_in',
      check_in_type: 'morning',
    });
  });

  it('7. resolve a foreign workout plan → 404 (non-leak)', async () => {
    const res = await call(
      'GET',
      `/api/community/plan-context/resolve?type=workout&id=${ids.planB}`,
      asUser(ids.coachA),
    );
    expect(res.status).toBe(404);
  });

  it('8. resolve flag OFF → 404 across the board', async () => {
    process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'false';
    try {
      const res = await call(
        'GET',
        `/api/community/plan-context/resolve?type=package&id=${ids.packageA}`,
        asUser(ids.coachA),
      );
      expect(res.status).toBe(404);
    } finally {
      process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'true';
    }
  });

  it('9. resolve as a non-coach (student) → 403 from RolesGuard', async () => {
    const res = await call(
      'GET',
      `/api/community/plan-context/resolve?type=package&id=${ids.packageA}`,
      asUser(ids.studentA),
    );
    expect(res.status).toBe(403);
  });
});
