/**
 * Roman v1.1 slice R11-M1 live proof on real Postgres (plan decision 9):
 * deleting a chat erases its messages and keeps the notes Roman took from it,
 * with a null source; another client's note and chat are untouched; one
 * summary per (client, period, period_start).
 *
 * Runs RomanService.deleteSession / deleteAllSessions (the real erase path)
 * against a Prisma-faithful schema built by the shared bootstrap helper
 * (`prisma migrate diff --from-empty` of schema.prisma, so the FK actions are
 * the real ones). Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI
 * job); skipped with a logged reason elsewhere.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { RomanCaller, RomanService } from '../../src/roman/roman.service';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('[r11-memory-schema.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.');
}

const A: RomanCaller = { id: 'r11-m1-live-a', role: 'student', tier: 'free' };
const B: RomanCaller = { id: 'r11-m1-live-b', role: 'student', tier: 'free' };

liveDescribe('R11-M1 live: a deleted chat keeps Roman notes with a null source (Postgres)', () => {
  let prisma: PrismaService;
  let svc: RomanService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    svc = new RomanService(prisma, grantAllEgress());
    for (const c of [A, B]) {
      await prisma.user.create({
        data: { id: c.id, supabase_id: `sb-${c.id}`, email: `${c.id}@example.test`, name: 'Client' },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.romanClientNote.deleteMany({});
    await prisma.romanClientSummary.deleteMany({});
    await prisma.romanMessage.deleteMany({});
    await prisma.romanSession.deleteMany({});
  });

  /** A chat with one client message and a note Roman took from it. */
  async function chatWithNote(caller: RomanCaller, text: string) {
    const session = await svc.openOrResumeSession(caller, 'client');
    const message = await svc.appendMessage(caller, session.id, { role: 'user', content: text });
    const note = await prisma.romanClientNote.create({
      data: {
        client_id: caller.id,
        kind: 'diet_dislike',
        key: 'diet_dislike.oats',
        text: 'Dislikes oats.',
        source_message_id: message.id,
        source_at: message.created_at,
      },
    });
    return { session, message, note };
  }

  it('deleting the chat erases the message and keeps the note with a null source', async () => {
    const mine = await chatWithNote(A, 'I really do not like oats');
    const theirs = await chatWithNote(B, 'Oats are not for me');

    await svc.deleteSession(A, mine.session.id);

    expect(await prisma.romanMessage.count({ where: { session_id: mine.session.id } })).toBe(0);
    const kept = await prisma.romanClientNote.findUniqueOrThrow({ where: { id: mine.note.id } });
    expect(kept).toMatchObject({
      client_id: A.id,
      text: 'Dislikes oats.',
      source_message_id: null,
    });
    const other = await prisma.romanClientNote.findUniqueOrThrow({ where: { id: theirs.note.id } });
    expect(other.source_message_id).toBe(theirs.message.id);
    expect(await prisma.romanMessage.count({ where: { session_id: theirs.session.id } })).toBe(1);
  });

  it('deleting every chat keeps every note', async () => {
    const mine = await chatWithNote(A, 'No oats please');
    expect(await svc.deleteAllSessions(A)).toBeGreaterThanOrEqual(1);
    expect(await prisma.romanMessage.count({ where: { user_id: A.id } })).toBe(0);
    const kept = await prisma.romanClientNote.findUniqueOrThrow({ where: { id: mine.note.id } });
    expect(kept.source_message_id).toBeNull();
  });

  it('allows one summary per client, period and start date', async () => {
    const row = {
      client_id: A.id,
      period: 'day',
      period_start: new Date('2026-10-01T00:00:00Z'),
      text: 'One session done.',
      facts: { sessions_done: 1 },
      input_hash: 'a'.repeat(64),
      model_id: 'background-model',
    };
    await prisma.romanClientSummary.create({ data: row });
    await prisma.romanClientSummary.create({ data: { ...row, client_id: B.id } });
    const err = await prisma.romanClientSummary
      .create({ data: row })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });
});
