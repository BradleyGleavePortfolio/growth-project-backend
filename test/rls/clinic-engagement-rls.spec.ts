/**
 * #609 (C05 items 6-7) — live RLS for the clinic engagement tables.
 *
 * Runs in the rls-live-tests CI job against a real Postgres 15 with
 * prisma/migrations/20270213000000_clinic_engagement/migration.sql applied
 * VERBATIM (see .github/workflows/ci.yml and
 * scripts/ci/clinic-engagement-live-*.sql). Every RLS assertion executes as
 * the non-bypass `authenticated` (or `anon`) role with the app.* GUCs the
 * RlsContextInterceptor sets in production; fixtures are written by the
 * privileged connection, exactly as the schedulers (service_role) write them.
 *
 * It proves, for CoachWelcomeMessageSetting, CoachWelcomeMessageJob and
 * WorkoutReminderDelivery:
 *   - RLS is ENABLED and FORCED;
 *   - the policy set is exactly: service_role ALL, one public SELECT, and a
 *     RESTRICTIVE anon deny-all (no INSERT / UPDATE / DELETE policy for any
 *     non-service role);
 *   - who reads which rows: a coach reads only their own welcome setting (the
 *     coach's welcome text), the welcome jobs (rendered_body carries the
 *     client's first name) are platform-owner only, a client reads only their
 *     own reminder ledger; the platform owner reads all; a request with no
 *     identity reads nothing; anon is denied;
 *   - no non-service principal (owner, coach, client, anon) can INSERT,
 *     UPDATE or DELETE, including its own rows;
 *   - service_role (schedulers, owner endpoint, operator script) reads and
 *     writes every row;
 *   - the two NotificationPreferences columns are NOT NULL DEFAULT true, and
 *     the idempotency keys (one job per client, one reminder per client per
 *     local day) are enforced by the database.
 *
 * Gate: TEST_DATABASE_URL (set by the rls-live-tests job). No URL -> skip,
 * except under CI=true where a missing URL is a hard failure (no
 * green-by-skip). URL set but unreachable -> hard failure.
 */

import { PrismaClient, Prisma } from '@prisma/client';

// Not DATABASE_URL: test/jest.setup.ts always sets a placeholder DATABASE_URL.
const DB_URL = process.env.TEST_DATABASE_URL || '';
if (!DB_URL && process.env.CI === 'true') {
  throw new Error(
    '[#609] clinic-engagement-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.',
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const P = 'engrls-';
const OWNER = `${P}platform-owner`;
const COACH = `${P}coach`;
const COACH2 = `${P}coach-2`;
const CLIENT = `${P}client`; // coach = COACH
const CLIENT2 = `${P}client-2`; // coach = COACH2

const USERS: Array<[string, string, string | null]> = [
  [OWNER, 'owner', null],
  [COACH, 'coach', null],
  [COACH2, 'coach', null],
  [CLIENT, 'student', COACH],
  [CLIENT2, 'student', COACH2],
];
const ROLE_OF: Record<string, string> = Object.fromEntries(USERS.map(([id, r]) => [id, r]));

type Table = 'CoachWelcomeMessageSetting' | 'CoachWelcomeMessageJob' | 'WorkoutReminderDelivery';
const TABLES: Table[] = [
  'CoachWelcomeMessageSetting',
  'CoachWelcomeMessageJob',
  'WorkoutReminderDelivery',
];

/** One fixture row id per table and person. */
const ROW: Record<'setting' | 'job' | 'delivery', Record<string, string>> = {
  setting: { [COACH]: `${P}setting-coach`, [COACH2]: `${P}setting-coach-2` },
  job: { [CLIENT]: `${P}job-client`, [CLIENT2]: `${P}job-client-2` },
  delivery: { [CLIENT]: `${P}delivery-client`, [CLIENT2]: `${P}delivery-client-2` },
};

/** A forged row per table, as a client-side writer would try to insert it. */
function forgedInsert(table: Table, id: string, person: string): [string, unknown[]] {
  switch (table) {
    case 'CoachWelcomeMessageSetting':
      return [
        `INSERT INTO "CoachWelcomeMessageSetting" (id, coach_id, enabled, template, updated_at)
         VALUES ($1, $2, true, 'forged {first_name}', now())`,
        [id, person],
      ];
    case 'CoachWelcomeMessageJob':
      return [
        `INSERT INTO "CoachWelcomeMessageJob" (id, client_id, coach_id, completed_at, fire_at, updated_at)
         VALUES ($1, $2, $3, now(), now(), now())`,
        [id, person, COACH],
      ];
    case 'WorkoutReminderDelivery':
      return [
        `INSERT INTO "WorkoutReminderDelivery" (id, client_id, local_date, timezone, slot)
         VALUES ($1, $2, DATE '2026-12-01', 'UTC', 'morning')`,
        [id, person],
      ];
  }
}

const UPDATE_SQL: Record<Table, string> = {
  CoachWelcomeMessageSetting: `UPDATE "CoachWelcomeMessageSetting" SET enabled = true, template = 'tampered'`,
  CoachWelcomeMessageJob: `UPDATE "CoachWelcomeMessageJob" SET status = 'sent', rendered_body = 'tampered'`,
  WorkoutReminderDelivery: `UPDATE "WorkoutReminderDelivery" SET status = 'sent'`,
};

(DB_URL ? describe : describe.skip)('clinic engagement RLS (live DB, #609)', () => {
  let prisma: PrismaClient;

  /** Run `fn` as a DB role with the production RLS GUCs for `reader`. */
  async function as<T>(
    reader: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    dbRole: 'authenticated' | 'anon' | 'service_role' = 'authenticated',
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${dbRole}`);
      if (reader) {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, reader);
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, true)`,
          ROLE_OF[reader] ?? 'student',
        );
      }
      return fn(tx);
    });
  }

  async function visibleIds(
    reader: string | null,
    table: Table,
    dbRole: 'authenticated' | 'anon' | 'service_role' = 'authenticated',
  ): Promise<string[]> {
    return as(
      reader,
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "${table}" WHERE id LIKE '${P}%' ORDER BY id`,
        );
        return rows.map((r) => r.id);
      },
      dbRole,
    );
  }

  async function exec(sql: string, ...args: unknown[]) {
    await prisma.$executeRawUnsafe(sql, ...args);
  }

  /**
   * B-609-1: the SQLSTATE a statement failed with, read from the error's
   * machine codes, never its message text. Prisma's raw path wraps a
   * PostgreSQL error as P2010 with the SQLSTATE under `meta.code`; a typed
   * unique violation surfaces as P2002 (= SQLSTATE 23505).
   */
  async function sqlStateOf(run: Promise<unknown>): Promise<string> {
    try {
      await run;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') return '23505';
        const meta: Record<string, unknown> = err.meta ?? {};
        const code = meta.code;
        if (err.code === 'P2010' && typeof code === 'string') return code;
        return `prisma ${err.code} without a SQLSTATE`;
      }
      return `not a Prisma known request error: ${err instanceof Error ? err.name : typeof err}`;
    }
    return 'no error: the statement succeeded';
  }

  async function snapshot(): Promise<string> {
    const parts: unknown[] = [];
    for (const t of TABLES) {
      parts.push(
        await prisma.$queryRawUnsafe(
          `SELECT row_to_json(x)::text AS j FROM "${t}" x WHERE id LIKE '${P}%' ORDER BY id`,
        ),
      );
    }
    return JSON.stringify(parts);
  }

  async function cleanup() {
    const ids = USERS.map(([id]) => id);
    await exec(`DELETE FROM "WorkoutReminderDelivery" WHERE client_id = ANY($1::text[])`, ids);
    await exec(
      `DELETE FROM "CoachWelcomeMessageJob" WHERE client_id = ANY($1::text[]) OR coach_id = ANY($1::text[])`,
      ids,
    );
    await exec(`DELETE FROM "CoachWelcomeMessageSetting" WHERE coach_id = ANY($1::text[])`, ids);
    await exec(`DELETE FROM "NotificationPreferences" WHERE user_id = ANY($1::text[])`, ids);
    await exec(`UPDATE "User" SET coach_id = NULL WHERE id = ANY($1::text[])`, ids);
    await exec(`DELETE FROM "User" WHERE id = ANY($1::text[])`, ids);
  }

  async function seed() {
    await cleanup();
    for (const [id, role] of USERS) {
      await exec(`INSERT INTO "User" (id, role) VALUES ($1, $2)`, id, role);
    }
    for (const [id, , coach] of USERS) {
      if (coach) await exec(`UPDATE "User" SET coach_id = $1 WHERE id = $2`, coach, id);
    }
    for (const coach of [COACH, COACH2]) {
      await exec(
        `INSERT INTO "CoachWelcomeMessageSetting" (id, coach_id, enabled, template, enabled_at, updated_at)
         VALUES ($1, $2, true, 'synthetic {first_name} {coach_first_name}', now(), now())`,
        ROW.setting[coach],
        coach,
      );
    }
    for (const [client, coach] of [
      [CLIENT, COACH],
      [CLIENT2, COACH2],
    ]) {
      await exec(
        `INSERT INTO "CoachWelcomeMessageJob" (id, client_id, coach_id, completed_at, fire_at, status, rendered_body, updated_at)
         VALUES ($1, $2, $3, now(), now() + interval '13 minutes', 'pending', 'Hi Synthetic', now())`,
        ROW.job[client],
        client,
        coach,
      );
      await exec(
        `INSERT INTO "WorkoutReminderDelivery" (id, client_id, local_date, timezone, slot, first_day, status)
         VALUES ($1, $2, DATE '2026-10-05', 'America/Los_Angeles', 'morning', true, 'sent')`,
        ROW.delivery[client],
        client,
      );
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
    } catch (err) {
      throw new Error(
        `[#609] TEST_DATABASE_URL is set but unreachable. Refusing to skip. ${errorMessage(err)}`,
      );
    }
  });

  beforeEach(seed);

  afterAll(async () => {
    if (prisma) {
      try {
        await cleanup();
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  it('RLS is enabled and forced on all three tables', async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ relname: string; on: boolean; forced: boolean }>
    >(
      `SELECT relname::text AS relname, relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY relname`,
      TABLES,
    );
    expect(rows.map((r) => r.relname)).toEqual([...TABLES].sort());
    rows.forEach((r) => expect(r).toMatchObject({ on: true, forced: true }));
  });

  it('the policy set is exactly service_role ALL + one public SELECT + a RESTRICTIVE anon deny (no write policy for anyone else)', async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        tablename: string;
        policyname: string;
        permissive: string;
        roles: string[];
        cmd: string;
      }>
    >(
      `SELECT tablename::text AS tablename, policyname::text AS policyname, permissive::text AS permissive,
              roles::text[] AS roles, cmd::text AS cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
        ORDER BY tablename, policyname`,
      TABLES,
    );
    const key = (r: string[]) => r.join('|');
    const got = rows
      .map((r) => [r.tablename, r.policyname, r.permissive, r.roles.join(','), r.cmd])
      .sort((a, b) => key(a).localeCompare(key(b)));
    const expected: Array<[string, string, string, string, string]> = [];
    for (const t of [...TABLES].sort()) {
      const k = t.toLowerCase();
      expected.push(
        [t, `p_${k}_anon_deny`, 'RESTRICTIVE', 'anon', 'ALL'],
        [t, `p_${k}_select`, 'PERMISSIVE', 'public', 'SELECT'],
        [t, `p_${k}_service_role_all`, 'PERMISSIVE', 'service_role', 'ALL'],
      );
    }
    expect(got).toEqual(expected.sort((a, b) => key(a).localeCompare(key(b))));
  });

  it("CoachWelcomeMessageSetting: a coach reads only their own setting (the coach's welcome text); the owner reads all; clients read none", async () => {
    const t: Table = 'CoachWelcomeMessageSetting';
    expect(await visibleIds(COACH, t)).toEqual([ROW.setting[COACH]]);
    expect(await visibleIds(COACH2, t)).toEqual([ROW.setting[COACH2]]);
    expect(await visibleIds(CLIENT, t)).toEqual([]);
    expect(await visibleIds(CLIENT2, t)).toEqual([]);
    expect(await visibleIds(OWNER, t)).toEqual([ROW.setting[COACH], ROW.setting[COACH2]].sort());
  });

  it("CoachWelcomeMessageJob: platform owner only; the job's own coach and client read nothing", async () => {
    const t: Table = 'CoachWelcomeMessageJob';
    for (const reader of [COACH, COACH2, CLIENT, CLIENT2]) {
      expect([reader, await visibleIds(reader, t)]).toEqual([reader, []]);
    }
    expect(await visibleIds(OWNER, t)).toEqual([ROW.job[CLIENT], ROW.job[CLIENT2]].sort());
  });

  it("WorkoutReminderDelivery: a client reads only their own ledger; the client's coach and another client read none; the owner reads all", async () => {
    const t: Table = 'WorkoutReminderDelivery';
    expect(await visibleIds(CLIENT, t)).toEqual([ROW.delivery[CLIENT]]);
    expect(await visibleIds(CLIENT2, t)).toEqual([ROW.delivery[CLIENT2]]);
    expect(await visibleIds(COACH, t)).toEqual([]);
    expect(await visibleIds(COACH2, t)).toEqual([]);
    expect(await visibleIds(OWNER, t)).toEqual(
      [ROW.delivery[CLIENT], ROW.delivery[CLIENT2]].sort(),
    );
  });

  it('a request with no identity (no app.current_user_id) reads nothing', async () => {
    for (const t of TABLES) expect([t, await visibleIds(null, t)]).toEqual([t, []]);
  });

  it('a role claim without a matching id is not the owner (app.is_owner needs both)', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE authenticated`);
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_user_role', 'owner', true)`);
      return tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "CoachWelcomeMessageJob" WHERE id LIKE '${P}%'`,
      );
    });
    expect(Number(rows[0].n)).toBe(0);
  });

  it('anon is denied on every table (RESTRICTIVE policy), with or without GUCs', async () => {
    // Denied means zero visible rows OR a permission error (anon cannot even
    // EXECUTE the app.* helpers); either way nothing is readable.
    for (const t of TABLES) {
      for (const reader of [null, OWNER, CLIENT]) {
        let denied: boolean;
        try {
          denied = (await visibleIds(reader, t, 'anon')).length === 0;
        } catch (err) {
          expect(errorMessage(err)).toMatch(/permission denied/i);
          denied = true;
        }
        expect([t, reader, denied]).toEqual([t, reader, true]);
      }
    }
  });

  async function fixtureCount(): Promise<number> {
    let n = 0;
    for (const t of TABLES) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "${t}" WHERE id LIKE '${P}%'`,
      );
      n += Number(rows[0].n);
    }
    return n;
  }

  async function emptyFixtureTables() {
    // Empty tables, so no unique key can answer before the RLS check does.
    for (const t of TABLES) await exec(`DELETE FROM "${t}" WHERE id LIKE '${P}%'`);
  }

  it('INSERT: no non-service principal can create a row, its own or a forged one (owner, coach, client)', async () => {
    await emptyFixtureTables();
    for (const t of TABLES) {
      for (const reader of [OWNER, COACH, CLIENT]) {
        const others = t === 'CoachWelcomeMessageSetting' ? [reader, COACH2] : [reader, CLIENT2];
        for (const person of others) {
          const [sql, args] = forgedInsert(t, `${P}forged-${t}-${reader}-${person}`, person);
          await expect(as(reader, (tx) => tx.$executeRawUnsafe(sql, ...args))).rejects.toThrow(
            /row-level security/i,
          );
        }
      }
    }
    expect(await fixtureCount()).toBe(0);
  });

  it('INSERT: anon is rejected on every table', async () => {
    await emptyFixtureTables();
    for (const t of TABLES) {
      for (const reader of [null, CLIENT]) {
        const [sql, args] = forgedInsert(t, `${P}forged-anon-${t}-${reader ?? 'none'}`, CLIENT);
        await expect(
          as(reader, (tx) => tx.$executeRawUnsafe(sql, ...args), 'anon'),
        ).rejects.toThrow(/row-level security|permission denied/i);
      }
    }
    expect(await fixtureCount()).toBe(0);
  });

  it('UPDATE and DELETE: no non-service principal changes or removes any row, its own included', async () => {
    const before = await snapshot();
    for (const t of TABLES) {
      for (const reader of [OWNER, COACH, CLIENT, COACH2, CLIENT2]) {
        const updated = await as(reader, (tx) =>
          tx.$executeRawUnsafe(`${UPDATE_SQL[t]} WHERE id LIKE '${P}%'`),
        );
        const deleted = await as(reader, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE id LIKE '${P}%'`),
        );
        expect({ t, reader, updated, deleted }).toEqual({ t, reader, updated: 0, deleted: 0 });
      }
      for (const reader of [null, CLIENT]) {
        for (const sql of [
          `${UPDATE_SQL[t]} WHERE id LIKE '${P}%'`,
          `DELETE FROM "${t}" WHERE id LIKE '${P}%'`,
        ]) {
          let n: number | 'permission_denied';
          try {
            n = await as(reader, (tx) => tx.$executeRawUnsafe(sql), 'anon');
          } catch (err) {
            expect(errorMessage(err)).toMatch(/permission denied/i);
            n = 'permission_denied';
          }
          expect([t, reader, sql.split(' ')[0], [0, 'permission_denied'].includes(n)]).toEqual([
            t,
            reader,
            sql.split(' ')[0],
            true,
          ]);
        }
      }
    }
    expect(await snapshot()).toBe(before);
  });

  it('service_role (schedulers, owner endpoint, operator script) reads and writes every row', async () => {
    for (const t of TABLES) {
      expect((await visibleIds(null, t, 'service_role')).length).toBe(2);
    }
    const n = await as(
      null,
      (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "CoachWelcomeMessageJob" SET status = 'sent', rendered_body = NULL WHERE id = $1`,
          ROW.job[CLIENT],
        ),
      'service_role',
    );
    expect(n).toBe(1);
    const d = await as(
      null,
      (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM "WorkoutReminderDelivery" WHERE id = $1`,
          ROW.delivery[CLIENT],
        ),
      'service_role',
    );
    expect(d).toBe(1);
  });

  it('NotificationPreferences gains workout_reminder_push and workout_reminder_inapp, NOT NULL DEFAULT true', async () => {
    const cols = await prisma.$queryRawUnsafe<
      Array<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
        data_type: string;
      }>
    >(
      `SELECT column_name::text AS column_name, is_nullable::text AS is_nullable,
              column_default::text AS column_default, data_type::text AS data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'NotificationPreferences'
          AND column_name IN ('workout_reminder_push', 'workout_reminder_inapp')
        ORDER BY column_name`,
    );
    expect(cols).toEqual([
      {
        column_name: 'workout_reminder_inapp',
        is_nullable: 'NO',
        column_default: 'true',
        data_type: 'boolean',
      },
      {
        column_name: 'workout_reminder_push',
        is_nullable: 'NO',
        column_default: 'true',
        data_type: 'boolean',
      },
    ]);
    await exec(
      `INSERT INTO "NotificationPreferences" (id, user_id) VALUES ($1, $2)`,
      `${P}prefs`,
      CLIENT,
    );
    const row = await prisma.$queryRawUnsafe<Array<{ p: boolean; i: boolean }>>(
      `SELECT workout_reminder_push AS p, workout_reminder_inapp AS i FROM "NotificationPreferences" WHERE id = $1`,
      `${P}prefs`,
    );
    expect(row).toEqual([{ p: true, i: true }]);
  });

  it('idempotency keys are database-enforced: one welcome job per client, one setting per coach, one reminder per client per local day', async () => {
    // B-609-1: assert the SQLSTATE (23505 unique_violation), never message text.
    const duplicateJob = exec(
      `INSERT INTO "CoachWelcomeMessageJob" (id, client_id, coach_id, completed_at, fire_at, updated_at)
       VALUES ($1, $2, $3, now(), now(), now())`,
      `${P}job-dup`,
      CLIENT,
      COACH,
    );
    expect(await sqlStateOf(duplicateJob)).toBe('23505');
    const duplicateSetting = exec(
      `INSERT INTO "CoachWelcomeMessageSetting" (id, coach_id, updated_at) VALUES ($1, $2, now())`,
      `${P}setting-dup`,
      COACH,
    );
    expect(await sqlStateOf(duplicateSetting)).toBe('23505');
    const duplicateDelivery = exec(
      `INSERT INTO "WorkoutReminderDelivery" (id, client_id, local_date, timezone, slot)
       VALUES ($1, $2, DATE '2026-10-05', 'UTC', 'evening')`,
      `${P}delivery-dup`,
      CLIENT,
    );
    expect(await sqlStateOf(duplicateDelivery)).toBe('23505');
  });
});
