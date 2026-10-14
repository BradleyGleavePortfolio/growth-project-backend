/**
 * C4-NOTICE: a coach's notice to move or cancel (CoachProfile.booking_cancel_notice_hours,
 * migration 20270502001100_coach_cancel_notice) on the replayed migration chain. No policy
 * changes with it: CoachProfile keeps FORCE RLS, coach_profile_self_select and
 * coach_profile_owner_all. Coaches A (12 hours) and B (48 hours), client a of A and client b
 * of B. Every user's id differs from its supabase id. Principals run as the API role
 * `authenticated` (no RLS bypass):
 *   backend(k)  app.current_user_id/_role and the JWT sub set (the backend model)
 *   dataApi(k)  the JWT sub only, no backend id (the Supabase Data API model)
 * Every 0 or 42501 follows a control: the coach reads their own row (1, with their value).
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-cancel-notice-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

type Key = 'A' | 'B' | 'a' | 'b';
type Who = { key: Key; guc: boolean; id?: string };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, 'coach' | 'student'> = { A: 'coach', B: 'coach', a: 'student', b: 'student' };
const COACH_OF: Record<Key, Key | null> = { A: null, B: null, a: 'A', b: 'B' };
const NOTICE: Record<'A' | 'B', number> = { A: 12, B: 48 };
const DENIED = '42501';

(DB_URL ? describe : describe.skip)("CoachProfile: a coach's notice to move or cancel", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['A', 'B', 'a', 'b']; // coaches first: clients reference them
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;

  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who.key], role: 'authenticated' }),
      );
      if (who.guc) {
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, true)`,
          who.id ?? id[who.key],
        );
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          ROLE[who.key],
        );
      }
      return query(tx);
    });
  /** The notice values `who` reads on `coach`'s profile row. */
  const reads = (who: Who, coach: 'A' | 'B') =>
    as(who, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT "booking_cancel_notice_hours" AS "n" FROM "CoachProfile" WHERE "user_id" = $1`,
        id[coach],
      ),
    ).then((rows) => rows.map((r) => r.n));
  /** Rows written, or the SQLSTATE of a refusal. */
  const write = async (who: Who, sql: string, coach: 'A' | 'B'): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, id[coach]));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const SET_ZERO = `UPDATE "CoachProfile" SET "booking_cancel_notice_hours" = 0 WHERE "user_id" = $1`;
  const DELETE = `DELETE FROM "CoachProfile" WHERE "user_id" = $1`;
  /** The control: `coach` reads their own row, once, with their own value. */
  const control = async (coach: 'A' | 'B') =>
    expect(await reads(backend(coach), coach)).toEqual([NOTICE[coach]]);

  beforeAll(async () => {
    for (const k of keys) {
      const coach = COACH_OF[k];
      await prisma.user.create({
        data: {
          id: id[k],
          supabase_id: sub[k],
          email: `cn-${id[k]}`,
          name: 'RLS person',
          role: ROLE[k],
          coach_id: coach ? id[coach] : null,
        },
      });
    }
    for (const coach of ['A', 'B'] as const) {
      await prisma.coachProfile.create({
        data: {
          user_id: id[coach],
          invite_code: `cn-${id[coach]}`,
          booking_cancel_notice_hours: NOTICE[coach],
        },
      });
    }
  });
  afterAll(() => prisma.$disconnect());

  it('each coach reads their own notice; the other coach reads nothing', async () => {
    await control('A');
    expect(await reads(backend('B'), 'A')).toEqual([]);
    await control('B');
    expect(await reads(backend('A'), 'B')).toEqual([]);
  });

  it("neither client reads either coach's raw profile, their own coach's included", async () => {
    for (const coach of ['A', 'B'] as const) {
      for (const client of ['a', 'b'] as const) {
        await control(coach);
        expect(await reads(backend(client), coach)).toEqual([]);
      }
    }
  });

  it('the other coach and both clients cannot change or delete the notice', async () => {
    for (const [coach, other] of [
      ['A', 'B'],
      ['B', 'A'],
    ] as const) {
      for (const intruder of [other, 'a', 'b'] as const) {
        await control(coach);
        expect([0, DENIED]).toContain(await write(backend(intruder), SET_ZERO, coach));
        await control(coach);
        expect([0, DENIED]).toContain(await write(backend(intruder), DELETE, coach));
      }
    }
    // The superuser connection still holds both rows, unchanged.
    const rows = await prisma.coachProfile.findMany({
      where: { user_id: { in: [id.A, id.B] } },
      select: { user_id: true, booking_cancel_notice_hours: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.user_id, r.booking_cancel_notice_hours]))).toEqual({
      [id.A]: NOTICE.A,
      [id.B]: NOTICE.B,
    });
  });

  it('the Data API model (no backend id) reads and changes nothing, even the coach row itself', async () => {
    for (const [coach, k] of [
      ['A', 'A'],
      ['A', 'a'],
      ['B', 'B'],
      ['B', 'b'],
    ] as const) {
      await control(coach);
      expect(await reads(dataApi(k), coach)).toEqual([]);
      await control(coach);
      expect([0, DENIED]).toContain(await write(dataApi(k), SET_ZERO, coach));
    }
    // A backend id holding the supabase id instead of the user id matches no row either.
    await control('A');
    expect(await reads({ key: 'A', guc: true, id: sub.A }, 'A')).toEqual([]);
  });
});
