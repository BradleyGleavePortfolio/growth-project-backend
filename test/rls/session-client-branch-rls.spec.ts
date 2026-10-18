/**
 * RLSLIVE2b (RLSINV P01): at the row layer a client books sessions only with
 * their own coach, asks rather than confirms (unless the coach's session type
 * confirms instantly), and never writes the coach's side of a session: the
 * private notes, call link, calendar ids, coach or status. The client keeps
 * the two status changes the server makes for them: cancel, and a move that
 * asks the coach again.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is coach K's client who moved from coach F; C is coach L's client. Every
 * id differs from its supabase id (RLSINV Y04). The suite runs down.sql (#972's
 * text, already on main), then migration.sql, which must give the state the
 * replayed chain gave. Every 0, 42501 or guard raise follows a control of 1.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('session-client-branch-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const THIS = '20270502000400_sessions_client_branch_and_private_columns';
const PR972 = '20270413000000_moved_client_session_rows';
// A migration file's statements (dollar-quoted bodies kept whole); BEGIN/COMMIT become one transaction.
const statements = (dir: string, file: string) => {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  for (const line of readFileSync(join(MIGRATIONS, dir, file), 'utf8').split('\n')) {
    if (!quoted && /^\s*--/.test(line)) continue;
    buf += `${line}\n`;
    if ((line.match(/\$\$/g) ?? []).length % 2) quoted = !quoted;
    if (!quoted && /;\s*$/.test(line)) {
      out.push(buf.trim().replace(/;$/, ''));
      buf = '';
    }
  }
  return out.filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
};

type Key = 'A' | 'C' | 'F' | 'K' | 'L';
type Who = { key: Key; guc: boolean } | 'service_role';
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = {
  A: 'student',
  C: 'student',
  F: 'coach',
  K: 'coach',
  L: 'coach',
};
const DENIED = '42501';
const RAISE = 'guard raise';
const GUARDED: [string, string][] = [
  ['coach_notes_md', `'Overwritten'`],
  ['video_url', `'https://example.com/other'`],
  ['video_meeting_id', `'m-2'`],
  ['calendar_event_id', `'e-2'`],
  ['provider_idempotency_key', `'k-2'`],
];

(DB_URL ? describe : describe.skip)(
  'sessions: the client branch and the coach-side columns',
  () => {
    const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const keys: Key[] = ['F', 'K', 'L', 'A', 'C']; // clients last: they reference their coach
    const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
    const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
    const run = randomUUID().slice(0, 8);
    const st = { kAsk: `ta-${run}`, kAuto: `tk-${run}`, lAuto: `tl-${run}` };
    // note: K-A confirmed, with the coach's side filled; move / cancel / confirm: K-A; old: F-A (F era).
    const row = {
      note: `sn-${run}`,
      move: `sm-${run}`,
      cancel: `sc-${run}`,
      confirm: `sk-${run}`,
      old: `so-${run}`,
    };
    let day = 10; // every session gets its own day: no coach is ever double-booked
    const slot = () => {
      const start = new Date(Date.UTC(2031, 0, 1, 15) + (day += 1) * 86_400_000);
      return [start, new Date(start.getTime() + 1_800_000)];
    };

    const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (who === 'service_role') {
          await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
          return query(tx);
        }
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRawUnsafe(
          `SELECT set_config('request.jwt.claims', $1, true)`,
          JSON.stringify({ sub: sub[who.key], role: 'authenticated' }),
        );
        if (who.guc) {
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.current_user_id', $1, true)`,
            id[who.key],
          );
          await tx.$executeRawUnsafe(
            `SELECT set_config('app.current_user_role', $1, true)`,
            ROLE[who.key],
          );
        }
        return query(tx);
      });
    const apply = (dir: string, file: string) =>
      prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          for (const s of statements(dir, file)) await tx.$executeRawUnsafe(s);
        },
        { timeout: 30_000 },
      );
    // Rows written, the SQLSTATE of a refusal, or RAISE when the guard refused.
    const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
      try {
        return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
      } catch (e) {
        const err = e as {
          code?: string;
          message?: string;
          meta?: { code?: string; message?: string };
        };
        if (
          /coaching_session_private_columns_guard/.test(
            `${err.meta?.message ?? ''} ${err.message ?? ''}`,
          )
        )
          return RAISE;
        return String(err.code === 'P2010' ? err.meta?.code : err.code);
      }
    };
    const reads = (who: Who, rowId: string) =>
      as(who, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS "n" FROM "CoachingSession" WHERE "id" = $1`,
          rowId,
        ),
      ).then((r) => r[0].n);
    // extra: one more [column, SQL value] to write, e.g. a coach-side column.
    const book = (
      who: Who | null,
      coach: Key,
      client: Key,
      status: string,
      typeId: string | null = st.kAsk,
      extra?: [string, string],
    ) => {
      const [start, end] = slot();
      const [col, val] = extra ? [`, "${extra[0]}"`, `, ${extra[1]}`] : ['', ''];
      const sql = `INSERT INTO "CoachingSession" ("id", "coach_id", "client_id", "session_type_id", "status", "start_at", "end_at", "title"${col})
      VALUES ($1, $2, $3, $4, $5::"SessionStatus", $6, $7, $8${val})`;
      const args = [randomUUID(), id[coach], id[client], typeId, status, start, end, `rls-${run}`];
      return who ? write(who, sql, ...args) : prisma.$executeRawUnsafe(sql, ...args);
    };
    const set = (who: Who, rowId: string, assignment: string) =>
      write(who, `UPDATE "CoachingSession" SET ${assignment} WHERE "id" = $1`, rowId);
    const policies = () => prisma.$queryRaw<
      {
        name: string;
        cmd: string;
        qual: string | null;
        check: string | null;
        comment: string | null;
      }[]
    >`
    SELECT p."policyname" AS "name", p."cmd", p."qual", p."with_check" AS "check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = 'public."CoachingSession"'::regclass
    WHERE p."schemaname" = 'public' AND p."tablename" = 'CoachingSession' ORDER BY 1`;
    const added = () =>
      prisma.$queryRaw<{ name: string }[]>`
    SELECT "tgname" AS "name" FROM pg_trigger WHERE "tgrelid" = 'public."CoachingSession"'::regclass AND NOT "tgisinternal"
    UNION ALL SELECT p."oid"::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
    WHERE n."nspname" = 'app' AND p."proname" IN ('coaching_session_private_columns_guard', 'session_type_auto_approves') ORDER BY 1`.then(
        (list) => list.map((r) => r.name),
      );
    let chain: Awaited<ReturnType<typeof policies>> = [];

    beforeAll(async () => {
      for (const k of keys) {
        const coach = k === 'A' ? id.K : k === 'C' ? id.L : null;
        await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`sessions-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
      }
      for (const [typeId, coach, auto] of [
        [st.kAsk, 'K', false],
        [st.kAuto, 'K', true],
        [st.lAuto, 'L', true],
      ] as [string, Key, boolean][]) {
        await prisma.$executeRaw`INSERT INTO "SessionType" ("id", "coach_id", "name", "auto_approve", "updated_at")
        VALUES (${typeId}, ${id[coach]}, 'RLS type', ${auto}, now())`;
      }
      for (const [rowId, coach, status] of [
        [row.note, 'K', 'scheduled'],
        [row.move, 'K', 'scheduled'],
        [row.cancel, 'K', 'requested'],
        [row.confirm, 'K', 'requested'],
        [row.old, 'F', 'completed'],
      ] as [string, Key, string][]) {
        const [start, end] = slot();
        await prisma.$executeRaw`INSERT INTO "CoachingSession" ("id", "coach_id", "client_id", "session_type_id", "status", "start_at",
          "end_at", "title", "coach_notes_md", "video_url", "video_meeting_id", "calendar_event_id", "provider_idempotency_key")
        VALUES (${rowId}, ${id[coach]}, ${id.A}, ${coach === 'K' ? st.kAsk : null}, ${status}::"SessionStatus", ${start}, ${end},
          ${`rls-${run}`}, 'Private note', 'https://example.com/call', 'm-1', 'e-1', 'k-1')`;
      }
      chain = await policies();
    });
    afterAll(() => prisma.$disconnect());

    it('runs as a role that does not bypass row security', async () => {
      expect(
        await as(
          backend('A'),
          (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`,
        ),
      ).toEqual([{ b: false }]);
    });

    describe("under down.sql (#972's text, main today)", () => {
      beforeAll(() => apply(THIS, 'down.sql'));
      afterAll(async () => {
        await prisma.$executeRaw`UPDATE "CoachingSession" SET "coach_notes_md" = 'Private note' WHERE "id" = ${row.note}`;
        await apply(THIS, 'migration.sql');
      });

      it("restores #972's text exactly and drops the trigger and both helpers", async () => {
        const down = await policies();
        expect(await added()).toEqual([]);
        await apply(PR972, 'migration.sql'); // #972 again: nothing may move
        expect(await policies()).toEqual(down);
        const others = (list: typeof down) => list.filter((p) => !/_(insert|update)$/.test(p.name));
        expect(others(down)).toEqual(others(chain));
      });

      it('the holes: the client books with another coach and overwrites the private notes', async () => {
        expect(await book(backend('A'), 'L', 'A', 'scheduled', st.lAuto)).toBe(1);
        expect(await set(backend('A'), row.note, `"coach_notes_md" = 'Overwritten'`)).toBe(1);
      });
    });

    describe('after the migration', () => {
      it('gives exactly the state the replayed chain gave', async () => {
        expect(await policies()).toEqual(chain);
        expect(await added()).toEqual([
          'app.coaching_session_private_columns_guard()',
          'app.session_type_auto_approves(text,text)',
          'coaching_session_private_columns_guard',
        ]);
      });

      it('the helper is SECURITY DEFINER and pinned; the guard runs as the caller; neither is open to PUBLIC or anon', async () => {
        const fns = await prisma.$queryRaw<
          { name: string; definer: boolean; config: string[]; pub: boolean; anon: boolean }[]
        >`
        SELECT p."proname" AS "name", p."prosecdef" AS "definer", p."proconfig" AS "config",
               EXISTS (SELECT 1 FROM aclexplode(p."proacl") a WHERE a."grantee" = 0) AS "pub",
               has_function_privilege('anon', p."oid", 'EXECUTE') AS "anon"
        FROM pg_proc p JOIN pg_namespace n ON n."oid" = p."pronamespace"
        WHERE n."nspname" = 'app' AND p."proname" IN ('coaching_session_private_columns_guard', 'session_type_auto_approves') ORDER BY 1`;
        expect(fns).toEqual([
          {
            name: 'coaching_session_private_columns_guard',
            definer: false,
            config: ['search_path=""'],
            pub: false,
            anon: false,
          },
          {
            name: 'session_type_auto_approves',
            definer: true,
            config: ['search_path=""'],
            pub: false,
            anon: false,
          },
        ]);
      });

      it('a client requests sessions with their own coach only, and never as confirmed', async () => {
        expect(await book(backend('A'), 'K', 'A', 'requested')).toBe(1);
        expect(await book(backend('A'), 'L', 'A', 'requested')).toBe(DENIED);
        expect(await book(backend('A'), 'F', 'A', 'requested', null)).toBe(DENIED); // the former coach
        expect(await book(backend('A'), 'K', 'C', 'requested')).toBe(DENIED); // for another client
        expect(await book(backend('C'), 'L', 'C', 'requested', st.lAuto)).toBe(1);
        expect(await book(backend('C'), 'K', 'C', 'requested')).toBe(DENIED);
        for (const status of ['scheduled', 'completed', 'pending_provider']) {
          expect(await book(backend('A'), 'K', 'A', status)).toBe(DENIED);
        }
        expect(await book(backend('A'), 'K', 'A', 'scheduled', null)).toBe(DENIED);
      });

      it("a client request leaves the coach's side empty: no notes, call link, meeting, calendar event or key", async () => {
        expect(await book(backend('A'), 'K', 'A', 'requested')).toBe(1); // control: all five NULL
        for (const [column, value] of GUARDED) {
          expect(await book(backend('A'), 'K', 'A', 'requested', st.kAsk, [column, value])).toBe(
            DENIED,
          );
        }
        expect(await book(backend('A'), 'K', 'A', 'scheduled', st.kAuto)).toBe(1); // control: instant confirm
        expect(
          await book(backend('A'), 'K', 'A', 'scheduled', st.kAuto, [
            'video_url',
            `'https://example.com/mine'`,
          ]),
        ).toBe(DENIED);
        expect(
          await book(backend('K'), 'K', 'A', 'scheduled', st.kAsk, [
            'video_url',
            `'https://example.com/k'`,
          ]),
        ).toBe(1); // the coach still sets their own call link
      });

      it("a client books confirmed only on their coach's live instant-confirm type", async () => {
        expect(await book(backend('A'), 'K', 'A', 'scheduled', st.kAuto)).toBe(1);
        expect(await book(backend('A'), 'K', 'A', 'scheduled', st.lAuto)).toBe(DENIED); // another coach's type
        await prisma.$executeRaw`UPDATE "SessionType" SET "archived_at" = now() WHERE "id" = ${st.kAuto}`;
        expect(await book(backend('A'), 'K', 'A', 'scheduled', st.kAuto)).toBe(DENIED);
        await prisma.$executeRaw`UPDATE "SessionType" SET "archived_at" = NULL WHERE "id" = ${st.kAuto}`;
        expect(await book(backend('K'), 'K', 'A', 'scheduled')).toBe(1); // the coach books for the client, as before
      });

      it("the session coach changes the coach's side; the client changes none of it", async () => {
        expect(await set(backend('K'), row.confirm, `"status" = 'scheduled'`)).toBe(1);
        for (const [column, value] of GUARDED) {
          expect(await set(backend('K'), row.note, `"${column}" = ${value}`)).toBe(1);
          expect(await set(backend('A'), row.note, `"${column}" = 'From the client'`)).toBe(RAISE);
        }
        expect(await set(backend('A'), row.note, `"coach_id" = '${id.L}'`)).toBe(RAISE);
        for (const status of ['completed', 'no_show', 'pending_provider']) {
          expect(await set(backend('A'), row.note, `"status" = '${status}'`)).toBe(RAISE);
        }
        expect(await set(backend('A'), row.note, `"title" = 'Renamed'`)).toBe(1); // the row is the client's to touch
        const [kept] = await prisma.$queryRaw<{ notes: string; coach: string; status: string }[]>`
        SELECT "coach_notes_md" AS "notes", "coach_id" AS "coach", "status"::text FROM "CoachingSession" WHERE "id" = ${row.note}`;
        expect(kept).toEqual({ notes: 'Overwritten', coach: id.K, status: 'scheduled' });
      });

      it('the client still moves (asking again) and cancels their own sessions', async () => {
        const [start, end] = slot();
        expect(
          await write(
            backend('A'),
            `UPDATE "CoachingSession" SET "start_at" = $2, "end_at" = $3, "status" = 'requested',
        "approved_at" = NULL WHERE "id" = $1`,
            row.move,
            start,
            end,
          ),
        ).toBe(1);
        expect(
          await set(backend('A'), row.cancel, `"status" = 'canceled', "ended_at" = now()`),
        ).toBe(1);
        expect(await set(backend('A'), row.cancel, `"status" = 'requested'`)).toBe(RAISE); // a cancel is final
      });

      it("the client keeps reading a former coach's session but writes it no more", async () => {
        expect(await reads(backend('A'), row.old)).toBe(1);
        expect(await set(backend('A'), row.old, `"title" = 'Renamed'`)).toBe(0);
      });

      it('service_role, as the backend connects, still changes every coach-side column', async () => {
        expect(
          await set(
            'service_role',
            row.note,
            `"coach_notes_md" = 'Server', "video_url" = 'https://example.com/s',
        "video_meeting_id" = 'm-3', "calendar_event_id" = 'e-3', "provider_idempotency_key" = 'k-3',
        "status" = 'completed', "coach_id" = '${id.L}'`,
          ),
        ).toBe(1);
        expect(
          await set('service_role', row.note, `"coach_id" = '${id.K}', "status" = 'scheduled'`),
        ).toBe(1);
      });

      it('the Data API model (JWT, no GUC) reads and writes no session', async () => {
        expect(await reads(backend('A'), row.note)).toBe(1);
        expect(await reads(backend('K'), row.note)).toBe(1);
        for (const k of ['A', 'K'] as Key[]) {
          expect(await reads(dataApi(k), row.note)).toBe(0);
          expect(await set(dataApi(k), row.note, `"coach_notes_md" = 'Data API'`)).toBe(0);
        }
        expect(await book(dataApi('A'), 'K', 'A', 'requested')).toBe(DENIED);
      });
    });
  },
);
