/**
 * ROMANCACHE (agent 149). Rule: a change a person makes in the app, to their
 * own data or (as a coach) to a client's, reaches Roman's next answer for that
 * client. One shared point closes it: RomanContextInvalidationInterceptor.
 *
 * 1. FAMILIES walks every app route family: the real interceptor around the
 *    family's real handler, the write applied to the persona rows, then the
 *    next getBundle 5 s later (inside the 15 s memo) has the new value. Another
 *    coach's client keeps its memo; after a client's own write, so does the
 *    same coach's other client.
 * 2. KEEPS: a write that throws, a 4xx answer, a read, Roman's own turn and a
 *    signed-out write keep the memo.
 * 3. The route table, generated from every controller AppModule mounts: Roman's
 *    turn is the only exempt write route, each FAMILIES row is a covered write
 *    route at the path it names, and the interceptor is registered once.
 * 4. A real Nest HTTP app: the status and error semantics the interceptor uses.
 */
import 'reflect-metadata';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  Post,
  RequestMethod,
  Res,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  Reflector,
} from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { defer, lastValueFrom } from 'rxjs';
import { AppModule } from '../../src/app.module';
import { ClientCheckInsController } from '../../src/check-ins/client-check-ins.controller';
import { CoachController } from '../../src/coach/coach.controller';
import { CoachConsultationController } from '../../src/coach/consultation/coach-consultation.controller';
import { LogController } from '../../src/log/log.controller';
import { CoachMacrosController } from '../../src/macros/macros.controller';
import { ClientMessagingController } from '../../src/messaging/client-messaging.controller';
import { CoachMessagingController } from '../../src/messaging/coach-messaging.controller';
import { OnboardingController } from '../../src/onboarding/onboarding.controller';
import { ProfileController } from '../../src/profile/profile.controller';
import { CoachDailyMealPlansController } from '../../src/real-meal-plans/real-meal-plans.controller';
import { RomanAdjustController } from '../../src/roman-adjust/roman-adjust.controller';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import type { RomanClientContext } from '../../src/roman/context/roman-client-context.types';
import {
  KEEP_ROMAN_CONTEXT,
  RomanContextInvalidationInterceptor,
  _resetRomanContextListeners,
  onRomanContextInvalidate,
} from '../../src/roman/context/roman-context-invalidation';
import { RomanController } from '../../src/roman/roman.controller';
import { SchedulingController } from '../../src/scheduling/scheduling.controller';
import { WeightController } from '../../src/weight/weight.controller';
import { ProgramLibraryController } from '../../src/workout-builder/program-library.controller';
import { WorkoutController } from '../../src/workout/workout.controller';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import {
  COACH_A,
  FakeSafetyIntakeSource,
  NOW,
  P1,
  P2,
  P4,
  P5,
  makePersonaDb,
  type PersonaDb,
} from './fixtures/roman-personas';

type Rec = Record<string, unknown>;
const D = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
/** Inside the 15 s memo window. */
const LATER = new Date(NOW.getTime() + 5_000);
const READS = ['GET', 'HEAD', 'OPTIONS'];
const student = (id: string) => ({ id, role: 'student' });

beforeEach(() => _resetRomanContextListeners());

function setup() {
  const db = makePersonaDb();
  const intake = new FakeSafetyIntakeSource();
  return { db, intake, svc: new RomanClientContextService(db.prisma, intake, grantAllEgress()) };
}

function find(rows: Rec[], pick: (r: Rec) => boolean): Rec {
  const row = rows.find(pick);
  if (!row) throw new Error('persona row missing');
  return row;
}
const userRow = (db: PersonaDb, id: string) => find(db.raw.users, (u) => u.id === id);
const profileOf = (db: PersonaDb, id: string) => userRow(db, id).profile as Rec;

/** The HTTP context Nest hands the interceptor for one call to `handler`. */
function httpCall(handler: Function, user: { id: string } | undefined, statusCode = 200) {
  const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
  return fakeOf<ExecutionContext>({
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => ({ method, user }),
      getResponse: () => ({ statusCode }),
    }),
  });
}

const interceptor = new RomanContextInvalidationInterceptor(new Reflector());
const run = (ctx: ExecutionContext, write: () => void) =>
  lastValueFrom(
    interceptor.intercept(ctx, {
      handle: () =>
        defer(async () => {
          write();
          return { ok: true };
        }),
    }),
  );

interface Family {
  name: string;
  /** Verb and declared path; the route table below checks it against the mounted route. */
  route: string;
  handler: Function;
  by: 'client' | 'coach';
  /** The client whose next answer must change (default Maya). */
  client?: string;
  write: (db: PersonaDb, intake: FakeSafetyIntakeSource) => void;
  sees: (c: RomanClientContext) => boolean;
}

const FAMILIES: Family[] = [
  {
    name: 'profile',
    route: 'PUT /profile',
    handler: ProfileController.prototype.updateProfile,
    by: 'client',
    write: (db) => (profileOf(db, P1).goal_type = 'muscle_gain'),
    sees: (c) => c.profile.goal_type === 'muscle_gain',
  },
  {
    name: 'macro targets, client (profile recalculation)',
    route: 'PUT /profile',
    handler: ProfileController.prototype.updateProfile,
    by: 'client',
    client: P2,
    write: (db) => (profileOf(db, P2).macro_target_calories = 1650),
    sees: (c) => c.targets.calories === 1650,
  },
  {
    name: 'consultation save',
    route: 'PUT /me/onboarding/consultation',
    handler: OnboardingController.prototype.save,
    by: 'client',
    write: (_db, intake) =>
      (intake.internal[P1].consult = [{ question: 'Main goal', answer: 'Run a 10k by spring' }]),
    sees: (c) => c.consultation.answers.some((a) => a.answer === 'Run a 10k by spring'),
  },
  {
    name: 'consultation complete (targets)',
    route: 'POST /me/onboarding/complete',
    handler: OnboardingController.prototype.complete,
    by: 'client',
    client: P2,
    write: (db) =>
      db.raw.macroTargets.push({
        id: 'mt-dan-1',
        client_id: P2,
        coach_id: P2,
        calories_kcal: 1750,
        protein_g: 120,
        carbs_g: 180,
        fats_g: 55,
        fiber_g: null,
        notes: null,
        effective_from: D('2026-09-30'),
        archived_at: null,
      }),
    sees: (c) => c.targets.calories === 1750,
  },
  {
    name: 'macro targets, coach (set)',
    route: 'POST /coach/clients/:clientId/macros',
    handler: CoachMacrosController.prototype.create,
    by: 'coach',
    write: (db) =>
      db.raw.macroTargets.push({
        id: 'mt-maya-2',
        client_id: P1,
        coach_id: COACH_A.id,
        calories_kcal: 1700,
        protein_g: 130,
        carbs_g: 160,
        fats_g: 50,
        fiber_g: null,
        notes: null,
        effective_from: D('2026-09-30'),
        archived_at: null,
      }),
    sees: (c) => c.targets.calories === 1700,
  },
  {
    name: 'macro targets, coach (archive: the client is only in the stored row)',
    route: 'DELETE /coach/macros/:targetId',
    handler: CoachMacrosController.prototype.archive,
    by: 'coach',
    write: (db) => (find(db.raw.macroTargets, (t) => t.id === 'mt-maya-1').archived_at = NOW),
    sees: (c) => c.targets.calories === 2222,
  },
  {
    name: 'food log edit',
    route: 'PUT /log/food/:id',
    handler: LogController.prototype.updateEntry,
    by: 'client',
    write: (db) =>
      (find(
        db.raw.loggedFood,
        (f) => f.user_id === P1 && (f.food_item as Rec).name === 'Greek yogurt bowl',
      ).quantity_multiplier = 2),
    sees: (c) => c.today.kcal === 1100,
  },
  {
    name: 'workout update',
    route: 'PUT /workouts/:id',
    handler: WorkoutController.prototype.updateWorkout,
    by: 'client',
    write: (db) =>
      (find(db.raw.workoutSessions, (w) => w.user_id === P1).workout_name = 'Hill sprints'),
    sees: (c) => c.logged_workouts.some((w) => w.name === 'Hill sprints'),
  },
  {
    name: 'workout delete',
    route: 'DELETE /workouts/:id',
    handler: WorkoutController.prototype.deleteWorkout,
    by: 'client',
    write: (db) =>
      db.raw.workoutSessions.splice(
        db.raw.workoutSessions.findIndex((w) => w.user_id === P1),
        1,
      ),
    sees: (c) => c.logged_workouts.length === 0,
  },
  {
    name: 'check-in',
    route: 'POST /check-ins',
    handler: ClientCheckInsController.prototype.upsert,
    by: 'client',
    write: (db) => (find(db.raw.checkIns, (r) => r.user_id === P1).mood = 2),
    sees: (c) => c.check_ins.some((r) => r.mood === 2),
  },
  {
    name: 'weight',
    route: 'POST /weight',
    handler: WeightController.prototype.logWeight,
    by: 'client',
    write: (db) => db.raw.weightLogs.push({ user_id: P1, date: D('2026-09-27'), weight_lbs: 167.2 }),
    sees: (c) => c.weight_trend.points.some((p) => p.weight_lbs === 167.2),
  },
  {
    name: 'message, client',
    route: 'POST /messages',
    handler: ClientMessagingController.prototype.send,
    by: 'client',
    write: (db) =>
      db.raw.coachMessages.push({
        coach_id: COACH_A.id,
        client_id: P1,
        sender_id: P1,
        body: 'Can we move Thursday to Friday?',
        created_at: new Date('2026-09-30T23:00:00Z'),
      }),
    sees: (c) => c.coach.recent_messages.some((m) => m.excerpt.includes('move Thursday')),
  },
  {
    name: 'message, coach',
    route: 'POST /coach/clients/:client_id/messages',
    handler: CoachMessagingController.prototype.send,
    by: 'coach',
    write: (db) =>
      db.raw.coachMessages.push({
        coach_id: COACH_A.id,
        client_id: P1,
        sender_id: COACH_A.id,
        body: 'Swap Thursday for a long walk.',
        created_at: new Date('2026-09-30T23:00:00Z'),
      }),
    sees: (c) => c.coach.recent_messages.some((m) => m.excerpt.includes('Swap Thursday')),
  },
  {
    name: 'message edit, coach',
    route: 'PATCH /coach/clients/:client_id/messages/:message_id',
    handler: CoachMessagingController.prototype.edit,
    by: 'coach',
    write: (db) =>
      (find(db.raw.coachMessages, (m) => String(m.body).startsWith('Great week Maya')).body =
        'Great week Maya - protein and steps looked solid.'),
    sees: (c) => c.coach.recent_messages.some((m) => m.excerpt.includes('protein and steps')),
  },
  {
    name: 'booking request, client',
    route: 'POST /scheduling/sessions',
    handler: SchedulingController.prototype.requestSession,
    by: 'client',
    write: (db) =>
      db.raw.coachingSessions.push({
        coach_id: COACH_A.id,
        client_id: P1,
        title: 'Nutrition review',
        status: 'requested',
        start_at: new Date('2026-10-08T17:00:00Z'),
        end_at: new Date('2026-10-08T17:30:00Z'),
        coach_notes_md: null,
      }),
    sees: (c) => c.upcoming_sessions.some((s) => s.title === 'Nutrition review'),
  },
  {
    name: 'booking cancel, coach (the client is only in the stored row)',
    route: 'POST /scheduling/sessions/:id/cancel',
    handler: SchedulingController.prototype.cancel,
    by: 'coach',
    write: (db) =>
      (find(db.raw.coachingSessions, (s) => s.title === 'Form check: squat').status = 'cancelled'),
    sees: (c) => c.upcoming_sessions.length === 0,
  },
  {
    name: 'meal-plan assign (the client is only in the body)',
    route: 'POST /coach/daily-meal-plans/:id/assignments',
    handler: CoachDailyMealPlansController.prototype.assign,
    by: 'coach',
    write: (db) =>
      db.raw.mealAssignments.push({
        client_id: P1,
        assigned_by_coach_id: COACH_A.id,
        starts_on: D('2026-09-30'),
        ends_on: null,
        daily_meal_plan: {
          archived_at: null,
          name: 'High protein 1700',
          slots: [
            {
              order: 0,
              slot_label: 'Breakfast',
              meal_template: { name: 'Protein oats', calories_kcal: 420, protein_g: 35 },
            },
          ],
        },
      }),
    sees: (c) => c.meal_plan?.title === 'High protein 1700',
  },
  {
    name: 'guidelines, coach',
    route: 'POST /coach/guidelines/:client_id',
    handler: CoachController.prototype.postGuidelines,
    by: 'coach',
    write: (db) =>
      (find(db.raw.guidelines, (g) => g.coach_id === COACH_A.id && g.client_id === P1).content =
        'Two litres of water a day.'),
    sees: (c) => c.coach.guidelines === 'Two litres of water a day.',
  },
  {
    name: 'coaching style, coach (names no client)',
    route: 'PUT /coach/consultation',
    handler: CoachConsultationController.prototype.save,
    by: 'coach',
    write: (db) =>
      ((userRow(db, P1).coach as Rec).coach_profile = {
        coaching_touch: 'close',
        programming_style: null,
      }),
    sees: (c) => c.coach.coaching_style?.touch === 'close guidance, frequent check-ins',
  },
  {
    name: 'Roman adjustment approve, coach',
    route: 'POST /coach/adjustments/:id/approve',
    handler: RomanAdjustController.prototype.approve,
    by: 'coach',
    write: (db) => {
      const plan = find(db.raw.assignments, (a) => a.id === 'a3').workout_plan as Rec;
      (plan.exercises as Rec[])[0].sets = 4;
    },
    sees: (c) => c.plan?.next_session?.exercises[0]?.sets === 4,
  },
  {
    name: 'program assign, coach',
    route: 'POST /v1/coach/programs/:programId/assign',
    handler: ProgramLibraryController.prototype.assign,
    by: 'coach',
    write: (db) =>
      db.raw.assignments.push({
        id: 'a5',
        client_id: P1,
        assigned_by_coach_id: COACH_A.id,
        scheduled_for: new Date('2026-09-30T20:00:00Z'),
        completed_at: null,
        post_rpe: null,
        post_notes: null,
        snapshot: null,
        workout_plan: {
          name: 'Upper Body C',
          type: 'strength',
          program: { name: 'Program A Foundations' },
          exercises: [],
        },
      }),
    sees: (c) => c.plan?.today_session?.name === 'Upper Body C',
  },
];

describe('ROMANCACHE: a write through each app route family reaches the next answer', () => {
  it.each(FAMILIES)('$name ($route)', async (row) => {
    const { db, intake, svc } = setup();
    const client = row.client ?? P1;
    const before = await svc.getBundle(student(client), NOW);
    const otherCoach = await svc.getBundle(student(P5), NOW);
    const sameCoach = await svc.getBundle(student(P4), NOW);
    // Control: the old value, and the memo would still serve it.
    expect(row.sees(before.context)).toBe(false);
    expect(await svc.getBundle(student(client), LATER)).toBe(before);

    const writer = row.by === 'coach' ? COACH_A.id : client;
    await run(httpCall(row.handler, { id: writer }), () => row.write(db, intake));

    const after = await svc.getBundle(student(client), LATER);
    expect(after).not.toBe(before);
    expect(row.sees(after.context)).toBe(true);
    // Never the wrong client: another coach's client keeps its memo; a coach's
    // write drops that coach's clients, a client's write drops only their own.
    expect(await svc.getBundle(student(P5), LATER)).toBe(otherCoach);
    expect((await svc.getBundle(student(P4), LATER)) === sameCoach).toBe(row.by === 'client');
  });
});

const profileWrite = ProfileController.prototype.updateProfile;
const maya = { id: P1 };
const KEEPS: Array<{
  name: string;
  handler: Function;
  user?: { id: string };
  status?: number;
  fails?: boolean;
}> = [
  { name: 'a write that throws', handler: profileWrite, user: maya, fails: true },
  { name: 'a write answered 4xx', handler: profileWrite, user: maya, status: 400 },
  { name: 'a read', handler: ProfileController.prototype.getProfile, user: maya },
  { name: "Roman's own turn", handler: RomanController.prototype.sendMessage, user: maya },
  { name: 'a write with no signed-in caller', handler: profileWrite },
];

describe('ROMANCACHE: nothing else drops the memo', () => {
  it.each(KEEPS)('$name keeps it', async (row) => {
    const { svc } = setup();
    const before = await svc.getBundle(student(P1), NOW);
    const call = run(httpCall(row.handler, row.user, row.status), () => {
      if (row.fails) throw new ForbiddenException();
    });
    if (row.fails) await expect(call).rejects.toThrow(ForbiddenException);
    else await call;
    expect(await svc.getBundle(student(P1), LATER)).toBe(before);
  });
});

const join = (...parts: unknown[]) =>
  '/' +
  parts
    .map((p) => String((Array.isArray(p) ? p[0] : p) ?? '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

describe('ROMANCACHE route table (every controller AppModule mounts)', () => {
  let moduleRef: TestingModule;
  const routes: Array<{ key: string; handler: Function }> = [];
  const reflector = new Reflector();
  const exempt = (handler: Function) =>
    reflector.get<boolean>(KEEP_ROMAN_CONTEXT, handler) === true;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule, AppModule],
    }).compile();
    const scanner = moduleRef.get(MetadataScanner);
    for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, instance.constructor);
      for (const name of scanner.getAllMethodNames(instance)) {
        const handler: unknown = instance[name];
        if (typeof handler !== 'function') continue;
        const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        if (path === undefined) continue;
        const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
        routes.push({ key: `${verb} ${join(base, path)}`, handler });
      }
    }
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it("covers every write route but Roman's own turn", () => {
    const writes = routes.filter((r) => !READS.includes(r.key.split(' ')[0]));
    expect(writes.length).toBeGreaterThan(FAMILIES.length);
    expect(writes.filter((r) => exempt(r.handler)).map((r) => r.key)).toEqual([
      'POST /roman/sessions/:id/messages',
    ]);
  });

  it.each(FAMILIES)('$route is mounted, a write, and covered', (row) => {
    expect(routes.find((r) => r.handler === row.handler)?.key).toBe(row.route);
    expect(READS).not.toContain(row.route.split(' ')[0]);
    expect(exempt(row.handler)).toBe(false);
  });

  it('registers the interceptor once, app-wide', () => {
    const found = moduleRef
      .get(DiscoveryService)
      .getProviders()
      .filter((w) => w.instance instanceof RomanContextInvalidationInterceptor);
    expect(found).toHaveLength(1);
  });
});

@Controller('probe')
class ProbeController {
  @Post('ok')
  ok() {
    return { ok: true };
  }

  @Post('refused')
  refused() {
    throw new ForbiddenException();
  }

  @Get('read')
  read() {
    return { ok: true };
  }

  @Post('answered-400')
  answered(@Res() res: { status(code: number): { json(body: unknown): void } }) {
    res.status(400).json({ ok: false });
  }
}

/** Signs the request in as the `x-user` header, like JwtAuthGuard does from the token. */
class HeaderAuth implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; user?: { id: string } }>();
    const id = req.headers['x-user'];
    if (id) req.user = { id };
    return true;
  }
}

describe('ROMANCACHE on a real Nest app: only a successful signed-in write invalidates', () => {
  let app: INestApplication;
  let baseUrl: string;
  const seen: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_GUARD, useClass: HeaderAuth },
        { provide: APP_INTERCEPTOR, useClass: RomanContextInvalidationInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    seen.length = 0;
    onRomanContextInvalidate((id) => seen.push(id));
  });

  const CASES: Array<[string, string, string | undefined, number, string[]]> = [
    ['POST', '/probe/ok', 'u1', 201, ['u1']],
    ['POST', '/probe/refused', 'u1', 403, []],
    ['POST', '/probe/answered-400', 'u1', 400, []],
    ['GET', '/probe/read', 'u1', 200, []],
    ['POST', '/probe/ok', undefined, 201, []],
  ];
  it.each(CASES)('%s %s as %s -> %d, invalidates %j', async (method, path, user, code, ids) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: user ? { 'x-user': user } : {},
    });
    await res.arrayBuffer();
    expect(res.status).toBe(code);
    expect(seen).toEqual(ids);
  });
});
