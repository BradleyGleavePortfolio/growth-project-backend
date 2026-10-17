/**
 * COACH-TEXT-EGRESS (owner "#COACH-TEXT - op 1"): a coach's own words reach their client's Roman
 * request only while that coach allows AI. Coaches: G allowed, N never asked, D "Not now", W
 * allowed then turned off. Each has one client and wrote, for that client, a guideline, a message,
 * a target note, an exercise cue, a session recap and their coaching style; each client wrote one
 * message back. The real AiConsentService reads the ledger as the non-bypass `authenticated` role,
 * as the coach (own rows only); the real AiEgressService decides. The real context builder (the
 * per-turn client_data) and the real read_history tool run on the superuser connection, as the API
 * runs. Table: state x source. Roman still answers: the client's own message and plan stay in every
 * request. Every 0 has its 1: coach G's words are in G's client's request and in no other.
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true
 * (hard failure).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { COACH_AI_CONSENT_COPY_SHA256 } from '../../src/ai-consent/ai-consent.constants';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { PrismaService } from '../../src/prisma.service';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { RomanConsultationIntakeSource } from '../../src/roman/context/roman-consultation.source';
import { RomanTimelineReader } from '../../src/roman/memory/roman-timeline.reader';
import { RomanReadToolbox } from '../../src/roman/tools/roman-read-tools';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-text-egress-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const COPY = { version: 'coach-ai-v1', copy_sha256: COACH_AI_CONSENT_COPY_SHA256 };
const DAY = 86_400_000;
const KEYS = ['G', 'N', 'D', 'W'] as const;
type K = (typeof KEYS)[number];
const STATES = [
  ['allowed', 'G', 'granted', true],
  ['never asked', 'N', 'not_asked', false],
  ['"Not now"', 'D', 'declined', false],
  ['turned off', 'W', 'withdrawn', false],
] as const;
/** Each text source and the part of the request that carries it. */
const SOURCES = [
  ['guideline', 'context'],
  ['message', 'context'],
  ['note', 'context'],
  ['cue', 'context'],
  ['style', 'context'],
  ['message', 'history tool'],
  ['recap', 'history tool'],
] as const;
const WORDS = ['guideline', 'message', 'note', 'cue', 'recap'] as const;

(DB_URL ? describe : describe.skip)("A coach's own words in their client's Roman request", () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const coach = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<K, string>;
  const client = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<K, string>;
  const run = randomUUID().slice(0, 8);
  // Each coach's words carry the coach key, so a leak names its source.
  const word = (k: K, source: string) => `CT${run}-${k}-${source}`;
  const STYLE = '"coaching_style":';
  const NOW = new Date();
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const ymd = (ms: number) => at(ms).toISOString().slice(0, 10);
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  let readRole = 'authenticated';
  const as = <T>(userId: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${readRole}`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, userId);
      return query(tx);
    });
  // Ledger writes as the server; every read as the user it reads (the self-read policy).
  const reader = (a: { where?: { user_id?: unknown } }) => {
    const id = a.where?.user_id;
    return String(typeof id === 'string' ? id : (id as { in: string[] }).in[0]);
  };
  const ledger = {
    create: (a: Prisma.AiProcessingConsentEventCreateArgs) => prisma.aiProcessingConsentEvent.create(a),
    findFirst: (a: Prisma.AiProcessingConsentEventFindFirstArgs) =>
      as(reader(a), (tx) => tx.aiProcessingConsentEvent.findFirst(a)),
    findMany: (a: Prisma.AiProcessingConsentEventFindManyArgs) =>
      as(reader(a), (tx) => tx.aiProcessingConsentEvent.findMany(a)),
  };
  const consent = new AiConsentService(fakeOf<PrismaService>({ aiProcessingConsentEvent: ledger }));
  const egress = new AiEgressService(consent);
  const context = new RomanClientContextService(prisma, new RomanConsultationIntakeSource(prisma), egress);
  const tools = new RomanReadToolbox(prisma, new RomanTimelineReader(prisma, egress));

  /** What the client's Roman request is built from: the per-turn context and read_history. */
  const request = async (k: K) => {
    const caller = { id: client[k], role: 'student' };
    const { rendered } = await context.buildFresh(caller, NOW);
    const input = { kinds: ['message', 'booking'], from: ymd(-5 * DAY), to: ymd(DAY) };
    const history = await tools.run(caller, 'read_history', input, { now: NOW });
    expect(history.ok).toBe(true);
    return { context: rendered, 'history tool': history.content };
  };
  const seen = new Map<K, ReturnType<typeof request>>();
  const requestOf = (k: K) => seen.get(k) ?? seen.set(k, request(k)).get(k)!;

  beforeAll(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    for (const k of KEYS) {
      const [c, s] = [coach[k], client[k]];
      await prisma.user.create({ data: { id: c, supabase_id: c, email: `ct-${c}`, name: `Coach ${k}`, role: 'coach' } });
      await prisma.user.create({
        data: { id: s, supabase_id: s, email: `ct-${s}`, name: `Client ${k}`, role: 'student', coach_id: c },
      });
      await prisma.coachProfile.create({ data: { user_id: c, invite_code: `ct-${c}`, coaching_touch: 'close' } });
      await prisma.coachGuideline.create({ data: { coach_id: c, client_id: s, content: word(k, 'guideline') } });
      await prisma.coachMessage.create({
        data: { coach_id: c, client_id: s, sender_id: c, body: word(k, 'message'), created_at: at(-DAY) },
      });
      await prisma.coachMessage.create({
        data: { coach_id: c, client_id: s, sender_id: s, body: word(k, 'own'), created_at: at(-DAY + 60_000) },
      });
      await prisma.macroTarget.create({
        data: {
          client_id: s, coach_id: c, calories_kcal: 2100, protein_g: 150, carbs_g: 210, fats_g: 70,
          notes: word(k, 'note'), effective_from: at(-7 * DAY),
        },
      });
      const plan = await prisma.workoutPlan.create({ data: { coach_id: c, name: word(k, 'plan'), type: 'strength' } });
      await prisma.workoutPlanExercise.create({
        data: {
          workout_plan_id: plan.id, exercise_external_id: 'seed:squat-001', order: 0, sets: 3,
          reps_or_duration_seconds: 10, notes: word(k, 'cue'),
        },
      });
      await prisma.clientWorkoutAssignment.create({
        data: { workout_plan_id: plan.id, client_id: s, assigned_by_coach_id: c, scheduled_for: at(DAY) },
      });
      await prisma.coachingSession.create({
        data: {
          coach_id: c, client_id: s, title: 'Check-in', status: 'completed', start_at: at(-2 * DAY),
          end_at: at(-2 * DAY + 45 * 60_000), client_recap_md: word(k, 'recap'),
        },
      });
    }
    await consent.decideCoach(coach.D, 'decline', COPY);
    await consent.decideCoach(coach.G, 'grant', COPY);
    await consent.decideCoach(coach.W, 'grant', COPY);
    await consent.decideCoach(coach.W, 'withdraw');
  }, 120_000);
  afterAll(async () => {
    if (OLD_FLAG === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD_FLAG;
    await prisma.$disconnect();
  });

  it('the gate reads the ledger on a role without bypass, as the coach (own rows only)', async () => {
    const [r] = await prisma.$queryRaw<{ b: boolean }[]>`SELECT rolbypassrls AS "b" FROM pg_roles WHERE rolname = 'authenticated'`;
    expect(r.b).toBe(false);
    const n = (who: string, owner: string) =>
      as(who, (tx) => tx.aiProcessingConsentEvent.count({ where: { user_id: owner, purpose: 'coach_ai_processing' } }));
    expect([await n(coach.G, coach.G), await n(client.G, coach.G)]).toEqual([1, 0]);
  });

  it.each(STATES)('%s: the ledger state', async (_l, k, state) => {
    expect(await consent.getCoachStatus(coach[k])).toMatchObject({ state });
  });

  const TABLE = STATES.flatMap(([label, k, , kept]) =>
    SOURCES.map(([source, part]) => [label, source, part, k, kept] as const),
  );
  it.each(TABLE)('%s: the coach %s in the %s', async (_l, source, part, k, kept) => {
    const r = await requestOf(k);
    expect(r[part].includes(source === 'style' ? STYLE : word(k, source))).toBe(kept);
    // Roman still answers, from the client's own data.
    expect(r[part]).toContain(word(k, 'own'));
    expect(r.context).toContain(word(k, 'plan'));
  });

  it("no client's request carries another coach's words", async () => {
    for (const k of KEYS) {
      const r = await requestOf(k);
      const all = `${r.context}\n${r['history tool']}`;
      for (const o of KEYS.filter((x) => x !== k)) {
        for (const s of [...WORDS, 'own', 'plan']) expect(all).not.toContain(word(o, s));
      }
    }
  });

  it("a failed consent read leaves the allowed coach's words out too; the client still gets an answer", async () => {
    readRole = 'anon';
    const r = await request('G').finally(() => {
      readRole = 'authenticated';
    });
    const all = `${r.context}\n${r['history tool']}`;
    for (const s of WORDS) expect(all).not.toContain(word('G', s));
    expect(r.context).not.toContain(STYLE);
    expect(r.context).toContain(word('G', 'own'));
    expect(r['history tool']).toContain(word('G', 'own'));
    expect(r.context).toContain(word('G', 'plan'));
    // Control: the same read on the right role carries them again.
    expect((await request('G')).context).toContain(word('G', 'guideline'));
  });
});
