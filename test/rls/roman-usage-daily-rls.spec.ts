// ROMANCOUNT (agent 145): roman_usage_daily on the replayed chain (rls-live-tests,
// superuser copy of rls_replay): own row only, backend-only writes, 100/3/5 on
// real Postgres. Gate: TEST_DATABASE_URL; no URL -> skip, except under CI=true.
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import {
  consumeRomanUsage, releaseRomanUsage, romanUsageDay, type RomanUsageEvent,
} from '../../src/roman/roman-usage';
import { RomanUsageController } from '../../src/roman/roman-usage.controller';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { PrismaService } from '../../src/prisma.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('roman-usage-daily-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)('roman_usage_daily: own row only, limits on real Postgres', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const [coach, client, other] = [randomUUID(), randomUUID(), randomUUID()];
  const [a, b] = [randomUUID(), randomUUID()]; // fresh clients for GET /me/roman/usage
  const role: Record<string, string> = {
    [coach]: 'coach', [client]: 'student', [other]: 'student', [a]: 'student', [b]: 'student',
  };
  const AT = new Date('2026-10-14T12:00:00Z');
  const DAY = new Date('2026-10-14T00:00:00Z');

  beforeAll(async () => {
    for (const id of [coach, client, other, a, b]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id}, ${id}, ${`ruc-rls-${id}`}, 'RLS user', ${role[id]}::"Role", ${id === coach ? null : coach})`;
    }
    for (const id of [client, other]) {
      await prisma.$executeRaw`INSERT INTO "roman_usage_daily" ("client_id", "day", "messages")
        VALUES (${id}, '2026-10-14'::date, 7)`;
    }
  });
  afterAll(() => prisma.$disconnect());

  /** Runs `sql` as the signed-in API role with `reader`'s RLS context. */
  const asUser = (reader: string | null, sql: Prisma.Sql) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      if (reader) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[reader]);
      }
      return tx.$queryRaw<{ client_id: string }[]>(sql);
    });
  const rowsSeenBy = async (reader: string | null) =>
    (await asUser(reader, Prisma.sql`SELECT "client_id" FROM "roman_usage_daily"
      WHERE "client_id" IN (${client}, ${other})`)).map((r) => r.client_id);
  /** True when the event is allowed (and counted unless `peek`), false on the 429. */
  const passes = (who: string, event: RomanUsageEvent, now = AT, peek = false) =>
    consumeRomanUsage(fakeOf<PrismaService>(prisma), { id: who, role: 'student' }, event, now, peek).then(
      () => true,
      (e: unknown) => {
        if (e instanceof HttpException && e.getStatus() === 429) return false;
        throw e;
      },
    );
  const select = { messages: true, files: true, changes: true };
  const counts = (client_id: string, day = DAY) =>
    prisma.romanUsageDaily.findUnique({ where: { client_id_day: { client_id, day } }, select });

  it('a client reads only their own row; a coach and no context read none (control: backend sees both)', async () => {
    expect(await prisma.romanUsageDaily.count({ where: { client_id: { in: [client, other] } } })).toBe(2);
    expect(await rowsSeenBy(client)).toEqual([client]);
    expect(await rowsSeenBy(other)).toEqual([other]);
    expect(await rowsSeenBy(coach)).toEqual([]);
    expect(await rowsSeenBy(null)).toEqual([]);
  });

  it('the signed-in API role cannot write a count, not even its own; RLS is enabled and forced', async () => {
    await expect(asUser(client, Prisma.sql`UPDATE "roman_usage_daily" SET "messages" = 0
      WHERE "client_id" = ${client} RETURNING "client_id"`)).rejects.toThrow(/permission denied/);
    await expect(asUser(client, Prisma.sql`INSERT INTO "roman_usage_daily" ("client_id", "day")
      VALUES (${client}, '2030-01-01'::date) RETURNING "client_id"`)).rejects.toThrow(/permission denied/);
    expect((await counts(client))?.messages).toBe(7);
    const [t] = await prisma.$queryRaw<{ on: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS "on", relforcerowsecurity AS "forced"
      FROM pg_class WHERE oid = 'public.roman_usage_daily'::regclass`;
    expect(t).toEqual({ on: true, forced: true });
  });

  it('at 99/100, 2/3 and 4/5 one more passes and the next is refused; a meal photo is 1 file', async () => {
    await prisma.romanUsageDaily.update({
      where: { client_id_day: { client_id: client, day: DAY } },
      data: { messages: 99, files: 2, changes: 4 },
    });
    expect(await passes(client, 'chat_message', AT, true)).toBe(true); // an eating-disorder-risk turn: never counted
    expect((await counts(client))?.messages).toBe(99);
    for (const event of ['chat_message', 'meal_photo', 'roman_change'] as const) {
      expect(await passes(client, event)).toBe(true);
      expect(await passes(client, event)).toBe(false);
    }
    expect(await passes(client, 'file_upload')).toBe(false);
    expect(await passes(client, 'chat_message', AT, true)).toBe(false); // ...but refused at the limit
    // Excluded events (a, b, d, e, safety replies) never count, even at every limit.
    for (const e of ['coach_approved_change', 'private_note', 'voice_logged_set', 'coach_import', 'safety_reply'] as const) {
      expect(await passes(client, e)).toBe(true);
    }
    expect(await counts(client)).toEqual({ messages: 100, files: 3, changes: 5 });
  });

  it('two requests at the limit at the same moment: exactly one passes', async () => {
    await prisma.romanUsageDaily.update({
      where: { client_id_day: { client_id: other, day: DAY } },
      data: { messages: 99 },
    });
    const results = await Promise.all([passes(other, 'chat_message'), passes(other, 'chat_message')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await counts(other))?.messages).toBe(100);
  });

  it('the next local day starts from zero; the used-up day stays used up', async () => {
    expect(await passes(client, 'chat_message', new Date(AT.getTime() + 24 * 3600 * 1000))).toBe(true);
    expect(await counts(client, new Date('2026-10-15T00:00:00Z'))).toEqual({ messages: 1, files: 0, changes: 0 });
    expect(await passes(client, 'chat_message')).toBe(false);
  });

  it('a New York client: 03:30Z on 10-15 is still their 10-14 (at 100); 04:30Z is a new day', async () => {
    await prisma.notificationPreferences.create({
      data: { user_id: other, timezone: 'America/New_York', timezone_updated_at: AT },
    });
    expect(await passes(other, 'chat_message', new Date('2026-10-15T03:30:00Z'))).toBe(false);
    expect(await passes(other, 'chat_message', new Date('2026-10-15T04:30:00Z'))).toBe(true);
  });

  it('GET /me/roman/usage: each client reads only their own counts, in their zone, as counted', async () => {
    await prisma.notificationPreferences.create({
      data: { user_id: b, timezone: 'America/New_York', timezone_updated_at: AT },
    });
    const db = fakeOf<PrismaService>(prisma);
    const ctrl = new RomanUsageController(db);
    const usage = (id: string) =>
      ctrl.usage(fakeOf<AuthedRequest>({ user: { id, role: 'student', coach_id: coach } }));
    const now = new Date(); // the route reads the real clock
    expect(await passes(a, 'chat_message', now, true)).toBe(true); // an eating-disorder-risk check: a zero row
    expect(await prisma.romanUsageDaily.count({ where: { client_id: a } })).toBe(1);
    expect((await usage(a)).used).toEqual({ messages: 0, files: 0, changes: 0 });
    const debit = await consumeRomanUsage(db, { id: a, role: 'student' }, 'chat_message', now);
    if (!debit) throw new Error('expected a counted message');
    // Refused at the final spend check: the count is given back.
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => releaseRomanUsage(tx, debit));
    for (const e of ['chat_message', 'chat_message', 'meal_photo'] as const) {
      expect(await passes(a, e, now)).toBe(true);
    }
    for (let i = 0; i < 5; i++) expect(await passes(b, 'roman_change', now)).toBe(true);
    const own = (used: object, tz: string) => {
      const { day, resetsAt } = romanUsageDay(now, tz);
      const limits = { messages: 100, files: 3, changes: 5 };
      return { day, used, limits, resets_at: resetsAt.toISOString() };
    };
    // Control: both rows hold counts; each client sees only their own (A's 0 changes, B's 0 messages).
    expect(await usage(a)).toEqual(own({ messages: 2, files: 1, changes: 0 }, 'UTC'));
    expect(await usage(b)).toEqual(own({ messages: 0, files: 0, changes: 5 }, 'America/New_York'));
  });
});
