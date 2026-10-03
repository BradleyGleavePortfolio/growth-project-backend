/**
 * A6-PHOTOS live RLS proof for "message_photos" and "message_photo_erasures",
 * as the NON-BYPASSRLS `authenticated` role (`SET LOCAL ROLE authenticated` +
 * the app.current_user_id GUC the policies read), on a database migrated with
 * the real chain (`prisma migrate deploy`, CI job community-live-tests).
 *
 * The backend reads and writes with service_role; these policies are the
 * floor if a JWT-bound client ever reaches the table directly:
 *  - only the two thread parties read a ready photo; a stranger, another
 *    client of the same coach and another coach read nothing;
 *  - pending, rejected and removed photos are invisible to everyone;
 *  - an unsent photo is the uploader's alone;
 *  - a reporter stops seeing the reported message's photos at once, the other
 *    party still does; a blocker stops seeing the blocked uploader's photos;
 *  - authenticated cannot insert, update or delete photos, even with table
 *    grants (restrictive policies), and cannot touch erasure rows at all;
 *  - anon reads nothing.
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged reason
 * when unset; never a silent pass).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { liveDbUrl } from '../community/_support/community-db';
import { insertLiveUser } from '../community/_support/community-live-seed';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn('[message-photos-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS spec skipped.');
}

itLive('message_photos RLS as authenticated (live DB, A6-PHOTOS)', () => {
  let prisma: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const id = {
    coach: randomUUID(),
    otherCoach: randomUUID(),
    client: randomUUID(),
    sibling: randomUUID(),
    stranger: randomUUID(),
    reporterClient: randomUUID(),
  };
  const msg = { coachToClient: '', clientToCoach: '', reported: '' };
  const photo = {
    fromCoach: '',
    fromClient: '',
    pending: '',
    removed: '',
    rejected: '',
    unsent: '',
    reported: '',
  };

  async function as<T>(
    userId: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    role: 'authenticated' | 'anon' = 'authenticated',
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      if (userId) await tx.$queryRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx);
    });
  }

  async function visible(
    userId: string | null,
    role: 'authenticated' | 'anon' = 'authenticated',
  ): Promise<string[]> {
    return as(
      userId,
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id FROM "message_photos" WHERE id::text = ANY(${Object.values(photo)}::text[])`;
        return rows.map((r) => r.id).sort();
      },
      role,
    );
  }

  const sorted = (...ids: string[]) => [...ids].sort();

  async function photoRow(over: {
    uploader: string;
    coach: string;
    client: string;
    message?: string | null;
    status?: string;
    removed?: boolean;
  }): Promise<string> {
    const pid = randomUUID();
    await prisma.messagePhoto.create({
      data: {
        id: pid,
        uploader_id: over.uploader,
        coach_id: over.coach,
        client_id: over.client,
        message_id: over.message ?? null,
        status: over.status ?? 'ready',
        staging_key: `${over.uploader}/staging/${pid}-0123456789abcdef`,
        storage_key: `${over.uploader}/${pid}-0123456789abcdef.jpg`,
        declared_content_type: 'image/jpeg',
        declared_size_bytes: 1000,
        upload_expires_at: new Date(Date.now() + 600_000),
        removed_at: over.removed ? new Date() : null,
      },
    });
    return pid;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: liveDbUrl() as string } } });
    await prisma.$connect();
    // Supabase grants table privileges to API roles by default; the bare CI
    // Postgres does not. Grant everything so the POLICIES are under test.
    await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO authenticated, anon');
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "message_photos" TO authenticated, anon',
    );
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "message_photo_erasures" TO authenticated',
    );

    const users: Array<[string, Role, string | null]> = [
      [id.coach, 'coach', null],
      [id.otherCoach, 'coach', null],
      [id.client, 'student', id.coach],
      [id.sibling, 'student', id.coach],
      [id.stranger, 'student', id.otherCoach],
      [id.reporterClient, 'student', id.coach],
    ];
    for (const [uid, role, coachId] of users) {
      await insertLiveUser(prisma, { id: uid, role, name: `Photos ${role} ${tag}`, coachId });
    }
    const message = async (coach: string, client: string, sender: string) =>
      (
        await prisma.coachMessage.create({
          data: { coach_id: coach, client_id: client, sender_id: sender, body: null },
        })
      ).id;
    msg.coachToClient = await message(id.coach, id.client, id.coach);
    msg.clientToCoach = await message(id.coach, id.client, id.client);
    msg.reported = await message(id.coach, id.reporterClient, id.coach);

    photo.fromCoach = await photoRow({
      uploader: id.coach,
      coach: id.coach,
      client: id.client,
      message: msg.coachToClient,
    });
    photo.fromClient = await photoRow({
      uploader: id.client,
      coach: id.coach,
      client: id.client,
      message: msg.clientToCoach,
    });
    photo.pending = await photoRow({
      uploader: id.client,
      coach: id.coach,
      client: id.client,
      status: 'pending',
    });
    photo.rejected = await photoRow({
      uploader: id.client,
      coach: id.coach,
      client: id.client,
      status: 'rejected',
    });
    photo.removed = await photoRow({
      uploader: id.client,
      coach: id.coach,
      client: id.client,
      message: msg.clientToCoach,
      status: 'removed',
      removed: true,
    });
    photo.unsent = await photoRow({ uploader: id.client, coach: id.coach, client: id.client });
    photo.reported = await photoRow({
      uploader: id.coach,
      coach: id.coach,
      client: id.reporterClient,
      message: msg.reported,
    });
    await prisma.messageReport.create({
      data: {
        reporter_id: id.reporterClient,
        message_id: msg.reported,
        coach_id: id.coach,
        client_id: id.reporterClient,
        reason: 'harassment',
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRaw`DELETE FROM "message_photos" WHERE id::text = ANY(${Object.values(photo)}::text[])`;
    await prisma.$executeRaw`DELETE FROM "message_photo_erasures" WHERE target LIKE ${`%${tag}%`}`;
    await prisma.$executeRaw`DELETE FROM "UserBlock" WHERE blocker_id = ANY(${Object.values(id)}::text[])`;
    await prisma.$executeRaw`DELETE FROM "MessageReport" WHERE message_id = ANY(${Object.values(msg)}::text[])`;
    await prisma.$executeRaw`DELETE FROM "CoachMessage" WHERE id = ANY(${Object.values(msg)}::text[])`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ANY(${Object.values(id)}::text[])`;
    await prisma.$disconnect();
  });

  it('RLS is enabled and forced on both tables', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('message_photos', 'message_photo_erasures') ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'message_photo_erasures', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'message_photos', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('only the thread parties read sent, ready photos; the uploader also sees their unsent one', async () => {
    expect(await visible(id.client)).toEqual(
      sorted(photo.fromCoach, photo.fromClient, photo.unsent),
    );
    expect(await visible(id.coach)).toEqual(
      sorted(photo.fromCoach, photo.fromClient, photo.reported),
    );
  });

  it('strangers, sibling clients and other coaches read nothing; anon reads nothing', async () => {
    expect(await visible(id.stranger)).toEqual([]);
    expect(await visible(id.sibling)).toEqual([]);
    expect(await visible(id.otherCoach)).toEqual([]);
    expect(await visible(null)).toEqual([]);
    await expect(visible(null, 'anon')).resolves.toEqual([]);
  });

  it('a reported photo hides for the reporter at once', async () => {
    expect(await visible(id.reporterClient)).toEqual([]);
    // ... and is still visible to the other party (the coach) for review context.
    expect(await visible(id.coach)).toContain(photo.reported);
  });

  it("a block hides the blocked uploader's photos from the blocker", async () => {
    await prisma.userBlock.create({ data: { blocker_id: id.client, blocked_id: id.coach } });
    try {
      expect(await visible(id.client)).toEqual(sorted(photo.fromClient, photo.unsent));
    } finally {
      await prisma.$executeRaw`DELETE FROM "UserBlock" WHERE blocker_id = ${id.client}`;
    }
  });

  it('authenticated cannot insert, update or delete photos, even with table grants', async () => {
    const denied = /42501|row-level security|permission denied/;
    await expect(
      as(
        id.client,
        (tx) =>
          tx.$executeRaw`INSERT INTO "message_photos" (id, uploader_id, coach_id, client_id, staging_key, declared_content_type, declared_size_bytes, upload_expires_at, status)
          VALUES (${randomUUID()}::uuid, ${id.client}, ${id.coach}, ${id.client}, ${`${id.client}/staging/x-${tag}`}, 'image/jpeg', 1, now(), 'ready')`,
      ),
    ).rejects.toThrow(denied);
    const updated = await as(
      id.client,
      (tx) =>
        tx.$executeRaw`UPDATE "message_photos" SET status = 'ready', removed_at = NULL WHERE id::text = ${photo.removed}`,
    ).then(
      (n) => n,
      (e: unknown) => (denied.test(String(e)) ? 0 : -1),
    );
    expect(updated).toBe(0);
    const deleted = await as(
      id.client,
      (tx) => tx.$executeRaw`DELETE FROM "message_photos" WHERE id::text = ${photo.fromClient}`,
    ).then(
      (n) => n,
      (e: unknown) => (denied.test(String(e)) ? 0 : -1),
    );
    expect(deleted).toBe(0);
    const still = await prisma.messagePhoto.findUnique({
      where: { id: photo.fromClient },
      select: { id: true },
    });
    expect(still?.id).toBe(photo.fromClient);
  });

  it('authenticated cannot read or write erasure work', async () => {
    await prisma.messagePhotoErasure.create({
      data: { kind: 'object', target: `${id.client}/${tag}.jpg`, reason: 'sender_delete' },
    });
    const rows = await as(
      id.client,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id::text AS id FROM "message_photo_erasures" WHERE target LIKE ${`%${tag}%`}`,
    );
    expect(rows).toEqual([]);
    await expect(
      as(
        id.client,
        (tx) =>
          tx.$executeRaw`INSERT INTO "message_photo_erasures" (id, kind, target, reason) VALUES (${randomUUID()}::uuid, 'object', ${`x-${tag}`}, 'sender_delete')`,
      ),
    ).rejects.toThrow(/42501|row-level security|permission denied/);
  });
});
