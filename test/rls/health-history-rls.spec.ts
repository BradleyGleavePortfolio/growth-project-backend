/**
 * RLSLIVE3a (RLSINV H01-H04, H10): at the row layer a client's check-ins,
 * bloodwork and alerts follow the client to the current coach, a former coach
 * reads none of them after a move, wearable prompts end with the coaching, and
 * red-flag alerts are created and removed by the server only.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is a client who moves from coach F to coach K; C is coach L's client; O is
 * the owner admin. Every id differs from its supabase id (RLSINV Y04). The
 * seeded rows are F-era: written while A was F's client, coach_id = F.
 * The suite runs down.sql (the production text today, exactly), then
 * migration.sql, which must give the state the replayed chain gave. Every 0 or
 * 42501 follows a control of 1 on the same row or table.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('health-history-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502000100_health_history_follows_the_client');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

const TABLES = ['BloodworkAttachment', 'BloodworkPanel', 'BloodworkResult', 'CheckIn', 'CoachAlert',
  'community_wearable_prompt_sources', 'community_wearable_prompts'];
// The production text of every policy this migration touches (catalog of 2026-10-13,
// whose dump folds the deparser's line breaks into single spaces, as flat() does).
const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
const ALERT_OLD = '(app.is_owner() OR ((app.current_user_id() IS NOT NULL) AND ((coach_id = app.current_user_id()) OR (client_id = app.current_user_id()) OR app.is_current_coach_of(client_id))))';
const panelOld = (t: string) => `(app.is_owner() OR (EXISTS ( SELECT 1 FROM "BloodworkPanel" bp WHERE ((bp.id = "${t}".panel_id) AND ((bp.client_id = app.current_user_id()) OR (bp.coach_id = app.current_user_id()) OR app.is_current_coach_of(bp.client_id))))))`;
const SOURCES_OLD = '(EXISTS ( SELECT 1 FROM community_wearable_prompts p WHERE ((p.id = community_wearable_prompt_sources."promptId") AND app.is_community_workspace_coach(p."workspaceId"))))';
const OWN_COACH_OLD = '((app.current_user_id() IS NOT NULL) AND (coach_id = app.current_user_id()))';
const OLD: Record<string, [string, string | null, string | null, string | null]> = { // cmd, USING, CHECK, comment
  'CheckIn.check_in_coach_select': ['SELECT', OWN_COACH_OLD, null, null],
  'BloodworkPanel.bloodwork_panel_coach_select': ['SELECT', OWN_COACH_OLD, null, null],
  'BloodworkPanel.bloodwork_panel_current_coach_insert': ['INSERT', null,
    '((app.current_user_id() IS NOT NULL) AND (coach_id = app.current_user_id()) AND app.is_current_coach_of(client_id))', null],
  'BloodworkResult.p_bloodworkresult_select': ['SELECT', panelOld('BloodworkResult'), null,
    'Read PHI lab markers only for the panel client, panel coach, the current coach of that client, or an owner.'],
  'BloodworkResult.p_bloodworkresult_insert': ['INSERT', null, panelOld('BloodworkResult'),
    'Insert lab markers only into panels the caller owns, coaches, or is an owner of.'],
  'BloodworkAttachment.p_bloodworkattachment_select': ['SELECT', panelOld('BloodworkAttachment'), null,
    'Read PHI attachment pointers only for the panel client, panel coach, the current coach of that client, or an owner.'],
  'BloodworkAttachment.p_bloodworkattachment_insert': ['INSERT', null, panelOld('BloodworkAttachment'),
    'Insert attachment pointers only into panels the caller owns, coaches, or is an owner of.'],
  'CoachAlert.p_coachalert_select': ['SELECT', ALERT_OLD, null, "PR-RLS-02: owner, the alert coach, the alert client, or the client's current coach may read."],
  'CoachAlert.p_coachalert_update': ['UPDATE', ALERT_OLD, ALERT_OLD, "PR-RLS-02: owner, the alert coach, the alert client, or the client's current coach may update."],
  'CoachAlert.p_coachalert_insert': ['INSERT', null, ALERT_OLD, "PR-RLS-02: owner, the alert coach, the alert client, or the client's current coach may insert."],
  'CoachAlert.p_coachalert_delete': ['DELETE', ALERT_OLD, null, "PR-RLS-02: owner, the alert coach, the alert client, or the client's current coach may delete."],
  'community_wearable_prompts.community_wearable_prompts_coach_all': ['ALL',
    'app.is_community_workspace_coach("workspaceId")', 'app.is_community_workspace_coach("workspaceId")', null],
  'community_wearable_prompt_sources.community_wearable_prompt_sources_coach_all': ['ALL', SOURCES_OLD, SOURCES_OLD, null],
};
const DROPPED = ['BloodworkPanel.bloodwork_panel_current_coach_insert', 'CoachAlert.p_coachalert_insert', 'CoachAlert.p_coachalert_delete'];

type Key = 'A' | 'C' | 'F' | 'K' | 'L' | 'O';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', C: 'student', F: 'coach', K: 'coach', L: 'coach', O: 'owner' };
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('health history follows the client; safety alerts stay with the coach', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['F', 'K', 'L', 'O', 'A', 'C']; // clients last: they reference their coach
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  const row = {
    checkIn: `ci-${run}`, panel: `bp-${run}`, result: `br-${run}`, attachment: `ba-${run}`, alert: `ca-${run}`,
    spareAlert: `ca2-${run}`, workspace: randomUUID(), connection: `wc-${run}`, sample: `ws-${run}`,
    prompt: randomUUID(), source: randomUUID(),
  };

  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify({ sub: sub[who.key], role: 'authenticated' }));
      if (who.guc) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
      }
      return query(tx);
    });
  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    });
  // Rows written (or the SQLSTATE of the refusal).
  const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
  };
  const reads = (who: Who, table: string, rowId: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id"::text = $1`, rowId))
      .then((r) => r[0].n);
  // The five F-era rows about A plus the prompt and its source, as one caller sees them.
  const ROWS: [string, keyof typeof row][] = [['CheckIn', 'checkIn'], ['BloodworkPanel', 'panel'],
    ['BloodworkResult', 'result'], ['BloodworkAttachment', 'attachment'], ['CoachAlert', 'alert'],
    ['community_wearable_prompts', 'prompt'], ['community_wearable_prompt_sources', 'source']];
  const sees = async (who: Who) => {
    const out: Record<string, number> = {};
    for (const [table, k] of ROWS) out[table] = await reads(who, table, row[k]);
    return out;
  };
  const seen = (checkIn: number, bloodwork: number, alert: number, wearable: number) => ({
    CheckIn: checkIn, BloodworkPanel: bloodwork, BloodworkResult: bloodwork, BloodworkAttachment: bloodwork,
    CoachAlert: alert, community_wearable_prompts: wearable, community_wearable_prompt_sources: wearable,
  });
  const moveA = (coach: Key) => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id[coach]} WHERE "id" = ${id.A}`;
  const policies = () => prisma.$queryRaw<{ name: string; cmd: string; roles: string; qual: string | null; check: string | null; comment: string | null }[]>`
    SELECT p."tablename" || '.' || p."policyname" AS "name", p."cmd", p."roles"::text AS "roles", p."qual",
           p."with_check" AS "check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = format('public.%I', p."tablename")::regclass
    WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
    .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
  const insertResult = (who: Who, panel = row.panel) => write(who,
    `INSERT INTO "BloodworkResult" ("id", "panel_id", "marker_name", "updated_at") VALUES ($1, $2, 'ferritin', now())`, randomUUID(), panel);
  const insertAttachment = (who: Who, panel = row.panel) => write(who,
    `INSERT INTO "BloodworkAttachment" ("id", "panel_id", "updated_at") VALUES ($1, $2, now())`, randomUUID(), panel);
  const insertPanel = (who: Who, coach: Key) => write(who,
    `INSERT INTO "BloodworkPanel" ("id", "client_id", "coach_id", "collection_date", "updated_at") VALUES ($1, $2, $3, now(), now())`,
    randomUUID(), id.A, id[coach]);
  const insertAlert = (who: Who | null, alertId: string = randomUUID()) => {
    const sql = `INSERT INTO "CoachAlert" ("id", "coach_id", "client_id", "alert_type", "message") VALUES ($1, $2, $3, 'risk_red_transition', 'RLS test alert')`;
    return who ? write(who, sql, alertId, id.K, id.A) : prisma.$executeRawUnsafe(sql, alertId, id.K, id.A);
  };
  const ackAlert = (who: Who) => write(who, `UPDATE "CoachAlert" SET "acknowledged_at" = now() WHERE "id" = $1`, row.alert);
  const deleteAlert = (who: Who, alertId = row.alert) => write(who, `DELETE FROM "CoachAlert" WHERE "id" = $1`, alertId);
  const insertPrompt = (who: Who, metric: string) => write(who,
    `INSERT INTO "community_wearable_prompts" ("id", "workspaceId", "coachId", "clientId", "metricKey", "promptText")
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'RLS prompt')`, randomUUID(), row.workspace, id.F, id.A, metric);
  const insertSource = (who: Who) => write(who,
    `INSERT INTO "community_wearable_prompt_sources" ("id", "promptId", "sampleId", "metricKey", "observedValue")
     VALUES ($1::uuid, $2::uuid, $3, 'STEPS', 1)`, randomUUID(), row.prompt, row.sample);
  let chain: Awaited<ReturnType<typeof policies>> = [];

  beforeAll(async () => {
    for (const k of keys) {
      const coach = k === 'A' ? id.F : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`health-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    await prisma.$executeRaw`INSERT INTO "CheckIn" ("id", "user_id", "coach_id", "date", "mood", "energy", "soreness")
      VALUES (${row.checkIn}, ${id.A}, ${id.F}, DATE '2027-01-04', 3, 3, 2)`;
    await prisma.$executeRaw`INSERT INTO "BloodworkPanel" ("id", "client_id", "coach_id", "collection_date", "updated_at")
      VALUES (${row.panel}, ${id.A}, ${id.F}, now(), now())`;
    await prisma.$executeRaw`INSERT INTO "BloodworkResult" ("id", "panel_id", "marker_name", "updated_at")
      VALUES (${row.result}, ${row.panel}, 'ferritin', now())`;
    await prisma.$executeRaw`INSERT INTO "BloodworkAttachment" ("id", "panel_id", "updated_at") VALUES (${row.attachment}, ${row.panel}, now())`;
    for (const alertId of [row.alert, row.spareAlert]) {
      await prisma.$executeRaw`INSERT INTO "CoachAlert" ("id", "coach_id", "client_id", "alert_type", "message")
        VALUES (${alertId}, ${id.F}, ${id.A}, 'risk_red_transition', 'RLS test alert')`;
    }
    await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
      VALUES (${row.workspace}::uuid, ${id.F}, 'RLS workspace', ${`rls-${run}`}, now())`;
    await prisma.$executeRaw`INSERT INTO "WearableConnection" ("id", "user_id", "provider") VALUES (${row.connection}, ${id.A}, 'GARMIN'::"WearableProvider")`;
    await prisma.$executeRaw`INSERT INTO "WearableSample"
        ("id", "user_id", "connection_id", "provider", "metric", "bucket", "value", "unit", "start_at", "end_at", "dedup_key")
      VALUES (${row.sample}, ${id.A}, ${row.connection}, 'GARMIN'::"WearableProvider", 'STEPS'::"WearableMetricType",
        'HEALTH_FITNESS'::"WearableMetricBucket", 1, 'count', now(), now(), ${`rls-${run}`})`;
    await prisma.$executeRaw`INSERT INTO "community_wearable_prompts" ("id", "workspaceId", "coachId", "clientId", "metricKey", "promptText")
      VALUES (${row.prompt}::uuid, ${row.workspace}::uuid, ${id.F}, ${id.A}, 'STEPS', 'RLS prompt')`;
    await prisma.$executeRaw`INSERT INTO "community_wearable_prompt_sources" ("id", "promptId", "sampleId", "metricKey", "observedValue")
      VALUES (${row.source}::uuid, ${row.prompt}::uuid, ${row.sample}, 'STEPS', 1)`;
    chain = await policies();
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('A'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  describe('under down.sql (the production text today)', () => {
    beforeAll(() => apply('down.sql'));
    afterAll(async () => {
      await moveA('F');
      await apply('migration.sql');
    });

    it('restores every touched policy exactly and leaves the others as the chain had them', async () => {
      const now = await policies();
      for (const [name, [cmd, qual, check, comment]] of Object.entries(OLD)) {
        expect(now.find((p) => p.name === name)).toEqual({ name, cmd, roles: '{public}', qual, check, comment });
      }
      const untouched = (list: typeof now) => list.filter((p) => !(p.name in OLD));
      expect(untouched(now)).toEqual(untouched(chain));
      expect(chain.filter((p) => DROPPED.includes(p.name))).toEqual([]);
    });

    it('the holes: after the move the former coach reads everything, the new coach nothing, the client their alerts', async () => {
      expect(await sees(backend('F'))).toEqual(seen(1, 1, 1, 1));
      await moveA('K');
      expect(await sees(backend('F'))).toEqual(seen(1, 1, 1, 1));
      expect(await sees(backend('K'))).toEqual(seen(0, 0, 1, 0));
      expect(await reads(backend('A'), 'CoachAlert', row.alert)).toBe(1);
      expect(await deleteAlert(backend('A'), row.spareAlert)).toBe(1);
      await insertAlert(null, row.spareAlert);
    });
  });

  describe('after the migration', () => {
    it('gives exactly the state the replayed chain gave', async () => {
      expect(await policies()).toEqual(chain);
    });

    it('before the move: F, the current coach, reads every row about A and writes prompts; K and L read none', async () => {
      expect(await sees(backend('F'))).toEqual(seen(1, 1, 1, 1));
      expect(await sees(backend('K'))).toEqual(seen(0, 0, 0, 0));
      expect(await sees(backend('L'))).toEqual(seen(0, 0, 0, 0));
      expect(await insertPrompt(backend('F'), 'HRV')).toBe(1);
      expect(await insertSource(backend('F'))).toBe(1);
      expect(await write(backend('F'), `UPDATE "community_wearable_prompts" SET "actedOnAt" = now() WHERE "id" = $1::uuid`, row.prompt)).toBe(1);
    });

    it('after the move: K reads every F-era row about A; F reads none; L still none', async () => {
      await moveA('K');
      expect(await sees(backend('K'))).toEqual(seen(1, 1, 1, 0)); // the prompts live in F's workspace
      expect(await sees(backend('F'))).toEqual(seen(0, 0, 0, 0));
      expect(await sees(backend('L'))).toEqual(seen(0, 0, 0, 0));
    });

    it('the former coach can no longer write prompts or sources about A', async () => {
      expect(await insertPrompt(backend('F'), 'SLEEP')).toBe(DENIED);
      expect(await insertSource(backend('F'))).toBe(DENIED);
      expect(await write(backend('F'), `UPDATE "community_wearable_prompts" SET "dismissedAt" = now() WHERE "id" = $1::uuid`, row.prompt)).toBe(0);
      expect(await write(backend('F'), `DELETE FROM "community_wearable_prompts" WHERE "id" = $1::uuid`, row.prompt)).toBe(0);
      expect((await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "community_wearable_prompts"
        WHERE "id" = ${row.prompt}::uuid AND "dismissedAt" IS NULL`)[0].n).toBe(1);
    });

    it('the client still reads their own check-ins and bloodwork, but no alert about them', async () => {
      expect(await sees(backend('A'))).toEqual(seen(1, 1, 0, 0));
      expect(await reads(backend('K'), 'CoachAlert', row.alert)).toBe(1);
      expect(await reads(backend('A'), 'CoachAlert', row.alert)).toBe(0);
    });

    it('lab values are entered only by the panel client: coaches insert no results, attachments or panels', async () => {
      expect(await insertResult(backend('A'))).toBe(1);
      expect(await insertResult(backend('K'))).toBe(DENIED);
      expect(await insertResult(backend('F'))).toBe(DENIED);
      expect(await insertAttachment(backend('A'))).toBe(1);
      expect(await insertAttachment(backend('K'))).toBe(DENIED);
      expect(await insertAttachment(backend('F'))).toBe(DENIED);
      expect(await insertPanel(backend('A'), 'K')).toBe(1);
      expect(await insertPanel(backend('K'), 'K')).toBe(DENIED);
    });

    it('alerts: the current coach acknowledges; the client and the former coach resolve and delete nothing', async () => {
      expect(await ackAlert(backend('K'))).toBe(1);
      expect(await ackAlert(backend('A'))).toBe(0);
      expect(await ackAlert(backend('F'))).toBe(0);
      expect(await write(backend('K'), `UPDATE "CoachAlert" SET "client_id" = $1 WHERE "id" = $2`, id.C, row.alert)).toBe(DENIED);
      expect(await reads(backend('O'), 'CoachAlert', row.spareAlert)).toBe(1);
      expect(await deleteAlert(backend('O'), row.spareAlert)).toBe(0); // no DELETE policy at all, even for the owner
      expect(await reads(backend('K'), 'CoachAlert', row.alert)).toBe(1);
      for (const k of ['K', 'A', 'F'] as Key[]) expect(await deleteAlert(backend(k))).toBe(0);
      expect(await reads(backend('K'), 'CoachAlert', row.alert)).toBe(1);
      expect(await prisma.$executeRawUnsafe(`DELETE FROM "CoachAlert" WHERE "id" = $1`, row.spareAlert)).toBe(1); // the server
    });

    it('alerts are created by the server only', async () => {
      expect(await insertAlert(null)).toBe(1);
      for (const k of ['A', 'K', 'F'] as Key[]) expect(await insertAlert(backend(k))).toBe(DENIED);
    });

    it('the Data API model (JWT, no GUC) reads nothing on any of the seven tables', async () => {
      expect(await sees(backend('K'))).toEqual(seen(1, 1, 1, 0));
      expect(await sees(backend('A'))).toEqual(seen(1, 1, 0, 0));
      await moveA('F');
      expect(await sees(backend('F'))).toEqual(seen(1, 1, 1, 1));
      for (const k of ['A', 'K', 'F'] as Key[]) expect(await sees(dataApi(k))).toEqual(seen(0, 0, 0, 0));
    });
  });
});
