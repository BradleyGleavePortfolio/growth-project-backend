/**
 * Sol B-635-1 / C-635-1 (and fix round 2: B-635-2 list + delete any chat,
 * C-635-2 coded/idempotent delete, C-635-3 verified erase under RLS) live proof
 * on real Postgres: the unique index
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
    ).rejects.toMatchObject({ response: { code: 'ROMAN_SESSION_NOT_FOUND' } });
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

  // ─── B-635-2: any chat can be found and deleted, not only today's ─────────
  const DAY = 24 * 60 * 60 * 1000;

  async function seedChat(
    userId: string,
    surface: 'client' | 'coach',
    dayKey: string,
    startedAt: Date,
    contents: string[],
  ) {
    const s = await prisma.romanSession.create({
      data: {
        user_id: userId,
        surface,
        day_key: dayKey,
        started_at: startedAt,
        message_count: contents.length,
        subject_context_json: { brief: `private context ${dayKey}` },
      },
    });
    await prisma.romanMessage.createMany({
      data: contents.map((content) => ({
        session_id: s.id,
        user_id: userId,
        role: 'user' as const,
        content,
      })),
    });
    return s.id;
  }

  it('B-635-2: the list pages every live chat newest first; delete-all erases prior days and today on both surfaces, nobody else, cap kept', async () => {
    const old = await seedChat(ME.id, 'client', '2026-09-20', new Date(Date.now() - 12 * DAY), [
      'old question',
      ...Array.from({ length: ROMAN_RATE_LIMIT_FREE_PER_DAY - 4 }, (_, i) => `o${i}`),
    ]);
    const coach = await seedChat(ME.id, 'coach', '2026-09-30', new Date(Date.now() - 2 * DAY), [
      'coach-surface question',
    ]);
    const today = await svc.openOrResumeSession(ME, 'client', { brief: 'today context' });
    await svc.appendMessage(ME, today.id, { role: 'user', content: 'today question' });
    const theirs = await svc.openOrResumeSession(OTHER, 'client');
    await svc.appendMessage(OTHER, theirs.id, {
      role: 'user',
      content: 'another client keeps this',
    });

    const first = await svc.listSessions(ME, { limit: 2 });
    expect(first.sessions.map((s) => s.id)).toEqual([today.id, coach]);
    const second = await svc.listSessions(ME, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.sessions.map((s) => s.id)).toEqual([old]);
    expect(second.nextCursor).toBeNull();
    await expect(svc.listSessions(ME, { cursor: theirs.id })).rejects.toMatchObject({
      response: { code: 'ROMAN_CURSOR_INVALID' },
    });

    await expect(svc.deleteAllSessions(ME)).resolves.toBe(3);

    for (const sid of [old, coach, today.id]) {
      const row = await prisma.romanSession.findUniqueOrThrow({ where: { id: sid } });
      expect(row.day_key).toBe(erasedDayKey(sid));
      expect(row.subject_context_json).toBeNull();
      expect(row.deleted_at).toBeInstanceOf(Date);
    }
    expect(await prisma.romanMessage.count({ where: { user_id: ME.id } })).toBe(0);
    expect((await svc.listSessions(ME, {})).sessions).toHaveLength(0);
    // Tenancy: the other client's chat is live and whole.
    const other = await prisma.romanMessage.findMany({ where: { user_id: OTHER.id } });
    expect(other.map((m) => m.content)).toEqual(['another client keeps this']);
    expect(
      (await prisma.romanSession.findUniqueOrThrow({ where: { id: theirs.id } })).deleted_at,
    ).toBeNull();
    // The cap is not reset: 47 + 1 + 1 erased user turns plus this one is the
    // free cap (without the erased counts it would be 1 of 50).
    const fresh = await svc.openOrResumeSession(ME, 'client');
    await svc.appendMessage(ME, fresh.id, { role: 'user', content: 'after delete-all' });
    await expect(svc.assertWithinRateLimit(ME)).rejects.toMatchObject({
      response: { code: 'ROMAN_RATE_LIMIT' },
    });
    // Nothing left to delete except the fresh chat; a repeat is harmless.
    await expect(svc.deleteAllSessions(ME)).resolves.toBe(1);
    await expect(svc.deleteAllSessions(ME)).resolves.toBe(0);
  });

  it('B-635-2 / C-635-2: a prior-day chat is erased by id; a repeat delete is a 204; a foreign id is the coded 404', async () => {
    const old = await seedChat(ME.id, 'client', '2026-09-21', new Date(Date.now() - 11 * DAY), [
      'yesterday-ish question',
    ]);
    const theirs = await seedChat(
      OTHER.id,
      'client',
      '2026-09-21',
      new Date(Date.now() - 11 * DAY),
      ['not yours'],
    );
    await svc.deleteSession(ME, old);
    const row = await prisma.romanSession.findUniqueOrThrow({ where: { id: old } });
    expect(row.day_key).toBe(erasedDayKey(old));
    expect(row.subject_context_json).toBeNull();
    expect(await prisma.romanMessage.count({ where: { session_id: old } })).toBe(0);
    await expect(svc.deleteSession(ME, old)).resolves.toBeUndefined();
    await expect(svc.deleteSession(ME, theirs)).rejects.toMatchObject({
      status: 404,
      response: { code: 'ROMAN_SESSION_NOT_FOUND' },
    });
    expect(await prisma.romanMessage.count({ where: { session_id: theirs } })).toBe(1);
  });

  // ─── C-635-3: the erase is verified on a real database ────────────────────
  it('C-635-3: under a role that RLS stops from deleting, delete is a coded 503 and the chat is left whole', async () => {
    const ROLE = 'b635_rls_probe';
    await prisma.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    );
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "RomanSession", "RomanMessage" TO ${ROLE}`,
    );
    // Production shape (20261216000000_add_roman_chat): RomanMessage has RLS
    // and a read policy, but no DELETE policy for a non-service role, so a
    // DELETE by that role removes zero rows WITHOUT an error.
    await prisma.$executeRawUnsafe(`ALTER TABLE "RomanMessage" ENABLE ROW LEVEL SECURITY`);
    await prisma.$executeRawUnsafe(
      `CREATE POLICY b635_probe_read ON "RomanMessage" FOR SELECT TO ${ROLE} USING (true)`,
    );
    const rlsPrisma = new PrismaService({ datasources: { db: { url: withPool(TEST_DB_URL) } } });
    await rlsPrisma.$connect();
    try {
      const realTx = rlsPrisma.$transaction.bind(rlsPrisma);
      jest.spyOn(rlsPrisma, '$transaction').mockImplementation((fn, options) =>
        realTx(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`);
          return fn(tx);
        }, options),
      );
      const rlsSvc = new RomanService(rlsPrisma, grantAllEgress());

      // Negative control: the role really deletes nothing, silently.
      const probe = await seedChat(ME.id, 'client', '2026-09-22', new Date(), ['probe']);
      const silent = await rlsPrisma.$transaction((tx) =>
        tx.romanMessage.deleteMany({ where: { session_id: probe } }),
      );
      expect(silent.count).toBe(0);
      expect(await prisma.romanMessage.count({ where: { session_id: probe } })).toBe(1);

      const s = await svc.openOrResumeSession(ME, 'client', { brief: 'keep until really erased' });
      await svc.appendMessage(ME, s.id, { role: 'user', content: 'still here' });
      await expect(rlsSvc.deleteSession(ME, s.id)).rejects.toMatchObject({
        status: 503,
        response: { code: 'ROMAN_ERASE_INCOMPLETE' },
      });
      // Rolled back: still live, still on today's key, transcript intact.
      const row = await prisma.romanSession.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.deleted_at).toBeNull();
      expect(row.day_key).toBe(dayKeyUtc());
      expect(await prisma.romanMessage.count({ where: { session_id: s.id } })).toBe(1);
      // The same chat erases normally once the role can delete.
      await svc.deleteSession(ME, s.id);
      expect(await prisma.romanMessage.count({ where: { session_id: s.id } })).toBe(0);
    } finally {
      await rlsPrisma.$disconnect();
      await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS b635_probe_read ON "RomanMessage"`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "RomanMessage" DISABLE ROW LEVEL SECURITY`);
    }
  });
});
