/**
 * #TIMELINE-COACH op 1 on the replayed migration chain: no message from any coach, current or past,
 * reaches a client's Timeline, and no other client's rows do. Client A was coached by F, then moved to K;
 * F and K each wrote to A (text, and K a voice note), A wrote back. B is K's other client.
 * The real controller and service run on a live database; every absent row follows A's own rows present.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma.service';
import { TimelineController } from '../../src/timeline/timeline.controller';
import { TimelineService } from '../../src/timeline/timeline.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('timeline-no-coach-messages-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Timeline: weigh-ins and wins only, never a coach message', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const timeline = new TimelineController(new TimelineService(prisma));
  const u: Record<string, string> = Object.fromEntries([...'FKAB'].map((k) => [k, randomUUID()]));
  const run = randomUUID().slice(0, 8);
  const id = (t: string) => `${t}-${run}`;
  const MESSAGES = ['msg.F', 'msg.K', 'voice.K', 'msg.A'];
  const user = (k: string, coach: string | null) =>
    prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
      VALUES (${u[k]}, ${randomUUID()}, ${`tl-${u[k]}`}, ${`User ${k} ${run}`}, ${coach ? 'student' : 'coach'}::"Role", ${coach && u[coach]})`;
  const message = (tag: string, coach: string, sender: string, body: string | null, voice: string | null) =>
    prisma.$executeRaw`INSERT INTO "CoachMessage" ("id", "coach_id", "client_id", "sender_id", "body", "voice_url", "voice_duration_sec")
      VALUES (${id(tag)}, ${u[coach]}, ${u.A}, ${u[sender]}, ${body}, ${voice}, ${voice ? 30 : null})`;
  /** A's or B's Timeline through the real endpoint: every lane name a build may send, the retired coach lane included. */
  const read = async (k: string, lanes = 'body,win,coach,friction') => {
    const res = await timeline.getTimeline({ user: await prisma.user.findUniqueOrThrow({ where: { id: u[k] } }) }, 30, lanes, undefined, 50);
    const sources = res.events.map((e) => Buffer.from(e.id, 'base64url').toString('utf8').split('_').pop());
    return { res, sources, words: res.events.map((e) => [e.title, e.body]) };
  };

  beforeAll(async () => {
    for (const k of 'FK') await user(k, null);
    await user('A', 'F');
    await user('B', 'K');
    await message('msg.F', 'F', 'F', `Past coach text ${run}`, null);
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${u.K} WHERE "id" = ${u.A}`;
    await message('msg.K', 'K', 'K', `Current coach text ${run}`, null);
    await message('voice.K', 'K', 'K', null, `voice-${run}.m4a`);
    await message('msg.A', 'K', 'A', `Client reply ${run}`, null);
    await prisma.$executeRaw`INSERT INTO "UserProfile" ("id", "user_id", "weight_unit", "updated_at") VALUES (${id('profile.A')}, ${u.A}, 'kg', now())`;
    for (const [tag, k, day, lbs] of [['weight.A1', 'A', 1, 180], ['weight.A0', 'A', 0, 179], ['weight.B', 'B', 0, 200]] as const) {
      await prisma.$executeRaw`INSERT INTO "WeightLog" ("id", "user_id", "date", "weight_lbs") VALUES (${id(tag)}, ${u[k]}, (now() AT TIME ZONE 'UTC')::date - ${day}::int, ${lbs})`;
    }
    await prisma.$executeRaw`INSERT INTO "ClientSignal" ("id", "user_id", "signal_type", "value", "recorded_at")
      VALUES (${id('streak.A')}, ${u.A}, 'checkin_streak'::"PtmSignalType", 7, now()), (${id('miss.A')}, ${u.A}, 'checkin_miss'::"PtmSignalType", 2, now() - interval '2 days')`;
  });
  afterAll(() => prisma.$disconnect());

  it('shows A her own weigh-ins in kg with the trend, her streak and a plain missed check-in', async () => {
    const { words, sources } = await read('A');
    expect(words).toEqual([
      ['7 days of check-ins in a row', undefined],
      ['Weighed in at 81.2 kg', 'Trend 81.6 kg'],
      ['Weighed in at 81.6 kg', undefined],
      ['No check-in', undefined],
    ]);
    expect(sources).toEqual([id('streak.A'), id('weight.A0'), id('weight.A1'), id('miss.A')]);
  });

  it('carries no message, voice note or coach name from the past or the current coach', async () => {
    expect(await prisma.coachMessage.count({ where: { client_id: u.A } })).toBe(MESSAGES.length);
    const { res, sources } = await read('A');
    expect(res.events.map((e) => e.lane)).not.toContain('coach');
    for (const m of MESSAGES) expect(sources).not.toContain(id(m));
    expect(JSON.stringify(res)).not.toMatch(new RegExp(`coach text|Client reply|voice-${run}|User [FK] ${run}`));
    expect((await read('A', 'coach')).res).toEqual({ events: [], nextCursor: null, total: 0 });
  });

  it("keeps each client's rows to that client", async () => {
    expect((await read('A')).sources).not.toContain(id('weight.B'));
    const { words, sources } = await read('B');
    expect(words).toEqual([['Weighed in at 200.0 lb', undefined]]);
    expect(sources).toEqual([id('weight.B')]);
  });
});
