/**
 * RLSLIVE3b (RLSINV M01-M05, Y02): money rows are written by the server only.
 * At the row layer people read their own purchases, refunds, Stripe mirrors,
 * packages, AI cost rows (coach only) and contract envelopes, and write none
 * of them; a coach writes envelopes only for a client they coach now.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * (role authenticated, which does not bypass row security):
 *   backend(k)  app.current_user_id/_role and JWT sub set (the backend model)
 *   dataApi(k)  JWT sub only, no app GUC (the Supabase Data API model)
 * A is a client who moved from coach F to coach K; C is coach L's client. Every
 * id differs from its supabase id (RLSINV Y04). saleF, its refund and envF are
 * F-era rows. The suite runs down.sql (the production text today, exactly),
 * then migration.sql, which must give the state the replayed chain gave. Every
 * write runs in a transaction that is rolled back, so no attempt changes a
 * row; every 0 or 42501 follows a control of 1 on the same row or table.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('money-write-lock-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502000300_money_rows_are_server_written');
// A migration file's statements; BEGIN/COMMIT become the one transaction below.
const statements = (file: string) =>
  readFileSync(join(DIR, file), 'utf8').replace(/^--.*$/gm, '').split(/;\s*$/m)
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

const TABLES = ['AICallLog', 'ChargeRefund', 'ClientPurchase', 'CoachPackage', 'CoachSubscription',
  'ConnectAccount', 'ConnectCustomer', 'ContractEnvelope'];
// The production text of every policy this migration touches (catalog of 2026-10-13,
// whose dump folds the deparser's line breaks into single spaces, as flat() does).
const flat = (sql: string | null) => sql && sql.replace(/\s+/g, ' ');
const REFUND = '(app.is_owner() OR (EXISTS ( SELECT 1 FROM "ClientPurchase" cp WHERE ((cp.id = "ChargeRefund".purchase_id) AND ((cp.client_user_id = app.current_user_id()) OR (cp.coach_user_id = app.current_user_id()))))))';
const ENVELOPE = '(app.is_owner() OR ((app.current_user_id() IS NOT NULL) AND (coach_id = app.current_user_id())))';
const AI = '((app.current_user_id() IS NOT NULL) AND (("coachId" = app.current_user_id()) OR ("clientId" = app.current_user_id())))';
const PARTY = '((client_user_id = app.current_user_id()) OR (coach_user_id = app.current_user_id()))';
const own = (col: string) => `(${col} = app.current_user_id())`;
const OLD: Record<string, [string, string | null, string | null, string | null]> = { // cmd, USING, CHECK, comment
  'ClientPurchase.client_purchase_client_or_coach_access': ['ALL', PARTY, PARTY, null],
  'ClientPurchase.client_purchase_insert': ['INSERT', null, '((app.current_user_id() IS NOT NULL) AND (coach_user_id = app.current_user_id()))', null],
  'ChargeRefund.p_chargerefund_insert': ['INSERT', null, REFUND,
    'A party to the purchase (coach-initiated refund) or an owner may record a refund; service role covers webhook rows.'],
  'ChargeRefund.p_chargerefund_update': ['UPDATE', REFUND, REFUND,
    'A party to the purchase or an owner may amend a refund row; service role covers webhook updates.'],
  'ChargeRefund.p_chargerefund_delete': ['DELETE', REFUND, null,
    'Only a party to the purchase, an owner, or service role may delete a refund record.'],
  'ConnectCustomer.connect_customer_client_owner_access': ['ALL', own('client_user_id'), own('client_user_id'), null],
  'ConnectAccount.connect_account_coach_owner_access': ['ALL', own('coach_user_id'), own('coach_user_id'), null],
  'CoachSubscription.coach_subscription_owner_access': ['ALL', own('coach_id'), own('coach_id'), null],
  'CoachPackage.coach_package_coach_all': ['ALL', '((app.current_user_id() IS NOT NULL) AND (coach_id = app.current_user_id()))', null, null],
  'CoachPackage.coach_package_owner_access': ['ALL', own('coach_id'), own('coach_id'), null],
  'AICallLog.ai_call_log_participant_insert': ['INSERT', null, AI, null],
  'AICallLog.ai_call_log_participant_select': ['SELECT', AI, null, null],
  'ContractEnvelope.p_contractenvelope_insert': ['INSERT', null, ENVELOPE,
    'Write: only owner or the owning coach (coach_id = self) may INSERT an envelope. Clients never create envelopes directly; sub-coaches get SELECT only.'],
  'ContractEnvelope.p_contractenvelope_update': ['UPDATE', ENVELOPE, ENVELOPE,
    'Update: owner or owning coach (coach_id) may UPDATE; CHECK prevents re-owning to another coach_id. Status advances from provider events run as service_role.'],
};
const KEPT = ['AICallLog.ai_call_log_participant_select', 'ContractEnvelope.p_contractenvelope_insert', 'ContractEnvelope.p_contractenvelope_update'];
const ADDED = ['CoachPackage.coach_package_coach_select', 'CoachSubscription.coach_subscription_owner_select'];

type Key = 'A' | 'C' | 'F' | 'K' | 'L';
type Who = { key: Key; guc: boolean };
const backend = (key: Key): Who => ({ key, guc: true });
const dataApi = (key: Key): Who => ({ key, guc: false });
const ROLE: Record<Key, string> = { A: 'student', C: 'student', F: 'coach', K: 'coach', L: 'coach' };
const DENIED = '42501';
class Rollback extends Error { constructor(readonly n: number) { super('rollback'); } }

(DB_URL ? describe : describe.skip)('money rows are written by the server only', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys: Key[] = ['F', 'K', 'L', 'A', 'C']; // clients last: they reference their coach
  const id = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const r = Object.fromEntries(['pkgF', 'pkgK', 'saleF', 'saleK', 'refundF', 'custA', 'acctK', 'subK', 'logK',
    'tplF', 'tplK', 'envF', 'envK'].map((k) => [k, randomUUID()])) as Record<string, string>;

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
  // Rows written (or the SQLSTATE of the refusal); always rolled back.
  const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      await as(who, async (tx) => { throw new Rollback(await tx.$executeRawUnsafe(sql, ...params)); });
    } catch (e) {
      if (e instanceof Rollback) return e.n;
      const err = e as { code?: string; meta?: { code?: string } };
      return String(err.code === 'P2010' ? err.meta?.code : err.code);
    }
    throw new Error('unreachable');
  };
  const reads = (who: Who, table: string, rowId: string) =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS "n" FROM "${table}" WHERE "id" = $1`, rowId))
      .then((x) => x[0].n);
  const update = (who: Who, table: string, rowId: string, set = `"updated_at" = now()`) =>
    write(who, `UPDATE "${table}" SET ${set} WHERE "id" = $1`, rowId);
  const remove = (who: Who, table: string, rowId: string) => write(who, `DELETE FROM "${table}" WHERE "id" = $1`, rowId);
  const insert = {
    sale: (who: Who, coach: Key) => write(who, `INSERT INTO "ClientPurchase" ("id", "client_user_id", "coach_user_id",
      "package_id", "amount_cents", "stripe_checkout_session_id", "idempotency_key", "updated_at")
      VALUES ($1, $2, $3, $4, 1000, $5, $6, now())`, randomUUID(), id.A, id[coach], r.pkgK, `cs_${randomUUID()}`, randomUUID()),
    refund: (who: Who) => write(who, `INSERT INTO "ChargeRefund" ("id", "purchase_id", "stripe_refund_id", "stripe_charge_id",
      "amount_cents", "updated_at") VALUES ($1, $2, $3, 'ch_rls', 500, now())`, randomUUID(), r.saleK, `re_${randomUUID()}`),
    customer: (who: Who) => write(who, `INSERT INTO "ConnectCustomer" ("id", "client_user_id", "stripe_customer_id", "updated_at")
      VALUES ($1, $2, $3, now())`, randomUUID(), id[who.key], `cus_${randomUUID()}`),
    account: (who: Who) => write(who, `INSERT INTO "ConnectAccount" ("id", "coach_user_id", "stripe_account_id", "updated_at")
      VALUES ($1, $2, $3, now())`, randomUUID(), id[who.key], `acct_${randomUUID()}`),
    subscription: (who: Who) => write(who, `INSERT INTO "CoachSubscription" ("id", "coach_id", "updated_at")
      VALUES ($1, $2, now())`, randomUUID(), id[who.key]),
    pkg: (who: Who) => write(who, `INSERT INTO "CoachPackage" ("id", "coach_id", "name", "amount_cents", "updated_at")
      VALUES ($1, $2, 'RLS plan', 1000, now())`, randomUUID(), id[who.key]),
    aiCall: (who: Who, coach: Key) => write(who, `INSERT INTO "AICallLog" ("id", "model", "tokensIn", "tokensOut", "costCents",
      "latencyMs", "success", "coachId", "clientId", "capability") VALUES ($1, 'rls', 1, 1, 1, 1, true, $2, $3, 'rls')`,
      randomUUID(), id[coach], id[who.key]),
    envelope: (who: Who, coach: Key, client: Key) => write(who, `INSERT INTO "ContractEnvelope" ("id", "template_id",
      "template_version", "client_id", "coach_id") VALUES ($1, $2, 1, $3, $4)`, randomUUID(), r.tplK, id[client], id[coach]),
  };
  const policies = () => prisma.$queryRaw<{ name: string; cmd: string; roles: string; qual: string | null; check: string | null; comment: string | null }[]>`
    SELECT p."tablename" || '.' || p."policyname" AS "name", p."cmd", p."roles"::text AS "roles", p."qual",
           p."with_check" AS "check", obj_description(pp."oid", 'pg_policy') AS "comment"
    FROM pg_policies p JOIN pg_policy pp ON pp."polname" = p."policyname" AND pp."polrelid" = format('public.%I', p."tablename")::regclass
    WHERE p."schemaname" = 'public' AND p."tablename"::text = ANY(${TABLES}::text[]) ORDER BY 1`
    .then((list) => list.map((p) => ({ ...p, qual: flat(p.qual), check: flat(p.check) })));
  let chain: Awaited<ReturnType<typeof policies>> = [];

  beforeAll(async () => {
    // BILLRAW (20270502003500) took every right on five of these tables from the API roles. Give authenticated
    // back what it held before, so this suite keeps proving the row rules underneath (billing-rows-server-only-rls).
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "ChargeRefund", "ClientPurchase",
      "CoachSubscription", "ConnectAccount", "ConnectCustomer" TO authenticated`);
    for (const k of keys) {
      const coach = k === 'A' ? id.F : k === 'C' ? id.L : null;
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`money-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${coach})`;
    }
    for (const [pkg, coach] of [[r.pkgF, id.F], [r.pkgK, id.K]]) {
      await prisma.coachPackage.create({ data: { id: pkg, coach_id: coach, name: 'RLS plan', amount_cents: 1000 } });
    }
    for (const [sale, coach, pkg] of [[r.saleF, id.F, r.pkgF], [r.saleK, id.K, r.pkgK]]) {
      await prisma.clientPurchase.create({ data: { id: sale, client_user_id: id.A, coach_user_id: coach, package_id: pkg,
        amount_cents: 1000, stripe_checkout_session_id: `cs_${randomUUID()}`, idempotency_key: randomUUID() } });
    }
    await prisma.chargeRefund.create({ data: { id: r.refundF, purchase_id: r.saleF, stripe_refund_id: `re_${randomUUID()}`,
      stripe_charge_id: 'ch_rls', amount_cents: 500 } });
    await prisma.connectCustomer.create({ data: { id: r.custA, client_user_id: id.A, stripe_customer_id: `cus_${randomUUID()}` } });
    await prisma.connectAccount.create({ data: { id: r.acctK, coach_user_id: id.K, stripe_account_id: `acct_${randomUUID()}` } });
    await prisma.coachSubscription.create({ data: { id: r.subK, coach_id: id.K } });
    await prisma.aICallLog.create({ data: { id: r.logK, model: 'rls', tokensIn: 1, tokensOut: 1, costCents: 1, latencyMs: 1,
      success: true, coachId: id.K, clientId: id.A, capability: 'rls' } });
    for (const [tpl, env, coach] of [[r.tplF, r.envF, id.F], [r.tplK, r.envK, id.K]]) {
      await prisma.contractTemplate.create({ data: { id: tpl, coach_id: coach, name: 'RLS terms', body_markdown: 'RLS', dynamic_fields_json: {} } });
      await prisma.contractEnvelope.create({ data: { id: env, template_id: tpl, template_version: 1, client_id: id.A, coach_id: coach } });
    }
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.K} WHERE "id" = ${id.A}`; // A moves F -> K
    chain = await policies();
  });
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(backend('A'), (tx) => tx.$queryRaw<{ b: boolean }[]>`
      SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
  });

  it('every *_server_only policy is permissive USING false (a no-op this PR keeps), none restrictive', async () => {
    const list = await prisma.$queryRaw<{ name: string; permissive: string; qual: string }[]>`
      SELECT "tablename" || '.' || "policyname" AS "name", "permissive", "qual" FROM pg_policies
      WHERE "schemaname" = 'public' AND right("policyname", 12) = '_server_only' ORDER BY 1`;
    expect(list.map((p) => p.name)).toEqual(expect.arrayContaining(
      ['ClientPurchase.ClientPurchase_server_only', 'CoachPackage.CoachPackage_server_only', 'ConnectCustomer.ConnectCustomer_server_only']));
    for (const p of list) expect([p.permissive, p.qual]).toEqual(['PERMISSIVE', 'false']);
  });

  describe('under down.sql (the production text today)', () => {
    beforeAll(() => apply('down.sql'));
    afterAll(() => apply('migration.sql'));

    it('restores every touched policy exactly and leaves the others as the chain had them', async () => {
      const now = await policies();
      for (const [name, [cmd, qual, check, comment]] of Object.entries(OLD)) {
        expect(now.find((p) => p.name === name)).toEqual({ name, cmd, roles: '{public}', qual, check, comment });
      }
      const untouched = (list: typeof now) => list.filter((p) => !(p.name in OLD) && !ADDED.includes(p.name));
      expect(untouched(now)).toEqual(untouched(chain));
      expect(now.filter((p) => ADDED.includes(p.name))).toEqual([]);
      expect(chain.filter((p) => p.name in OLD).map((p) => p.name)).toEqual(KEPT);
    });

    it('the holes: clients and coaches write their money rows; a coach writes envelopes for any client', async () => {
      expect(await update(backend('A'), 'ClientPurchase', r.saleK, `"status" = 'paid'`)).toBe(1);
      expect(await update(backend('F'), 'ChargeRefund', r.refundF, `"status" = 'failed'`)).toBe(1);
      expect(await update(backend('A'), 'ConnectCustomer', r.custA)).toBe(1);
      expect(await update(backend('K'), 'ConnectAccount', r.acctK, `"charges_enabled" = true`)).toBe(1);
      expect(await update(backend('K'), 'CoachSubscription', r.subK, `"status" = 'active'`)).toBe(1);
      expect(await update(backend('K'), 'CoachPackage', r.pkgK, `"amount_cents" = 1`)).toBe(1);
      expect(await insert.aiCall(backend('A'), 'L')).toBe(1);
      expect(await reads(backend('A'), 'AICallLog', r.logK)).toBe(1);
      expect(await insert.envelope(backend('K'), 'K', 'C')).toBe(1);
      expect(await update(backend('F'), 'ContractEnvelope', r.envF, `"status" = 'SENT'`)).toBe(1);
    });
  });

  describe('after the migration', () => {
    it('gives exactly the state the replayed chain gave', async () => {
      expect(await policies()).toEqual(chain);
    });

    it('purchases: the client and the seller coach read their own and write nothing', async () => {
      for (const [k, sale] of [['A', r.saleK], ['K', r.saleK], ['F', r.saleF]] as [Key, string][]) {
        expect(await reads(backend(k), 'ClientPurchase', sale)).toBe(1);
        expect(await update(backend(k), 'ClientPurchase', sale, `"status" = 'paid'`)).toBe(0);
        expect(await remove(backend(k), 'ClientPurchase', sale)).toBe(0);
        expect(await reads(backend(k), 'ClientPurchase', sale)).toBe(1);
      }
      expect(await insert.sale(backend('A'), 'K')).toBe(DENIED);
      expect(await insert.sale(backend('K'), 'K')).toBe(DENIED);
      expect(await reads(backend('K'), 'ClientPurchase', r.saleF)).toBe(0); // the new coach never sees F's sale
      expect(await reads(backend('L'), 'ClientPurchase', r.saleK)).toBe(0);
    });

    it("refunds: the client and the former coach read the refund on F's sale and write none", async () => {
      expect(await reads(backend('F'), 'ClientPurchase', r.saleF)).toBe(1);
      for (const k of ['F', 'A'] as Key[]) {
        expect(await reads(backend(k), 'ChargeRefund', r.refundF)).toBe(1);
        expect(await update(backend(k), 'ChargeRefund', r.refundF, `"status" = 'failed'`)).toBe(0);
        expect(await remove(backend(k), 'ChargeRefund', r.refundF)).toBe(0);
      }
      expect(await reads(backend('K'), 'ChargeRefund', r.refundF)).toBe(0);
      for (const k of ['A', 'K'] as Key[]) expect(await insert.refund(backend(k))).toBe(DENIED);
    });

    it('Stripe mirrors, subscription and packages: their subject reads the row and writes nothing', async () => {
      const cases: [Key, string, string, string, () => Promise<number | string>][] = [
        ['A', 'ConnectCustomer', r.custA, `"default_card_last4" = '0000'`, () => insert.customer(backend('A'))],
        ['K', 'ConnectAccount', r.acctK, `"charges_enabled" = true`, () => insert.account(backend('K'))],
        ['K', 'CoachSubscription', r.subK, `"status" = 'active'`, () => insert.subscription(backend('K'))],
        ['K', 'CoachPackage', r.pkgK, `"amount_cents" = 1`, () => insert.pkg(backend('K'))],
      ];
      for (const [k, table, rowId, set, add] of cases) {
        expect(await reads(backend(k), table, rowId)).toBe(1);
        expect(await update(backend(k), table, rowId, set)).toBe(0);
        expect(await remove(backend(k), table, rowId)).toBe(0);
        expect(await add()).toBe(DENIED);
        expect(await reads(backend(k), table, rowId)).toBe(1);
      }
      expect(await reads(backend('F'), 'CoachPackage', r.pkgF)).toBe(1);
      expect(await reads(backend('L'), 'CoachPackage', r.pkgK)).toBe(0);
    });

    it("AI cost rows: the coach reads them; nobody inserts one; the client reads none of the coach's cost", async () => {
      expect(await reads(backend('K'), 'AICallLog', r.logK)).toBe(1);
      expect(await reads(backend('A'), 'AICallLog', r.logK)).toBe(0);
      expect(await insert.aiCall(backend('A'), 'L')).toBe(DENIED);
      expect(await insert.aiCall(backend('A'), 'K')).toBe(DENIED);
      expect(await insert.aiCall(backend('K'), 'K')).toBe(DENIED);
    });

    it('envelopes: only the current coach writes one, and only for their own client', async () => {
      expect(await insert.envelope(backend('K'), 'K', 'A')).toBe(1);
      expect(await insert.envelope(backend('K'), 'K', 'C')).toBe(DENIED);
      expect(await insert.envelope(backend('F'), 'F', 'A')).toBe(DENIED);
      expect(await insert.envelope(backend('A'), 'K', 'A')).toBe(DENIED);
      expect(await update(backend('K'), 'ContractEnvelope', r.envK, `"status" = 'SENT'`)).toBe(1);
      expect(await reads(backend('F'), 'ContractEnvelope', r.envF)).toBe(1); // F keeps reading the signed record
      expect(await update(backend('F'), 'ContractEnvelope', r.envF, `"status" = 'SENT'`)).toBe(0);
      expect(await update(backend('K'), 'ContractEnvelope', r.envK, `"client_id" = '${id.C}'`)).toBe(DENIED);
      expect(await reads(backend('A'), 'ContractEnvelope', r.envF)).toBe(1);
    });

    it('the Data API model (JWT, no GUC) reads nothing on any of the eight tables', async () => {
      const rows: [Key, string, string][] = [['A', 'ClientPurchase', r.saleK], ['A', 'ChargeRefund', r.refundF],
        ['A', 'ConnectCustomer', r.custA], ['K', 'ConnectAccount', r.acctK], ['K', 'CoachSubscription', r.subK],
        ['K', 'CoachPackage', r.pkgK], ['K', 'AICallLog', r.logK], ['A', 'ContractEnvelope', r.envK]];
      for (const [k, table, rowId] of rows) {
        expect(await reads(backend(k), table, rowId)).toBe(1);
        expect(await reads(dataApi(k), table, rowId)).toBe(0);
      }
    });
  });
});
