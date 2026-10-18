/**
 * Row security after a client moves (owner 4, GAPS1, migration
 * 20270412000000_former_coach_row_rules). The old coach, and a teammate whose
 * delegation the move left open, read nothing about the moved client: no
 * message, review marker, pin/mute row, accepted invite or signup row, and they
 * can't write into the old thread. The client still reads every message of
 * their own (nothing is deleted) but writes only into the current thread. The
 * new coach reads only the new thread. Nobody writes into a thread they are not
 * on, or as someone else, and only its author changes or deletes a line. Rows
 * about the client who stayed are unchanged.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('former-coach-rows-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('Former coach rows after a client moves', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [oldCoach, teammate, newCoach, stranger, client, stayer] = [1, 2, 3, 4, 5, 6].map(() =>
    randomUUID(),
  );
  const role: Record<string, string> = {
    [oldCoach]: 'coach',
    [teammate]: 'coach',
    [newCoach]: 'coach',
    [stranger]: 'coach',
    [client]: 'student',
    [stayer]: 'student',
  };
  // The client has moved from oldCoach to newCoach; stayer is still with
  // oldCoach. The teammate is on oldCoach's team.
  const coachOf: Record<string, string> = {
    [client]: newCoach,
    [stayer]: oldCoach,
    [teammate]: oldCoach,
  };
  const id = () => randomUUID();
  const msg = { old: id(), reply: id(), team: id(), fresh: id(), stay: id(), teamStay: id() };
  const review = { old: id(), fresh: id(), stay: id() };
  const pin = { oldCoach: id(), client: id(), stay: id() };
  const invite = { emailedMoved: id(), linkMoved: id(), emailedStays: id(), pending: id() };
  const signup = { moved: id(), stays: id() };

  const insertMessage = (tx: Prisma.TransactionClient, row: [string, string, string, string]) =>
    tx.$executeRaw`INSERT INTO "CoachMessage" ("id", "coach_id", "client_id", "sender_id", "body")
      VALUES (${row[0]}, ${row[1]}, ${row[2]}, ${row[3]}, 'RLS row')`;

  beforeAll(async () => {
    for (const u of Object.keys(role)) {
      await prisma.$executeRaw`INSERT INTO "User"
          ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${u}, ${u}, ${`fc-rls-${u}`}, 'RLS user', ${role[u]}::"Role", ${coachOf[u] ?? null})`;
    }
    // A delegation for each client; the move did not close the moved client's.
    for (const c of [client, stayer]) {
      await prisma.$executeRaw`INSERT INTO "SubCoachAssignment"
          ("id", "head_coach_id", "sub_coach_id", "client_id")
        VALUES (${id()}, ${oldCoach}, ${teammate}, ${c})`;
    }
    await insertMessage(prisma, [msg.old, oldCoach, client, oldCoach]); // before the move
    await insertMessage(prisma, [msg.reply, oldCoach, client, client]); // before the move
    await insertMessage(prisma, [msg.team, oldCoach, client, teammate]); // before the move
    await insertMessage(prisma, [msg.fresh, newCoach, client, newCoach]); // after the move
    await insertMessage(prisma, [msg.stay, oldCoach, stayer, stayer]);
    await insertMessage(prisma, [msg.teamStay, oldCoach, stayer, teammate]);
    for (const [rid, coach, c] of [
      [review.old, oldCoach, client],
      [review.fresh, newCoach, client],
      [review.stay, oldCoach, stayer],
    ]) {
      await prisma.$executeRaw`INSERT INTO "ConversationReview" ("id", "coach_id", "client_id", "updated_at")
        VALUES (${rid}, ${coach}, ${c}, now())`;
    }
    for (const [pid, user, c] of [
      [pin.oldCoach, oldCoach, client],
      [pin.client, client, client],
      [pin.stay, oldCoach, stayer],
    ]) {
      await prisma.$executeRaw`INSERT INTO "CoachThreadState"
          ("id", "user_id", "coach_id", "client_id", "pinned_at", "updated_at")
        VALUES (${pid}, ${user}, ${oldCoach}, ${c}, now(), now())`;
    }
    for (const [iid, by, email] of [
      [invite.emailedMoved, client, 'invitee-moved'],
      [invite.linkMoved, client, null],
      [invite.emailedStays, stayer, 'invitee-stays'],
      [invite.pending, null, 'invitee-new'],
    ]) {
      await prisma.$executeRaw`INSERT INTO "InviteCode"
          ("id", "code", "coach_id", "intended_email", "accepted_by_user_id", "accepted_at")
        VALUES (${iid}, ${`fc-rls-${iid}`}, ${oldCoach}, ${email}, ${by},
          ${by ? new Date() : null})`;
    }
    for (const [sid, c] of [
      [signup.moved, client],
      [signup.stays, stayer],
    ]) {
      await prisma.$executeRaw`INSERT INTO "InviteRedemption"
          ("id", "coach_id", "client_user_id", "code", "source")
        VALUES (${sid}, ${oldCoach}, ${c}, ${`fc-rls-${sid}`}, 'invite_code')`;
    }
  });
  afterAll(() => prisma.$disconnect());

  // Runs `fn` as the signed-in API role with `reader`'s RLS context.
  const as = <T>(reader: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (reader) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          role[reader],
        );
      }
      return fn(tx);
    });
  // The ids of `rows` in `table` that `reader` can read.
  const seen = (table: string, rows: Record<string, string>, reader: string | null) =>
    as(reader, async (tx) =>
      (
        await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "${table}" WHERE "id" = ANY($1::text[])`,
          Object.values(rows),
        )
      )
        .map((r) => r.id)
        .sort(),
    );
  const sorted = (...ids: string[]) => ids.sort();
  const denied = /42501|row-level security/;

  it("the old coach reads only the client who stayed, not the moved client's old thread", async () => {
    expect(await seen('CoachMessage', msg, oldCoach)).toEqual(sorted(msg.stay, msg.teamStay));
  });

  it('a teammate reads only their own lines in a current thread, none of the moved client', async () => {
    expect(await seen('CoachMessage', msg, teammate)).toEqual([msg.teamStay]);
  });

  it('the client reads every message of their own, the old thread included', async () => {
    expect(await seen('CoachMessage', msg, client)).toEqual(
      sorted(msg.old, msg.reply, msg.team, msg.fresh),
    );
  });

  it('the new coach reads only the new thread; another coach and no context read nothing', async () => {
    expect(await seen('CoachMessage', msg, newCoach)).toEqual([msg.fresh]);
    expect(await seen('CoachMessage', msg, stranger)).toEqual([]);
    expect(await seen('CoachMessage', msg, null)).toEqual([]);
  });

  it('nobody writes into a thread they are not on, or as someone else', async () => {
    const tries: Array<[string, [string, string, string]]> = [
      [oldCoach, [oldCoach, client, oldCoach]], // the old coach, old thread
      [teammate, [newCoach, client, teammate]], // open delegation, other team
      [stranger, [oldCoach, stayer, stranger]], // another coach, as sender
      [client, [oldCoach, stayer, client]], // another client, as sender
      [client, [oldCoach, client, client]], // the moved client, old thread
      [client, [newCoach, client, newCoach]], // the client, as their coach
      [newCoach, [newCoach, client, client]], // the coach, as their client
      [teammate, [oldCoach, stayer, oldCoach]], // a teammate, as the head coach
    ];
    for (const [actor, [coach, c, sender]] of tries) {
      await expect(as(actor, (tx) => insertMessage(tx, [id(), coach, c, sender]))).rejects.toThrow(
        denied,
      );
    }
  });

  // [rows changed, rows deleted] when `actor` edits, then deletes, `ids`.
  const changeAndDelete = async (actor: string, ids: string[]) => [
    await as(actor, (tx) =>
      tx.$executeRaw`UPDATE "CoachMessage" SET "body" = 'changed' WHERE "id" IN (${Prisma.join(ids)})`,
    ),
    await as(actor, (tx) =>
      tx.$executeRaw`DELETE FROM "CoachMessage" WHERE "id" IN (${Prisma.join(ids)})`,
    ),
  ];

  it('only its author changes or deletes a line, and the old thread is read-only', async () => {
    const tries: Array<[string, string[]]> = [
      [client, [msg.old, msg.reply]], // the moved client, old thread (own line included)
      [client, [msg.fresh]], // the client, their coach's line
      [oldCoach, [msg.stay]], // the coach, their client's line
      [teammate, [msg.stay]], // a teammate, the client's line
      [stayer, [msg.teamStay]], // the client, a teammate's line
    ];
    for (const [actor, ids] of tries) expect(await changeAndDelete(actor, ids)).toEqual([0, 0]);
    const kept = await prisma.$queryRaw<{ body: string }[]>`
      SELECT "body" FROM "CoachMessage" WHERE "id" IN (${Prisma.join(Object.values(msg))})`;
    expect(kept.map((r) => r.body)).toEqual(Object.values(msg).map(() => 'RLS row'));
  });

  it('the people of a current thread write, change and delete their own lines', async () => {
    const own: Array<[string, string, string]> = [
      [client, newCoach, client],
      [newCoach, newCoach, client],
      [teammate, oldCoach, stayer],
      [oldCoach, oldCoach, stayer],
      [stayer, oldCoach, stayer],
    ];
    for (const [actor, coach, c] of own) {
      const line = id();
      await as(actor, (tx) => insertMessage(tx, [line, coach, c, actor]));
      expect(await changeAndDelete(actor, [line])).toEqual([1, 1]);
    }
  });

  it("review markers and pin/mute rows: the old coach keeps only the stayer's", async () => {
    expect(await seen('ConversationReview', review, oldCoach)).toEqual([review.stay]);
    expect(await seen('ConversationReview', review, newCoach)).toEqual([review.fresh]);
    expect(await seen('ConversationReview', review, client)).toEqual(
      sorted(review.old, review.fresh),
    );
    expect(await seen('ConversationReview', review, stranger)).toEqual([]);
    expect(await seen('CoachThreadState', pin, oldCoach)).toEqual([pin.stay]);
    expect(await seen('CoachThreadState', pin, client)).toEqual([pin.client]);
    expect(await seen('CoachThreadState', pin, newCoach)).toEqual([]);
    expect(await seen('CoachThreadState', pin, stranger)).toEqual([]);
  });

  it('invites and signups: the old coach keeps pending ones and the stayer, nobody else reads them', async () => {
    expect(await seen('InviteCode', invite, oldCoach)).toEqual(
      sorted(invite.emailedStays, invite.pending),
    );
    expect(await seen('InviteRedemption', signup, oldCoach)).toEqual([signup.stays]);
    for (const reader of [newCoach, client, stranger]) {
      expect(await seen('InviteCode', invite, reader)).toEqual([]);
      expect(await seen('InviteRedemption', signup, reader)).toEqual([]);
    }
  });
});
