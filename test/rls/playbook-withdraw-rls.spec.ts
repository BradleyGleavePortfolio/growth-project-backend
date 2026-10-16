/**
 * PLAYBOOK-WITHDRAW (AICONSENT-INVENTORY GAP-1): a client who turns AI off
 * leaves Roman's coach playbook at once. One row per case, each with a fresh
 * coach A, clients X (a session note) and Y (a coach message) on the memory
 * grant (client-ai-v5), and v1 built from both by the real builder (fake
 * model, real spend ledger, so v1's own charged build is on record). Then Y's
 * next Roman turn: the coach-method block only while every source client
 * still holds the grant, read through the one egress consent path; otherwise
 * no block, v1 superseded, and the rebuild runs at once (the 6-hour gap does
 * not hold it) from the clients who may still be read.
 * Real services on the superuser connection (service_role, as the API runs).
 * Each row then reads and writes A's playbook versions and their source
 * ledger as the signed-in API role (authenticated, non-bypass) for A, X, Y and
 * another coach C, and as anon: 42501, each after a control of 1 as the server.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { CLIENT_AI_CONSENT_V5_VERSION } from '../../src/ai-consent/ai-consent.constants';
import { AiEgressService, AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { PrismaService } from '../../src/prisma.service';
import { RomanBackgroundSpendService } from '../../src/roman/background/roman-background-spend';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import { PlaybookBuilderService } from '../../src/roman/playbook/playbook-builder.service';
import { PlaybookBuilderScheduler } from '../../src/roman/playbook/playbook-builder.scheduler';
import type { PlaybookSignalsService } from '../../src/roman/playbook/playbook-signals.service';
import type { PlaybookSignals, PlaybookSignalsOptions } from '../../src/roman/playbook/playbook-signals.types';
import { PlaybookSourceCollector } from '../../src/roman/playbook/playbook-sources';
import { COACH_METHOD_HEADING, RomanCoachMethodAugmenter } from '../../src/roman/playbook/roman-coach-method.augmenter';
import { fakeOf } from '../ai-egress/ai-egress.fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('playbook-withdraw-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}
jest.setTimeout(60_000);

const NOTE_X = 'Hill sprints before the deadlift block';
const MESSAGE_Y = 'Sled pushes on recovery days';
const DRAFT = {
  sections: {
    training: { progression: [{ text: 'Add load once every set reaches the top of the rep range.', basis: 'observed', evidence_count: 4 }] },
    recovery: { sleep_target: [{ text: 'Eight hours of sleep a night.', basis: 'stated', evidence_count: 2 }] },
  },
  red_lines: [{ kind: 'no_train_through_pain', text: 'Never train through sharp pain.', basis: 'stated', evidence_count: 3 }],
};
const FLAGS = { FEATURE_ROMAN_PLAYBOOK: 'true', FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true' };
const READ_VERSION = 'SELECT 1 FROM "CoachPlaybook" WHERE "id" = $1';
const READ_LEDGER = 'SELECT 1 FROM "CoachPlaybookSource" WHERE "playbook_id" = $1 LIMIT 1';
// [statement on one version, the server's control read of the same row]
const STATEMENTS: Array<[string, string]> = [
  [READ_VERSION, READ_VERSION],
  [`UPDATE "CoachPlaybook" SET "status" = 'superseded' WHERE "id" = $1`, READ_VERSION],
  [READ_LEDGER, READ_LEDGER],
  ['DELETE FROM "CoachPlaybookSource" WHERE "playbook_id" = $1', READ_LEDGER],
];

type People = { a: string; c: string; x: string; y: string };
type Client = 'x' | 'y';

(DB_URL ? describe : describe.skip)('a client who turns AI off leaves the coach playbook at once', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const stub = <T>(part: Partial<T>) => part as T;
  const consent = new AiConsentService(prisma);
  const egress = new AiEgressService(consent);
  const budget = stub<CoachAIBudgetService>({ resolveHeadCoachId: async (id: string) => id });
  const signalsFor: string[][] = []; // the clients each build's signals were computed from
  const signals = stub<PlaybookSignalsService>({
    compute: async (_coach: string, opts: PlaybookSignalsOptions = {}) => {
      signalsFor.push([...(opts.clientIds ?? [])]);
      return stub<PlaybookSignals>({});
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
  const augmenter = new RomanCoachMethodAugmenter(prisma, budget, egress, scheduler);
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

  beforeAll(() => {
    for (const [k, v] of Object.entries(FLAGS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
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

  // [case, what happens before Y's next turn, the block is sent, the clients the rebuild learns from (null: no rebuild)]
  const CASES: Array<[string, (p: People) => Promise<unknown>, boolean, Client[] | null]> = [
    ['every source client still consents', async () => undefined, true, null],
    ['source client X turns AI off', (p) => consent.withdraw(p.x), false, ['y']],
    [
      'the consent read fails',
      async () => jest.spyOn(consent, 'clientsWithAiConsent').mockRejectedValueOnce(new Error('consent read failed')),
      false,
      ['x', 'y'],
    ],
  ];

  it.each(CASES)('%s', async (_case, before, sent, rebuiltFrom) => {
    const p: People = { a: randomUUID(), c: randomUUID(), x: randomUUID(), y: randomUUID() };
    for (const coach of [p.a, p.c]) await person(coach, 'coach', null);
    for (const client of [p.x, p.y]) {
      await person(client, 'student', p.a);
      await consent.grant(client, { version: CLIENT_AI_CONSENT_V5_VERSION });
    }
    await prisma.coachingSession.create({
      data: { coach_id: p.a, client_id: p.x, start_at: daysAgo(10), end_at: new Date(daysAgo(10).getTime() + 3_600_000), title: 'Check-in', coach_notes_md: NOTE_X },
    });
    await prisma.coachMessage.create({ data: { coach_id: p.a, client_id: p.y, sender_id: p.a, body: MESSAGE_Y, created_at: daysAgo(1) } });
    bodies.length = 0;
    signalsFor.length = 0;

    // v1 learned from X and Y (the control).
    expect(await builder.buildFor(p.a)).toBe('built');
    expect(bodies[0]).toContain(NOTE_X);
    expect(bodies[0]).toContain(MESSAGE_Y);
    const [v1] = await versions(p.a);
    expect(learnedFrom(v1)).toEqual([p.x, p.y].sort());

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
      const all = await versions(p.a);
      expect(all.map((v) => [v.version, v.status])).toEqual([[1, 'superseded'], [2, 'active']]);
      const ids = (rebuiltFrom ?? []).map((k) => p[k]).sort();
      expect(learnedFrom(all[1])).toEqual(ids);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toEqual({ kind: 'client_data', clientIds: ids, audience: 'coach', scope: 'memory' });
      expect(signalsFor).toEqual([[p.x, p.y].sort(), ids]);
      expect(bodies[1].includes(NOTE_X)).toBe(ids.includes(p.x));
      expect(bodies[1]).toContain(MESSAGE_Y);
      expect((await turnOf(p.y))?.block).toContain(COACH_METHOD_HEADING); // Y's next turn gets v2
    }

    // Server-only: no signed-in party (nor anon) reads or writes a version or its ledger.
    const callers = [
      { id: p.a, role: 'coach' }, { id: p.x, role: 'student' }, { id: p.y, role: 'student' }, { id: p.c, role: 'coach' }, null,
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
