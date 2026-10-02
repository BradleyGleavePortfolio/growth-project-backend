/**
 * Sol B-635-1 / C-635-1 live proof on real Postgres: the unique index
 * roman_session_user_surface_day (user_id, surface, day_key) covers deleted
 * rows too, so a delete must move the erased row off the day key or the next
 * open the same day fails with P2002 until UTC midnight.
 *
 * Runs RomanService against a Prisma-faithful schema built by the shared
 * bootstrap helper (`prisma migrate diff --from-empty` of schema.prisma, so the
 * unique index is the real one). Gated on MWB3_TEST_DATABASE_URL (the
 * mwb-3-live-tests CI job); skipped with a logged reason elsewhere.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RomanCaller, RomanService, dayKeyUtc, erasedDayKey } from '../../src/roman/roman.service';
import { ROMAN_RATE_LIMIT_FREE_PER_DAY } from '../../src/roman/roman.constants';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('[roman-session-erase.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.');
}

function withPool(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return url.includes('connection_limit=') ? url : `${url}${sep}connection_limit=8`;
}

const ME: RomanCaller = { id: 'b635-live-me', role: 'student', tier: 'free' };
const OTHER: RomanCaller = { id: 'b635-live-other', role: 'student', tier: 'free' };

liveDescribe('B-635-1 / C-635-1 live: Roman delete erases and frees the day key (Postgres)', () => {
  let prisma: PrismaService;
  let svc: RomanService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    svc = new RomanService(prisma, grantAllEgress());
    for (const c of [ME, OTHER]) {
      await prisma.user.create({
        data: {
          id: c.id,
          supabase_id: `sb-${c.id}`,
          email: `${c.id}@example.test`,
          name: 'Client',
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.romanMessage.deleteMany({});
    await prisma.romanSession.deleteMany({});
  });

  async function seedLegacyTombstone(userId: string, dayKey: string, userTurns: number) {
    // What the pre-#635 soft delete left behind: deleted_at set, calendar
    // day_key kept, transcript and subject context kept.
    const s = await prisma.romanSession.create({
      data: {
        user_id: userId,
        surface: 'client',
        day_key: dayKey,
        deleted_at: new Date(),
        message_count: userTurns + 1,
        subject_context_json: { brief: 'legacy private context' },
      },
    });
    await prisma.romanMessage.createMany({
      data: [
        ...Array.from({ length: userTurns }, (_, i) => ({
          session_id: s.id,
          user_id: userId,
          role: 'user' as const,
          content: `legacy question ${i}`,
        })),
        { session_id: s.id, user_id: userId, role: 'roman' as const, content: 'legacy reply' },
      ],
    });
    return s.id;
  }

  it('negative control: Postgres rejects a second row on a day key a deleted row still holds', async () => {
    await prisma.romanSession.create({
      data: { user_id: ME.id, surface: 'client', day_key: dayKeyUtc(), deleted_at: new Date() },
    });
    const err = await prisma.romanSession
      .create({ data: { user_id: ME.id, surface: 'client', day_key: dayKeyUtc() } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('open -> append -> delete -> open the same day gives a fresh empty session that takes turns', async () => {
    const s = await svc.openOrResumeSession(ME, 'client', { brief: 'old context' });
    await svc.appendMessage(ME, s.id, { role: 'user', content: 'first chat' });
    await svc.deleteSession(ME, s.id);

    const tomb = await prisma.romanSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(tomb.day_key).toBe(erasedDayKey(s.id));
    expect(tomb.subject_context_json).toBeNull();
    expect(tomb.message_count).toBe(1);

    const next = await svc.openOrResumeSession(ME, 'client');
    expect(next.id).not.toBe(s.id);
    expect(next.day_key).toBe(dayKeyUtc());
    expect((await svc.listMessages(ME, next.id, {})).messages).toHaveLength(0);
    await svc.appendMessage(ME, next.id, { role: 'user', content: 'second chat' });
    const all = await prisma.romanMessage.findMany({ where: { user_id: ME.id } });
    expect(all.map((m) => m.content)).toEqual(['second chat']);
  });

  it('concurrent opens after a delete converge on one fresh session', async () => {
    const s = await svc.openOrResumeSession(ME, 'client');
    await svc.deleteSession(ME, s.id);
    const opened = await Promise.all(
      Array.from({ length: 6 }, () => svc.openOrResumeSession(ME, 'client')),
    );
    expect(new Set(opened.map((o) => o.id)).size).toBe(1);
    expect(await prisma.romanSession.count({ where: { user_id: ME.id, deleted_at: null } })).toBe(
      1,
    );
  });

  it('the old deleted session stays deleted: a late append to it is a 404 and stores nothing', async () => {
    const s = await svc.openOrResumeSession(ME, 'client');
    await svc.deleteSession(ME, s.id);
    await svc.openOrResumeSession(ME, 'client');
    await expect(
      svc.appendMessage(ME, s.id, { role: 'roman', content: 'late reply' }),
    ).rejects.toThrow('Roman session not found');
    expect(await prisma.romanMessage.count({ where: { session_id: s.id } })).toBe(0);
  });

  it('a delete racing an append leaves no transcript behind', async () => {
    for (let i = 0; i < 5; i++) {
      const s = await svc.openOrResumeSession(ME, 'client');
      await svc.appendMessage(ME, s.id, { role: 'user', content: `q${i}` });
      await Promise.allSettled([
        svc.deleteSession(ME, s.id),
        svc.appendMessage(ME, s.id, { role: 'roman', content: `racing reply ${i}` }),
      ]);
      expect(await prisma.romanMessage.count({ where: { session_id: s.id } })).toBe(0);
    }
  });

  it('delete + reopen never resets the daily cap', async () => {
    const s = await svc.openOrResumeSession(ME, 'client');
    await prisma.romanMessage.createMany({
      data: Array.from({ length: ROMAN_RATE_LIMIT_FREE_PER_DAY }, (_, i) => ({
        session_id: s.id,
        user_id: ME.id,
        role: 'user' as const,
        content: `t${i}`,
      })),
    });
    await svc.deleteSession(ME, s.id);
    await svc.openOrResumeSession(ME, 'client');
    await expect(svc.assertWithinRateLimit(ME)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
    await expect(svc.assertWithinRateLimit(OTHER)).resolves.toBeUndefined();
  });

  it("C-635-1: a legacy tombstone holding today's key is erased on open and a fresh session opens", async () => {
    const legacy = await seedLegacyTombstone(ME.id, dayKeyUtc(), 2);
    const s = await svc.openOrResumeSession(ME, 'client');
    expect(s.id).not.toBe(legacy);
    const tomb = await prisma.romanSession.findUniqueOrThrow({ where: { id: legacy } });
    expect(tomb.day_key).toBe(erasedDayKey(legacy));
    expect(tomb.subject_context_json).toBeNull();
    expect(tomb.message_count).toBe(2);
    expect(await prisma.romanMessage.count({ where: { session_id: legacy } })).toBe(0);
  });

  it('C-635-1: the sweep erases every legacy tombstone, is idempotent, and leaves live chats alone', async () => {
    const a = await seedLegacyTombstone(ME.id, '2026-09-28', 1);
    const b = await seedLegacyTombstone(OTHER.id, '2026-09-29', 3);
    const live = await svc.openOrResumeSession(ME, 'client');
    await svc.appendMessage(ME, live.id, { role: 'user', content: 'keep this live chat' });

    await expect(svc.eraseUnerasedDeletedSessions({ batch: 1 })).resolves.toBe(2);
    for (const sid of [a, b]) {
      const row = await prisma.romanSession.findUniqueOrThrow({ where: { id: sid } });
      expect(row.day_key).toBe(erasedDayKey(sid));
      expect(row.subject_context_json).toBeNull();
    }
    const left = await prisma.romanMessage.findMany({});
    expect(left.map((m) => m.content)).toEqual(['keep this live chat']);
    await expect(svc.eraseUnerasedDeletedSessions()).resolves.toBe(0);
  });
});
