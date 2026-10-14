/**
 * RLSLIVE3d (RLSINV P04, P05, P06, P07): at the row layer Roman's approval
 * drafts, AI audit rows and the activity feed are written by the server only,
 * and a coach keeps an AI draft, message draft, audit row or feed event about a
 * client only while that client is still his.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is a client who moves from coach F to coach K; B is K's client; C is coach
 * L's client. Rows the server writes are seeded by the superuser (service_role
 * in the app). Every id differs from its supabase id (RLSINV Y04). The suite
 * runs down.sql (the production text of 2026-10-13), then migration.sql, which
 * must give the state the replayed chain gave. Every 0 or 42501 follows a
 * control of 1 on the same row or table.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('ai-coach-private-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502000600_ai_and_coach_private_rows');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

const TABLES = ['AiActionDraft', 'AiRequestAudit', 'AIDraft', 'MessageDraft', 'ActivityEvent'];
const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
// Production text (2026-10-13 catalog, the same as main's migrations) of every policy this changes.
const ME = 'app.current_user_id()';
const ACTION_SELECT = `((${ME} IS NOT NULL) AND ((requester_id = ${ME}) OR (subject_user_id = ${ME}) OR (tenant_coach_id = ${ME}) OR (decided_by_id = ${ME})))`;
const ACTION_DECIDE = `((${ME} IS NOT NULL) AND (tenant_coach_id = ${ME}) AND ((requester_id IS NULL) OR (requester_id <> ${ME})))`;
const REQUESTER_INSERT = `((${ME} IS NOT NULL) AND ((requester_id = ${ME}) OR (tenant_coach_id = ${ME})))`;
const AUDIT_SELECT = `((${ME} IS NOT NULL) AND ((requester_id = ${ME}) OR (subject_user_id = ${ME}) OR (tenant_coach_id = ${ME})))`;
const AUDIT_UPDATE = `((${ME} IS NOT NULL) AND (tenant_coach_id = ${ME}))`;
const AI_DRAFT = `((${ME} IS NOT NULL) AND ("coachId" = ${ME}))`;
const MESSAGE_DRAFT = `((${ME} IS NOT NULL) AND (coach_id = ${ME}))`;
const EVENT = `(app.is_owner() OR ((${ME} IS NOT NULL) AND ((actor_id = ${ME}) OR (coach_id = ${ME}) OR (client_id = ${ME}) OR app.is_current_coach_of(client_id))))`;
const eventNote = (verb: string) => `PR-RLS-06 participant-event ${verb}: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.`;
const OLD: Record<string, [string, string | null, string | null, string | null]> = { // cmd, USING, CHECK, comment
  'AiActionDraft.ai_action_draft_participant_select': ['SELECT', ACTION_SELECT, null, null],
  'AiActionDraft.ai_action_draft_tenant_decide_update': ['UPDATE', ACTION_DECIDE, ACTION_DECIDE, null],
  'AiActionDraft.ai_action_draft_requester_insert': ['INSERT', null, REQUESTER_INSERT, null],
  'AiRequestAudit.ai_request_audit_participant_select': ['SELECT', AUDIT_SELECT, null, null],
  'AiRequestAudit.ai_request_audit_requester_insert': ['INSERT', null, REQUESTER_INSERT, null],
  'AiRequestAudit.ai_request_audit_tenant_update': ['UPDATE', AUDIT_UPDATE, AUDIT_UPDATE, null],
  'AIDraft.ai_draft_coach_all': ['ALL', AI_DRAFT, AI_DRAFT, null],
  'MessageDraft.message_draft_coach_access': ['ALL', MESSAGE_DRAFT, MESSAGE_DRAFT, null],
  'ActivityEvent.p_activityevent_select': ['SELECT', EVENT, null, eventNote('read')],
  'ActivityEvent.p_activityevent_insert': ['INSERT', null, EVENT, eventNote('insert')],
  'ActivityEvent.p_activityevent_update': ['UPDATE', EVENT, EVENT, eventNote('update')],
  'ActivityEvent.p_activityevent_delete': ['DELETE', EVENT, null, eventNote('delete')],
};
const DROPPED = ['AiActionDraft.ai_action_draft_requester_insert', 'AiRequestAudit.ai_request_audit_requester_insert',
  'AiRequestAudit.ai_request_audit_tenant_update', 'ActivityEvent.p_activityevent_insert',
  'ActivityEvent.p_activityevent_update', 'ActivityEvent.p_activityevent_delete'];

type Key = 'A' | 'B' | 'C' | 'F' | 'K' | 'L';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', B: 'student', C: 'student', F: 'coach', K: 'coach', L: 'coach' };
const DENIED = '42501';

(DB_URL ? describe : describe.skip)('Roman drafts, audits, coach drafts and the feed stay with the coaching relationship', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['F', 'K', 'L', 'A', 'B', 'C']; // clients last: they reference their coach
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const run = randomUUID().slice(0, 8);
  // F-era and K-era rows about A; *N = a coach-K row naming no client.
  const row = {
    dF: `adf-${run}`, dK: `adk-${run}`, dN: `adn-${run}`, // AiActionDraft
    aF: `aaf-${run}`, aK: `aak-${run}`, // AiRequestAudit
    iF: `aif-${run}`, iK: `aik-${run}`, // AIDraft
    mF: `amf-${run}`, // MessageDraft
    eF: `aef-${run}`, eK: `aek-${run}`, eN: `aen-${run}`, // ActivityEvent
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
  // who = null: the server writes it (the superuser here, service_role in the app).
  const put = (who: Who | null, sql: string, ...params: unknown[]) =>
    who ? write(who, sql, ...params) : prisma.$executeRawUnsafe(sql, ...params);
  const reads = (who: Who, table: string, rowId: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1`, rowId))
      .then((r) => r[0].n);
  const u = (k: Key | null) => (k ? id[k] : null);
  const actionDraft = (who: Who | null, requester: Key | null, subject: Key | null, tenant: Key | null, rowId = randomUUID()) =>
    put(who, `INSERT INTO "AiActionDraft" ("id", "capability", "requester_id", "subject_user_id", "tenant_coach_id", "payload")
      VALUES ($1, 'draft.coach_message', $2, $3, $4, '{}'::jsonb)`, rowId, u(requester), u(subject), u(tenant));
  const audit = (who: Who | null, requester: Key, subject: Key | null, tenant: Key | null, rowId = randomUUID()) =>
    put(who, `INSERT INTO "AiRequestAudit" ("id", "request_id", "capability", "requester_id", "subject_user_id", "tenant_coach_id", "provider")
      VALUES ($1, $2, 'chat.client_coach', $3, $4, $5, 'stub')`, rowId, `req-${randomUUID()}`, u(requester), u(subject), u(tenant));
  const aiDraft = (who: Who | null, coach: Key, client: Key, rowId = randomUUID()) =>
    put(who, `INSERT INTO "AIDraft" ("id", "coachId", "clientId", "type", "inputContext", "modelUsed", "promptVersion", "generatedPayload", "status", "updatedAt")
      VALUES ($1, $2, $3, 'INSIGHT', '{}'::jsonb, 'stub', 'v1', '{}'::jsonb, 'APPROVED', now())`, rowId, id[coach], id[client]);
  const messageDraft = (who: Who | null, coach: Key, client: Key, rowId = randomUUID()) =>
    put(who, `INSERT INTO "MessageDraft" ("id", "coach_id", "client_id", "body", "updated_at") VALUES ($1, $2, $3, 'RLS draft', now())`,
      rowId, id[coach], id[client]);
  const event = (who: Who | null, actor: Key, coach: Key | null, client: Key | null, rowId = randomUUID()) =>
    put(who, `INSERT INTO "ActivityEvent" ("id", "actor_id", "coach_id", "client_id", "type") VALUES ($1, $2, $3, $4, 'coach.message_sent')`,
      rowId, id[actor], u(coach), u(client));
  const decide = (who: Who, rowId: string) =>
    write(who, `UPDATE "AiActionDraft" SET "status" = 'approved', "decided_by_id" = $1 WHERE "id" = $2`, id[who.key], rowId);
  const moveA = (coach: Key) => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id[coach]} WHERE "id" = ${id.A}`;
  const policies = () => prisma.$queryRaw<{ name: string; cmd: string; roles: string; qual: string | null; check: string | null; comment: string | null }[]>`
    SELECT p."tablename" || '.' || p."policyname" AS "name", p."cmd", p."roles"::text AS "roles", p."qual",
           p."with_check" AS "check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = format('public.%I', p."tablename")::regclass
    WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
    .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
  let chain: Awaited<ReturnType<typeof policies>> = [];

  beforeAll(async () => {
    for (const k of keys) {
      const coach = k === 'A' ? id.F : k === 'B' ? id.K : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`aicp-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    // What the server writes (service_role): F asked Roman to draft a message to A; a wearable-style draft
    // in K's queue about A (no requester); K's own draft naming no client.
    await actionDraft(null, 'F', 'A', 'F', row.dF);
    await actionDraft(null, null, 'A', 'K', row.dK);
    await actionDraft(null, 'K', null, 'K', row.dN);
    await audit(null, 'A', 'A', 'F', row.aF); // A's Roman spend from F's pool
    await audit(null, 'K', 'A', 'K', row.aK);
    await aiDraft(null, 'F', 'A', row.iF);
    await messageDraft(null, 'F', 'A', row.mF);
    await event(null, 'F', 'F', 'A', row.eF);
    await event(null, 'K', 'K', 'A', row.eK);
    await event(null, 'K', 'K', null, row.eN);
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

    it('restores every touched policy exactly and leaves the rest', async () => {
      const now = await policies();
      for (const [name, [cmd, qual, check, comment]] of Object.entries(OLD)) {
        expect(now.find((p) => p.name === name)).toEqual({ name, cmd, roles: '{public}', qual, check, comment });
      }
      const untouched = (list: typeof now) => list.filter((p) => !(p.name in OLD));
      expect(untouched(now)).toEqual(untouched(chain));
    });

    it('the holes: forged drafts, audits and events; the former coach keeps his rows', async () => {
      expect(await actionDraft(backend('A'), 'A', 'A', 'L')).toBe(1);
      expect(await audit(backend('K'), 'K', 'C', 'K')).toBe(1);
      expect(await event(backend('A'), 'A', 'L', 'A')).toBe(1);
      await moveA('K');
      expect(await reads(backend('F'), 'AiActionDraft', row.dF)).toBe(1);
      expect(await reads(backend('F'), 'AIDraft', row.iF)).toBe(1);
      expect(await reads(backend('F'), 'MessageDraft', row.mF)).toBe(1);
    });
  });

  describe('after the migration', () => {
    it('gives exactly the state the replayed chain gave, without the write policies', async () => {
      expect(await policies()).toEqual(chain);
      expect(chain.map((p) => p.name).filter((n) => DROPPED.includes(n))).toEqual([]);
    });

    it('before the move: F reads his drafts, audits and events about A', async () => {
      expect(await reads(backend('F'), 'AiActionDraft', row.dF)).toBe(1);
      expect(await reads(backend('F'), 'AiRequestAudit', row.aF)).toBe(1);
      expect(await reads(backend('F'), 'AIDraft', row.iF)).toBe(1);
      expect(await reads(backend('F'), 'MessageDraft', row.mF)).toBe(1);
      expect(await reads(backend('F'), 'ActivityEvent', row.eF)).toBe(1);
    });

    it('Roman\'s approval drafts are server-written; the coach decides his own queue', async () => {
      await moveA('K');
      expect(await reads(backend('K'), 'AiActionDraft', row.dK)).toBe(1); // control: a service-written draft
      expect(await actionDraft(backend('A'), 'A', 'A', 'L')).toBe(DENIED);
      expect(await actionDraft(backend('A'), 'A', 'A', 'K')).toBe(DENIED);
      expect(await actionDraft(backend('K'), 'K', 'A', 'K')).toBe(DENIED);
      expect(await actionDraft(backend('K'), 'K', 'C', 'K')).toBe(DENIED);
      expect(await reads(backend('A'), 'AiActionDraft', row.dK)).toBe(1);
      expect(await reads(backend('L'), 'AiActionDraft', row.dK)).toBe(0);
      expect(await reads(backend('B'), 'AiActionDraft', row.dK)).toBe(0);
      expect(await reads(backend('K'), 'AiActionDraft', row.dN)).toBe(1); // a draft naming no client
      expect(await reads(backend('L'), 'AiActionDraft', row.dN)).toBe(0);
      expect(await decide(backend('K'), row.dK)).toBe(1);
    });

    it('after the move F loses A\'s drafts and K never sees F\'s; A keeps them', async () => {
      expect(await reads(backend('F'), 'AiActionDraft', row.dF)).toBe(0);
      expect(await reads(backend('K'), 'AiActionDraft', row.dF)).toBe(0);
      expect(await reads(backend('A'), 'AiActionDraft', row.dF)).toBe(1);
      expect(await decide(backend('F'), row.dF)).toBe(0);
    });

    it('AI audit rows are append-only and server-written; F loses A\'s', async () => {
      expect(await reads(backend('K'), 'AiRequestAudit', row.aK)).toBe(1); // control
      expect(await write(backend('K'), `UPDATE "AiRequestAudit" SET "approval_status" = 'approved' WHERE "id" = $1`, row.aK)).toBe(0);
      expect(await write(backend('K'), `DELETE FROM "AiRequestAudit" WHERE "id" = $1`, row.aK)).toBe(0);
      expect(await audit(backend('K'), 'K', 'A', 'K')).toBe(DENIED);
      expect(await audit(backend('A'), 'A', 'A', 'L')).toBe(DENIED);
      expect(await reads(backend('A'), 'AiRequestAudit', row.aF)).toBe(1);
      expect(await reads(backend('F'), 'AiRequestAudit', row.aF)).toBe(0);
      expect(await reads(backend('K'), 'AiRequestAudit', row.aF)).toBe(0);
      expect(await reads(backend('L'), 'AiRequestAudit', row.aK)).toBe(0);
    });

    it('AI drafts: K writes for his client only; F loses A\'s; A keeps reading the approved one', async () => {
      expect(await aiDraft(backend('K'), 'K', 'A', row.iK)).toBe(1); // control about A
      expect(await aiDraft(backend('K'), 'K', 'C')).toBe(DENIED);
      expect(await aiDraft(backend('F'), 'F', 'A')).toBe(DENIED);
      expect(await reads(backend('K'), 'AIDraft', row.iK)).toBe(1);
      expect(await write(backend('K'), `UPDATE "AIDraft" SET "clientId" = $1 WHERE "id" = $2`, id.C, row.iK)).toBe(DENIED);
      expect(await reads(backend('F'), 'AIDraft', row.iF)).toBe(0);
      expect(await reads(backend('K'), 'AIDraft', row.iF)).toBe(0);
      expect(await write(backend('F'), `UPDATE "AIDraft" SET "status" = 'REJECTED' WHERE "id" = $1`, row.iF)).toBe(0);
      expect(await write(backend('F'), `DELETE FROM "AIDraft" WHERE "id" = $1`, row.iF)).toBe(0);
      expect(await reads(backend('A'), 'AIDraft', row.iF)).toBe(1);
      expect(await reads(backend('A'), 'AIDraft', row.iK)).toBe(1);
    });

    it('message drafts: K writes for his client only; F loses his draft to A', async () => {
      const mK = randomUUID();
      expect(await messageDraft(backend('K'), 'K', 'A', mK)).toBe(1); // control about A
      expect(await messageDraft(backend('K'), 'K', 'C')).toBe(DENIED);
      expect(await reads(backend('K'), 'MessageDraft', mK)).toBe(1);
      expect(await reads(backend('F'), 'MessageDraft', row.mF)).toBe(0);
      expect(await reads(backend('K'), 'MessageDraft', row.mF)).toBe(0);
      expect(await write(backend('F'), `UPDATE "MessageDraft" SET "body" = 'x' WHERE "id" = $1`, row.mF)).toBe(0);
      expect(await reads(backend('A'), 'MessageDraft', mK)).toBe(0);
    });

    it('the feed is server-written: nobody inserts, edits or deletes an event', async () => {
      expect(await reads(backend('A'), 'ActivityEvent', row.eK)).toBe(1); // control: a server-written event
      expect(await reads(backend('K'), 'ActivityEvent', row.eK)).toBe(1);
      expect(await event(backend('A'), 'A', 'K', 'A')).toBe(DENIED);
      expect(await event(backend('K'), 'K', 'K', 'A')).toBe(DENIED);
      expect(await event(backend('K'), 'K', 'K', null)).toBe(DENIED);
      expect(await write(backend('K'), `UPDATE "ActivityEvent" SET "type" = 'x' WHERE "id" = $1`, row.eK)).toBe(0);
      expect(await write(backend('A'), `DELETE FROM "ActivityEvent" WHERE "id" = $1`, row.eK)).toBe(0);
      expect(await reads(backend('K'), 'ActivityEvent', row.eK)).toBe(1);
    });

    it('feed reads after the move: A and his current coach K read his history; F and others read none', async () => {
      expect(await reads(backend('A'), 'ActivityEvent', row.eF)).toBe(1);
      expect(await reads(backend('K'), 'ActivityEvent', row.eF)).toBe(1);
      expect(await reads(backend('F'), 'ActivityEvent', row.eF)).toBe(0);
      for (const k of ['B', 'C', 'L'] as Key[]) expect(await reads(backend(k), 'ActivityEvent', row.eK)).toBe(0);
      expect(await reads(backend('K'), 'ActivityEvent', row.eN)).toBe(1); // an event naming no client
      expect(await reads(backend('L'), 'ActivityEvent', row.eN)).toBe(0);
    });

    it('the Data API model (JWT, no GUC) reads and writes nothing on the five tables', async () => {
      const mine: [string, string, Key][] = [['AiActionDraft', row.dK, 'K'], ['AiRequestAudit', row.aK, 'K'],
        ['AIDraft', row.iK, 'K'], ['ActivityEvent', row.eK, 'K'], ['AiActionDraft', row.dF, 'A']];
      const mK = await as(backend('K'), (tx) => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MessageDraft" WHERE "client_id" = ${id.A}`);
      expect(mK).toHaveLength(1);
      mine.push(['MessageDraft', mK[0].id, 'K']);
      for (const [table, rowId, owner] of mine) {
        expect(await reads(backend(owner), table, rowId)).toBe(1);
        for (const k of ['A', 'K', 'F'] as Key[]) expect(await reads(dataApi(k), table, rowId)).toBe(0);
      }
      expect(await actionDraft(dataApi('A'), 'A', 'A', 'K')).toBe(DENIED);
      expect(await aiDraft(dataApi('K'), 'K', 'A')).toBe(DENIED);
      expect(await event(dataApi('A'), 'A', 'K', 'A')).toBe(DENIED);
    });
  });
});
