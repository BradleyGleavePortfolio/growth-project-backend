/**
 * A5-COACH-BRIEF — live RLS proof for "RomanReplyDraft" (migration
 * 20270305000000_coach_brief_roman_drafts), on a database migrated with the
 * real chain (`prisma migrate deploy`, CI job community-live-tests).
 *
 * Posture: RLS enabled + FORCED, one policy (service_role bypass). The API
 * reads and writes this table only through the server connection; no
 * authenticated or anon principal (the coach, the client, a stranger) may
 * select, insert, update or delete a row, even its own.
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged reason
 * when unset; never a silent pass in CI, where the job sets it).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { liveDbUrl } from '../community/_support/community-db';
import { insertLiveUser } from '../community/_support/community-live-seed';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[roman-reply-draft-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS spec skipped.',
  );
}

itLive('RomanReplyDraft RLS (live DB, A5-COACH-BRIEF)', () => {
  let prisma: PrismaClient;
  const id = { coach: randomUUID(), client: randomUUID(), stranger: randomUUID() };
  let messageId = '';
  let aiDraftId = '';
  let claimId = '';

  async function as<T>(
    userId: string,
    role: 'coach' | 'student',
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    pgRole: 'authenticated' | 'anon' = 'authenticated',
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${pgRole}`);
      await tx.$queryRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.current_user_role', ${role}, true)`;
      return fn(tx);
    });
  }

  async function visibleCount(
    userId: string,
    role: 'coach' | 'student',
    pgRole: 'authenticated' | 'anon' = 'authenticated',
  ): Promise<number> {
    return as(
      userId,
      role,
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*)::bigint AS n FROM "RomanReplyDraft"`;
        return Number(rows[0].n);
      },
      pgRole,
    );
  }

  /** Refused outright, or the row is not visible to the writer (0 rows). */
  async function expectNoEffect(p: Promise<number>): Promise<void> {
    const outcome = await p.then(
      (n) => n,
      (e: unknown) => (/42501|row-level security|permission denied/.test(String(e)) ? 0 : -1),
    );
    expect(outcome).toBe(0);
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: liveDbUrl() ?? '' } } });
    // Supabase grants table privileges on public tables to anon and
    // authenticated by default; mirror that so RLS (not a missing GRANT) is
    // what refuses below. Test database only.
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "RomanReplyDraft" TO authenticated, anon',
    );
    await insertLiveUser(prisma, {
      id: id.coach,
      role: Role.coach,
      name: 'Roman Coach',
      coachId: null,
    });
    await insertLiveUser(prisma, {
      id: id.client,
      role: Role.student,
      name: 'Roman Client',
      coachId: id.coach,
    });
    await insertLiveUser(prisma, {
      id: id.stranger,
      role: Role.student,
      name: 'Stranger',
      coachId: null,
    });
    const msg = await prisma.coachMessage.create({
      data: { coach_id: id.coach, client_id: id.client, sender_id: id.client, body: 'rls fixture' },
    });
    messageId = msg.id;
    const draft = await prisma.aiActionDraft.create({
      data: {
        capability: 'draft.coach_message',
        payload: { clientId: id.client, body: 'fixture reply' },
        tenant_coach_id: id.coach,
        subject_user_id: id.client,
      },
    });
    aiDraftId = draft.id;
    const claim = await prisma.romanReplyDraft.create({
      data: {
        coach_id: id.coach,
        client_id: id.client,
        source_message_id: messageId,
        ai_draft_id: aiDraftId,
        status: 'ready',
        category: 'question',
        urgency: 'today',
        generated_at: new Date(),
      },
    });
    claimId = claim.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.romanReplyDraft.deleteMany({ where: { coach_id: id.coach } });
    await prisma.aiActionDraft.deleteMany({ where: { id: aiDraftId } });
    await prisma.coachMessage.deleteMany({ where: { id: messageId } });
    await prisma.user.deleteMany({ where: { id: { in: [id.client, id.stranger, id.coach] } } });
    await prisma.$disconnect();
  });

  it('RLS is enabled and forced, with exactly the service_role bypass policy', async () => {
    const rel = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'RomanReplyDraft'`;
    expect(rel).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await prisma.$queryRaw<Array<{ policyname: string; roles: string[] }>>`
      SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = 'RomanReplyDraft'`;
    expect(policies).toEqual([
      { policyname: 'roman_reply_draft_service_role_bypass', roles: ['service_role'] },
    ]);
  });

  it('the server connection sees the fixture row (populated table)', async () => {
    expect(await prisma.romanReplyDraft.count({ where: { id: claimId } })).toBe(1);
  });

  it('no authenticated or anon principal can read a row, not even the owning coach or the client', async () => {
    expect(await visibleCount(id.coach, 'coach')).toBe(0);
    expect(await visibleCount(id.client, 'student')).toBe(0);
    expect(await visibleCount(id.stranger, 'student')).toBe(0);
    expect(await visibleCount(id.stranger, 'student', 'anon')).toBe(0);
  });

  it('no authenticated principal can insert, update or delete', async () => {
    await expectNoEffect(
      as(
        id.coach,
        'coach',
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "RomanReplyDraft" (id, coach_id, client_id, source_message_id, status, updated_at)
          VALUES (${randomUUID()}, ${id.coach}, ${id.client}, ${messageId}, 'generating', now())`,
      ),
    );
    await expectNoEffect(
      as(
        id.coach,
        'coach',
        (tx) =>
          tx.$executeRaw`UPDATE "RomanReplyDraft" SET status = 'failed' WHERE id = ${claimId}`,
      ),
    );
    await expectNoEffect(
      as(
        id.client,
        'student',
        (tx) => tx.$executeRaw`DELETE FROM "RomanReplyDraft" WHERE id = ${claimId}`,
      ),
    );
    const row = await prisma.romanReplyDraft.findUnique({ where: { id: claimId } });
    expect(row?.status).toBe('ready');
  });

  it('the table constraints hold: one claim per (coach, source message), closed status set', async () => {
    await expect(
      prisma.romanReplyDraft.create({
        data: { coach_id: id.coach, client_id: id.client, source_message_id: messageId },
      }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(
      prisma.$executeRaw`UPDATE "RomanReplyDraft" SET status = 'sent' WHERE id = ${claimId}`,
    ).rejects.toThrow(/check constraint|23514/i);
    await expect(
      prisma.$executeRaw`UPDATE "RomanReplyDraft" SET ai_draft_id = NULL WHERE id = ${claimId}`,
    ).rejects.toThrow(/check constraint|23514/i);
  });
});
