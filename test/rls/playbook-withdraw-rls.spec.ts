/**
 * PLAYBOOK-WITHDRAW (AICONSENT-INVENTORY GAP-1; operator rulings 1 and 3): a
 * client who is no longer eligible leaves Roman's coach playbook at once. One
 * row per case, each with a fresh coach A and clients X (a session note), Y and
 * Z (coach messages) and W (no note or message), all on the memory grant
 * (client-ai-v5) with a workout this week, and V, a client of another coach C
 * on the same grant. v1 is built by the real builder (fake model, real spend
 * ledger, so v1's own charged build is on record) and the real signals: texts
 * from X, Y, Z and figures from W, X, Y, Z (the collector's eligible clients).
 * Its top exercises come from a master (always), X's Ask AI one-off plan (the
 * real materialiser saves it as X's program) and an older copy linked only by
 * W's assignment, each only while that client is eligible, and never from a
 * client's program with no client on record.
 * Then Y's next Roman turn: the coach-method block only while every client v1
 * names is still eligible (the same `eligibleClients`, read through the one
 * egress consent path; a client who joins does not count); otherwise no block,
 * v1 superseded, and the rebuild runs at once (the 6-hour gap does not hold
 * it) from the clients who are still eligible.
 * Real services on the superuser connection (service_role, as the API runs).
 * Each row then reads and writes A's playbook versions and their source
 * ledger as the signed-in API role (authenticated, non-bypass) for A, X, Y, W
 * and C, and as anon: 42501, each after a control of 1 as the server.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { createHash, randomUUID } from 'crypto';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import {
  CREATE_WORKOUT_PLAN_CAPABILITY,
  CreateWorkoutPlanMaterializer,
} from '../../src/ai/gateway/materialisers/create-workout-plan.materialiser';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { CLIENT_AI_CONSENT_V5_VERSION, COACH_AI_CONSENT_COPY_SHA256, COACH_AI_CONSENT_VERSION } from '../../src/ai-consent/ai-consent.constants';
import { AiEgressService, AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { PrismaService } from '../../src/prisma.service';
import { RomanBackgroundSpendService } from '../../src/roman/background/roman-background-spend';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import { PlaybookBuilderService } from '../../src/roman/playbook/playbook-builder.service';
import { PlaybookBuilderScheduler } from '../../src/roman/playbook/playbook-builder.scheduler';
import { PlaybookSignalsService } from '../../src/roman/playbook/playbook-signals.service';
import type { PlaybookSignalsOptions } from '../../src/roman/playbook/playbook-signals.types';
import { PlaybookSourceCollector } from '../../src/roman/playbook/playbook-sources';
import { COACH_METHOD_HEADING, RomanCoachMethodAugmenter } from '../../src/roman/playbook/roman-coach-method.augmenter';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('playbook-withdraw-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}
jest.setTimeout(60_000);

const NOTE_X = 'Hill sprints before the deadlift block';
const MESSAGE_Y = 'Sled pushes on recovery days';
const MESSAGE_Z = 'Farmer carries to finish';
const DRAFT = {
  sections: {
    training: { progression: [{ text: 'Add load once every set reaches the top of the rep range.', basis: 'observed', evidence_count: 4 }] },
    recovery: { sleep_target: [{ text: 'Eight hours of sleep a night.', basis: 'stated', evidence_count: 2 }] },
  },
  red_lines: [{ kind: 'no_train_through_pain', text: 'Never train through sharp pain.', basis: 'stated', evidence_count: 3 }],
};
const FLAGS = { FEATURE_ROMAN_PLAYBOOK: 'true', FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true', FEATURE_MWB_AI_LIVE_CREATE: 'true' };
// Catalog lifts, one per kind of plan: a master, X's Ask AI one-off, an older copy assigned to W, a copy with no client.
const LIFTS = { master: randomUUID(), drafted: randomUUID(), older: randomUUID(), unlinked: randomUUID() };
const NAMES: Record<keyof typeof LIFTS, string> = {
  master: 'Master Lift', drafted: 'Drafted Lift', older: 'Older Copy Lift', unlinked: 'Unlinked Copy Lift',
};
const READ_VERSION = 'SELECT 1 FROM "CoachPlaybook" WHERE "id" = $1';
const READ_LEDGER = 'SELECT 1 FROM "CoachPlaybookSource" WHERE "playbook_id" = $1 LIMIT 1';
// [statement on one version, the server's control read of the same row]
const STATEMENTS: Array<[string, string]> = [
  [READ_VERSION, READ_VERSION],
  [`UPDATE "CoachPlaybook" SET "status" = 'superseded' WHERE "id" = $1`, READ_VERSION],
  [READ_LEDGER, READ_LEDGER],
  ['DELETE FROM "CoachPlaybookSource" WHERE "playbook_id" = $1', READ_LEDGER],
];

type People = { a: string; c: string; x: string; y: string; z: string; w: string; v: string };
type Client = 'x' | 'y' | 'z' | 'w';
type Rebuild = { ledger: Client[]; eligible: Client[] };
/** Top exercises for these eligible clients: the master, X's one-off while X is eligible, W's older copy while W is. */
const liftsFor = (eligible: Client[]) =>
  [NAMES.master, ...(eligible.includes('x') ? [NAMES.drafted] : []), ...(eligible.includes('w') ? [NAMES.older] : [])].sort();
type Row = { source_kind: string; source_id: string; client_id: string | null };
/** The digest format before this fix (a sha256 of the ledger alone). */
const preV2Digest = (rows: Row[]) =>
  createHash('sha256')
    .update(JSON.stringify(rows.map((r) => [r.source_kind, r.source_id, r.client_id ?? '']).sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')))))
    .digest('hex');

(DB_URL ? describe : describe.skip)('a client who turns AI off leaves the coach playbook at once', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const consent = new AiConsentService(prisma);
  const egress = new AiEgressService(consent);
  const budget = stub<CoachAIBudgetService>({ resolveHeadCoachId: async (id: string) => id });
  // The real signals, recording each build's client list, how many clients its schedule figure counts and its top exercises.
  const realSignals = new PlaybookSignalsService(prisma, budget);
  const signalsFor: Array<{ clients: string[]; schedule: number | null; lifts: string[] }> = [];
  const signals = stub<PlaybookSignalsService>({
    compute: async (coach: string, opts: PlaybookSignalsOptions = {}) => {
      const out = await realSignals.compute(coach, opts);
      signalsFor.push({
        clients: [...(opts.clientIds ?? [])], schedule: out.schedule?.clients ?? null, lifts: out.top_exercises.map((e) => e.name).sort(),
      });
      return out;
    },
  });
  const collector = new PlaybookSourceCollector(prisma, budget, egress, signals);
  const bodies: string[] = [];
  const model = {
    messages: {
      create: async (body: unknown) => {
        bodies.push(JSON.stringify(body));
        return { content: [{ type: 'text', text: JSON.stringify(DRAFT) }], usage: { input_tokens: 900, output_tokens: 200 } };
      },
    },
  };
  const handle = AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(model));
  const builder = new PlaybookBuilderService(prisma, budget, egress, collector, new RomanBackgroundSpendService(prisma), handle);
  const scheduler = new PlaybookBuilderScheduler(builder);
  const augmenter = new RomanCoachMethodAugmenter(prisma, budget, scheduler, collector);
  const create = new CreateWorkoutPlanMaterializer(prisma, new SubCoachScopeService(prisma), stub<AnalyticsService>({ capture: () => undefined }));
  const saved: Record<string, string | undefined> = {};

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null) =>
    prisma.user.create({ data: { id, supabase_id: id, email: `pbwithdraw-${id}`, name: 'Zephyr Quill', role, coach_id } });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const turnOf = (y: string) => augmenter.augment({ id: y, role: 'student' }, stub<RomanClientContextBundle>({}), 'hi');
  const versions = (a: string) =>
    prisma.coachPlaybook.findMany({
      where: { coach_id: a },
      orderBy: { version: 'asc' },
      select: { id: true, version: true, status: true, sources: { select: { client_id: true } } },
    });
  const learnedFrom = (v: { sources: Array<{ client_id: string | null }> }) =>
    [...new Set(v.sources.map((s) => s.client_id).filter(Boolean))].sort();
  /** A one-day program of coach `a` with `lift`, saved with no client (a master, or a copy from before client ids); its day. */
  const program = async (a: string, is_template: boolean, lift: string) => {
    const { id } = await prisma.workoutProgram.create({
      data: { coach_id: a, owner_user_id: a, name: 'Block', weeks: 1, days_per_week: 1, is_template },
    });
    const day = await prisma.workoutPlan.create({
      data: { coach_id: a, name: 'Day 1', type: 'strength', program_id: id, week_index: 0, day_index: 0, is_template },
    });
    await prisma.workoutPlanExercise.create({
      data: { workout_plan_id: day.id, exercise_external_id: lift, order: 0, sets: 3, reps_or_duration_seconds: 8 },
    });
    return day.id;
  };

  /** How many rows of program `id` the signed-in API role (non-bypass) reads as `who`. */
  const programSeen = (who: { id: string; role: string }, id: string) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who.id);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, who.role);
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who.id, role: 'authenticated' }));
      return tx.workoutProgram.count({ where: { id } });
    });

  /** The statement's row count as `who` in a rolled-back transaction (row security applies), or its SQLSTATE. */
  const asCaller = async (who: { id: string; role: string } | null, sql: string, id: string): Promise<number | string> => {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who ? 'authenticated' : 'anon'}`);
        if (who) {
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who.id);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, who.role);
          await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who.id, role: 'authenticated' }));
        }
        const n = await tx.$executeRawUnsafe(sql, id);
        throw Object.assign(new Error('rollback'), { rows: n });
      });
    } catch (err) {
      const rows = (err as { rows?: number }).rows;
      if (typeof rows === 'number') return rows;
      return /Code: `([0-9A-Z]{5})`/.exec(String(err))?.[1] ?? String(err).slice(0, 200);
    }
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(FLAGS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    for (const [k, id] of Object.entries(LIFTS) as Array<[keyof typeof LIFTS, string]>) {
      await prisma.exerciseCatalogItem.create({
        data: { id, slug: `pbwithdraw-${id}`, name: NAMES[k], category: 'strength', primary_muscle: 'quads' },
      });
    }
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.$disconnect();
  });
  afterEach(() => jest.restoreAllMocks());

  const all: Rebuild = { ledger: ['x', 'y', 'z'], eligible: ['w', 'x', 'y', 'z'] };
  const set = (id: string, data: { coach_id?: string | null; deletion_scheduled_at?: Date }) => prisma.user.update({ where: { id }, data });
  // [case, what happens before Y's next turn, the block is sent, the rebuild's text clients and eligible clients (null: none)]
  const CASES: Array<[string, (p: People) => Promise<unknown>, boolean, Rebuild | null]> = [
    ['every eligible client still consents', async () => undefined, true, null],
    ['source client X turns AI off', (p) => consent.withdraw(p.x), false, { ledger: ['y', 'z'], eligible: ['w', 'y', 'z'] }],
    ['W, counted only in the figures, turns AI off', (p) => consent.withdraw(p.w), false, { ledger: ['x', 'y', 'z'], eligible: ['x', 'y', 'z'] }],
    // Archive keeps a client coached (and eligible) by design; a client with no coach has left A's roster.
    ["W leaves A's roster", (p) => set(p.w, { coach_id: null }), false, { ledger: ['x', 'y', 'z'], eligible: ['x', 'y', 'z'] }],
    ['X moves to another coach', (p) => set(p.x, { coach_id: p.c }), false, { ledger: ['y', 'z'], eligible: ['w', 'y', 'z'] }],
    ['Z schedules account deletion', (p) => set(p.z, { deletion_scheduled_at: new Date() }), false, { ledger: ['x', 'y'], eligible: ['w', 'x', 'y'] }],
    ['a new eligible client joins (V moves to A)', (p) => set(p.v, { coach_id: p.a }), true, null],
    [
      'the consent read fails',
      async () => jest.spyOn(consent, 'clientsWithAiConsent').mockRejectedValueOnce(new Error('consent read failed')),
      false,
      all,
    ],
    [
      'the roster read fails',
      async () => jest.spyOn(collector, 'eligibleClients').mockRejectedValueOnce(new Error('roster read failed')),
      false,
      all,
    ],
    [
      'a version built before this fix',
      async (p) => {
        const [v1] = await versions(p.a);
        const rows = await prisma.coachPlaybookSource.findMany({
          where: { playbook_id: v1.id },
          select: { source_kind: true, source_id: true, client_id: true },
        });
        await prisma.coachPlaybook.update({ where: { id: v1.id }, data: { source_digest: preV2Digest(rows) } });
      },
      false,
      all,
    ],
  ];

  it.each(CASES)('%s', async (_case, before, sent, rebuilt) => {
    const p: People = {
      a: randomUUID(), c: randomUUID(), x: randomUUID(), y: randomUUID(), z: randomUUID(), w: randomUUID(), v: randomUUID(),
    };
    for (const coach of [p.a, p.c]) await person(coach, 'coach', null);
    // COACH-AI-CONSENT: coach A allows AI, so the builds send (the head's own grant, read at send).
    await consent.decideCoach(p.a, 'grant', { version: COACH_AI_CONSENT_VERSION, copy_sha256: COACH_AI_CONSENT_COPY_SHA256 });
    const plan = await prisma.workoutPlan.create({ data: { coach_id: p.a, name: 'Conditioning', type: 'cardio' } });
    await person(p.v, 'student', p.c);
    await consent.grant(p.v, { version: CLIENT_AI_CONSENT_V5_VERSION });
    for (const client of [p.x, p.y, p.z, p.w]) {
      await person(client, 'student', p.a);
      await consent.grant(client, { version: CLIENT_AI_CONSENT_V5_VERSION });
      await prisma.clientWorkoutAssignment.create({
        data: { workout_plan_id: plan.id, client_id: client, assigned_by_coach_id: p.a, scheduled_for: daysAgo(2) },
      });
    }
    await prisma.coachingSession.create({
      data: { coach_id: p.a, client_id: p.x, start_at: daysAgo(10), end_at: new Date(daysAgo(10).getTime() + 3_600_000), title: 'Check-in', coach_notes_md: NOTE_X },
    });
    for (const [client, body] of [[p.y, MESSAGE_Y], [p.z, MESSAGE_Z]]) {
      await prisma.coachMessage.create({ data: { coach_id: p.a, client_id: client, sender_id: p.a, body, created_at: daysAgo(1) } });
    }
    // X's Ask AI one-off plan, approved through the real materialiser: saved as X's program.
    const drafted = await create.materialize(
      await prisma.aiActionDraft.create({
        data: {
          capability: CREATE_WORKOUT_PLAN_CAPABILITY, tenant_coach_id: p.a, requester_id: p.a,
          payload: {
            capability: CREATE_WORKOUT_PLAN_CAPABILITY, target_client_id: p.x,
            diff: [{ kind: 'add_exercise', client_ref: 'd1', exercise_external_id: LIFTS.drafted, sets: 3, reps_or_duration_seconds: 8 }],
          },
        },
      }),
    );
    const day = await prisma.workoutPlan.findUniqueOrThrow({ where: { id: drafted.ref ?? '' }, select: { program: true } });
    expect(day.program).toMatchObject({ is_template: false, client_id: p.x });
    // Row security on it: its coach A and its client X read it (the control); Y and another coach C do not.
    const readers = [{ id: p.a, role: 'coach' }, { id: p.x, role: 'student' }, { id: p.y, role: 'student' }, { id: p.c, role: 'coach' }];
    const seen: number[] = [];
    for (const who of readers) seen.push(await programSeen(who, day.program?.id ?? ''));
    expect(seen).toEqual([1, 1, 0, 0]);
    await program(p.a, true, LIFTS.master);
    const older = await program(p.a, false, LIFTS.older);
    await prisma.clientWorkoutAssignment.create({
      data: { workout_plan_id: older, client_id: p.w, assigned_by_coach_id: p.a, scheduled_for: daysAgo(3) },
    });
    await program(p.a, false, LIFTS.unlinked);
    bodies.length = 0;
    signalsFor.length = 0;

    // v1 (the control): texts from X, Y and Z, figures from W, X, Y and Z (V is not A's client yet).
    expect(await builder.buildFor(p.a)).toBe('built');
    for (const text of [NOTE_X, MESSAGE_Y, MESSAGE_Z]) expect(bodies[0]).toContain(text);
    const [v1] = await versions(p.a);
    expect(learnedFrom(v1)).toEqual([p.x, p.y, p.z].sort());
    expect(signalsFor).toEqual([{ clients: [p.w, p.x, p.y, p.z].sort(), schedule: 4, lifts: liftsFor(['w', 'x', 'y', 'z']) }]);

    const rebuild = jest.spyOn(scheduler, 'rebuildNow');
    const send = jest.spyOn(egress, 'anthropicMessagesCreate');
    await before(p);
    const turn = await turnOf(p.y);

    if (sent) {
      expect(turn?.block).toContain(COACH_METHOD_HEADING);
      expect(rebuild).not.toHaveBeenCalled();
      expect((await versions(p.a)).map((v) => [v.version, v.status])).toEqual([[1, 'active']]);
    } else {
      expect(turn).toBeNull();
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(rebuild).toHaveBeenCalledWith(p.a);
      await rebuild.mock.results[0].value;
      const after = await versions(p.a);
      expect(after.map((v) => [v.version, v.status])).toEqual([[1, 'superseded'], [2, 'active']]);
      const ids = (rebuilt?.ledger ?? []).map((k) => p[k]).sort();
      const eligible = (rebuilt?.eligible ?? []).map((k) => p[k]).sort();
      expect(learnedFrom(after[1])).toEqual(ids);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toEqual({ kind: 'client_data', clientIds: eligible, audience: 'coach', scope: 'memory', coachId: p.a });
      expect(signalsFor[1]).toEqual({
        clients: eligible, schedule: eligible.length >= 3 ? eligible.length : null, lifts: liftsFor(rebuilt?.eligible ?? []),
      });
      expect(bodies[1].includes(NOTE_X)).toBe(ids.includes(p.x));
      expect(bodies[1]).toContain(MESSAGE_Y);
      expect((await turnOf(p.y))?.block).toContain(COACH_METHOD_HEADING); // Y's next turn gets v2
    }

    // Server-only: no signed-in party (nor anon) reads or writes a version or its ledger.
    const callers = [
      { id: p.a, role: 'coach' }, { id: p.x, role: 'student' }, { id: p.y, role: 'student' }, { id: p.w, role: 'student' },
      { id: p.c, role: 'coach' }, null,
    ];
    for (const v of await versions(p.a)) {
      for (const [sql, control] of STATEMENTS) {
        expect(await prisma.$queryRawUnsafe<unknown[]>(control, v.id)).toHaveLength(1);
        for (const who of callers) {
          const label = [who?.id ?? 'anon', sql];
          expect([...label, await asCaller(who, sql, v.id)]).toEqual([...label, '42501']);
        }
      }
    }
  });
});
