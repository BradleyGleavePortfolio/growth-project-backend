/**
 * A3-MSG-CORE live RLS proof (migration 20270303000000_messaging_core_actions),
 * as a NON-BYPASSRLS principal (`SET LOCAL ROLE authenticated` + the
 * app.current_user_id / app.current_user_role GUCs the policies read) on a
 * database migrated with the real chain (`prisma migrate deploy`, CI job
 * community-live-tests).
 *
 * CoachThreadState (new table, private per-user thread preferences):
 *  - a participant reads and writes ONLY their own rows; the other participant
 *    of the same thread, another coach's client and another coach see none;
 *  - nobody can write a row for someone else, or for a thread they are not on;
 *  - an owner-staff principal reads every row;
 *  - RLS is ENABLE + FORCE.
 * CoachMessage (new columns under the existing participant policy):
 *  - pins / reply / tombstone columns are readable by thread participants
 *    only (a stranger sees no row of the thread, so no column leaks);
 *  - UNIQUE (sender_id, client_message_id) rejects a duplicate offline send;
 *  - reply_to_id is ON DELETE SET NULL (erasing the quoted row never
 *    cascades into the reply).
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged reason
 * when unset, e.g. in build-and-test). The required community-live-tests job
 * sets it and lists this file explicitly, so it always executes there.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { liveDbUrl } from '../../community/_support/community-db';
import { insertLiveUser } from '../../community/_support/community-live-seed';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[coach-thread-state-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS spec skipped.',
  );
}

itLive('CoachThreadState + CoachMessage v2 columns RLS as authenticated (live DB)', () => {
  let prisma: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const id = {
    coach: randomUUID(),
    client: randomUUID(),
    otherClient: randomUUID(),
    otherCoach: randomUUID(),
    stranger: randomUUID(),
    owner: randomUUID(),
  };
  const msg = { quoted: randomUUID(), reply: randomUUID(), pinned: randomUUID() };
  const state = { client: '', coach: '' };

  async function as<T>(
    userId: string,
    role: 'student' | 'coach' | 'owner',
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$queryRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      await tx.$queryRaw`SELECT set_config('app.current_user_role', ${role}, true)`;
      return fn(tx);
    });
  }

  async function visibleStates(userId: string, role: 'student' | 'coach' | 'owner') {
    return as(userId, role, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "CoachThreadState" WHERE id = ANY(${Object.values(state)}::text[])`;
      return rows.map((r) => r.id).sort();
    });
  }

  async function insertStateAs(
    actor: string,
    role: 'student' | 'coach',
    row: { user_id: string; coach_id: string; client_id: string },
  ): Promise<void> {
    await as(actor, role, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "CoachThreadState" (id, user_id, coach_id, client_id, muted_until, updated_at)
        VALUES (${randomUUID()}, ${row.user_id}, ${row.coach_id}, ${row.client_id}, now(), now())`;
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: liveDbUrl() as string } } });
    await prisma.$connect();
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO authenticated');
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "CoachThreadState" TO authenticated',
    );
    await prisma.$executeRawUnsafe('GRANT SELECT ON "CoachMessage" TO authenticated');
    await prisma.$executeRawUnsafe('GRANT SELECT ON "User" TO authenticated');

    const users: Array<[string, Role, string | null]> = [
      [id.coach, 'coach', null],
      [id.otherCoach, 'coach', null],
      [id.owner, 'owner', null],
      [id.client, 'student', id.coach],
      [id.otherClient, 'student', id.coach],
      [id.stranger, 'student', id.otherCoach],
    ];
    for (const [uid, role, coachId] of users) {
      await insertLiveUser(prisma, { id: uid, role, name: `A3 ${role} ${tag}`, coachId });
    }

    state.client = (
      await prisma.coachThreadState.create({
        data: {
          user_id: id.client,
          coach_id: id.coach,
          client_id: id.client,
          muted_until: new Date(),
        },
      })
    ).id;
    state.coach = (
      await prisma.coachThreadState.create({
        data: {
          user_id: id.coach,
          coach_id: id.coach,
          client_id: id.client,
          pinned_at: new Date(),
        },
      })
    ).id;

    await prisma.coachMessage.create({
      data: {
        id: msg.quoted,
        coach_id: id.coach,
        client_id: id.client,
        sender_id: id.coach,
        body: 'Quoted',
      },
    });
    await prisma.coachMessage.create({
      data: {
        id: msg.reply,
        coach_id: id.coach,
        client_id: id.client,
        sender_id: id.client,
        body: 'Reply',
        reply_to_id: msg.quoted,
        client_message_id: `${tag}-key`,
      },
    });
    await prisma.coachMessage.create({
      data: {
        id: msg.pinned,
        coach_id: id.coach,
        client_id: id.client,
        sender_id: id.coach,
        body: 'Pinned',
        pinned_at: new Date(),
        pinned_by_id: id.client,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const users = Object.values(id);
    await prisma.$executeRaw`DELETE FROM "CoachMessage" WHERE coach_id = ANY(${users}::text[])`;
    await prisma.$executeRaw`DELETE FROM "CoachThreadState" WHERE user_id = ANY(${users}::text[])`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ANY(${users}::text[])`;
    await prisma.$disconnect();
  });

  it('RLS is ENABLE + FORCE on CoachThreadState', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'CoachThreadState'`;
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('each participant sees only their own preference row for the shared thread', async () => {
    expect(await visibleStates(id.client, 'student')).toEqual([state.client]);
    expect(await visibleStates(id.coach, 'coach')).toEqual([state.coach]);
  });

  it('a teammate client, another tenant and another coach see nothing', async () => {
    expect(await visibleStates(id.otherClient, 'student')).toEqual([]);
    expect(await visibleStates(id.stranger, 'student')).toEqual([]);
    expect(await visibleStates(id.otherCoach, 'coach')).toEqual([]);
  });

  it('owner staff reads every row', async () => {
    expect(await visibleStates(id.owner, 'owner')).toEqual([state.client, state.coach].sort());
  });

  it('nobody can write a row for someone else', async () => {
    await expect(
      insertStateAs(id.client, 'student', {
        user_id: id.coach,
        coach_id: id.coach,
        client_id: id.client,
      }),
    ).rejects.toThrow(/42501|row-level security/);
  });

  it('nobody can write a row for a thread they are not on', async () => {
    await expect(
      insertStateAs(id.stranger, 'student', {
        user_id: id.stranger,
        coach_id: id.coach,
        client_id: id.client,
      }),
    ).rejects.toThrow(/42501|row-level security/);
    await expect(
      insertStateAs(id.otherCoach, 'coach', {
        user_id: id.otherCoach,
        coach_id: id.coach,
        client_id: id.client,
      }),
    ).rejects.toThrow(/42501|row-level security/);
  });

  it("a participant cannot change or delete the other participant's row", async () => {
    const changed = await as(
      id.client,
      'student',
      (tx) =>
        tx.$executeRaw`UPDATE "CoachThreadState" SET pinned_at = NULL WHERE id = ${state.coach}`,
    );
    expect(changed).toBe(0);
    const removed = await as(
      id.client,
      'student',
      (tx) => tx.$executeRaw`DELETE FROM "CoachThreadState" WHERE id = ${state.coach}`,
    );
    expect(removed).toBe(0);
    const still = await prisma.coachThreadState.findUnique({ where: { id: state.coach } });
    expect(still?.pinned_at).not.toBeNull();
  });

  it('pin / reply columns are visible to participants and to no one else', async () => {
    const read = (uid: string, role: 'student' | 'coach') =>
      as(
        uid,
        role,
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string; reply_to_id: string | null; pinned_by_id: string | null }>
          >`
          SELECT id, reply_to_id, pinned_by_id FROM "CoachMessage"
           WHERE id = ANY(${Object.values(msg)}::text[]) ORDER BY id`,
      );
    expect((await read(id.client, 'student')).length).toBe(3);
    expect((await read(id.coach, 'coach')).find((r) => r.id === msg.reply)?.reply_to_id).toBe(
      msg.quoted,
    );
    expect(await read(id.stranger, 'student')).toEqual([]);
    expect(await read(id.otherClient, 'student')).toEqual([]);
    expect(await read(id.otherCoach, 'coach')).toEqual([]);
  });

  it('UNIQUE (sender_id, client_message_id) rejects a duplicate offline send', async () => {
    await expect(
      prisma.coachMessage.create({
        data: {
          coach_id: id.coach,
          client_id: id.client,
          sender_id: id.client,
          body: 'Reply',
          client_message_id: `${tag}-key`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // The same key from a DIFFERENT sender is a different send.
    await expect(
      prisma.coachMessage.create({
        data: {
          coach_id: id.coach,
          client_id: id.client,
          sender_id: id.coach,
          body: 'Other sender',
          client_message_id: `${tag}-key`,
        },
      }),
    ).resolves.toMatchObject({ sender_id: id.coach });
  });

  it('erasing the quoted row sets reply_to_id NULL on the reply (no cascade)', async () => {
    await prisma.coachMessage.delete({ where: { id: msg.quoted } });
    const reply = await prisma.coachMessage.findUnique({ where: { id: msg.reply } });
    expect(reply).not.toBeNull();
    expect(reply?.reply_to_id).toBeNull();
  });
});
