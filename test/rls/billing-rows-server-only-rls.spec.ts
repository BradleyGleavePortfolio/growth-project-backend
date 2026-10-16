/**
 * BILLRAW (OWN-PR-B1 of the b#988 review; owner "RLS for everything!", "Billing
 * works robustly"): billing rows are server-only (20270502003500). Before it,
 * the row rules let a signed-in party (role authenticated with
 * app.current_user_id set) read raw billing rows: a coach, the coach a client
 * left too, read the client's pending payment secrets, access, card and trial
 * state. Now anon and authenticated hold no right on any of the 20 tables; the
 * server reads them through its own allow-listed projections.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. Principals
 * use role authenticated (which does not bypass row security) with the app
 * GUCs and JWT sub set: A is a client who moved from coach F to coach K, L is
 * a coach with no tie to A; plus anon and A with the JWT only (the Data API
 * model). saleF and saleK are A's pending purchases from F and K, holding
 * synthetic secrets. The suite runs down.sql (the old grants, exactly) and
 * shows the hole, then migration.sql, which must give the chain's state again.
 * Every 0 or 42501 follows a control of 1 on the same row read as the server,
 * and a read of 1 of the caller's own "User" row in the same transaction.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('billing-rows-server-only-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const DIR = join(__dirname, '..', '..', 'prisma', 'migrations', '20270502003500_billing_rows_server_only');
const text = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/^\s*--.*$/gm, '');
// A migration file's statements (a DO $$ ... $$ block stays whole); BEGIN/COMMIT become one transaction here.
const statements = (file: string) =>
  text(file).split(/;\s*$/m)
    .reduce<string[]>((out, s) => {
      const open = out.length > 0 && (out[out.length - 1].match(/\$\$/g) ?? []).length % 2 === 1;
      if (open) out[out.length - 1] += `;${s}`;
      else out.push(s);
      return out;
    }, [])
    .map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

type Key = 'A' | 'F' | 'K' | 'L';
const ROLE: Record<Key, string> = { A: 'student', F: 'coach', K: 'coach', L: 'coach' };
const KEYS: Key[] = ['F', 'K', 'L', 'A']; // the client last: it references its coach
// The path list (PR body): each billing table, its seeded row and the parties its row rule admitted.
const PATHS: [table: string, row: string, readers: Key[]][] = [
  ['ClientPurchase', 'saleF', ['A', 'F']], ['ClientPurchase', 'saleK', ['A', 'K']],
  ['ChargeRefund', 'refund', ['A', 'F']], ['ChargeDispute', 'dispute', ['A', 'F']],
  ['PartialRefundDecision', 'decision', ['F']], ['ReconciliationSnapshot', 'recon', ['A', 'F']],
  ['ChargeSettlement', 'settlement', ['F']], ['SplitLedgerEntry', 'split', ['F']],
  ['ConnectTransfer', 'transfer', ['F']], ['PayoutAdjustmentNotice', 'notice', ['F']],
  ['PayeeRecovery', 'recovery', ['F']], ['PayoutSnapshot', 'payout', ['F']], ['ConnectAccount', 'account', ['F']],
  ['ConnectCustomer', 'customer', ['A']], ['Invoice', 'invoice', ['K']], ['CoachSubscription', 'subscription', ['K']],
  ['PaymentFailure', 'failure', ['K']], ['CoachCreditPackPurchase', 'pack', ['K']],
  ['PackageTrialUsage', 'trialUse', ['A']], ['PackageTrialNotice', 'trialNotice', ['A']],
  ['coach_first_payment_notification', 'firstPay', ['K']],
];
const TABLES = [...new Set(PATHS.map(([t]) => t))];
const target = (t: string) => `public.${/^[a-z_][a-z0-9_]*$/.test(t) ? t : `"${t}"`}`;
const DENIED = '42501';
type Who = { key: Key | null; role: 'authenticated' | 'anon'; guc: boolean };
const party = (key: Key): Who => ({ key, role: 'authenticated', guc: true });
const CALLERS: [string, Who][] = [...(['A', 'K', 'F', 'L'] as Key[]).map((k): [string, Who] => [k, party(k)]),
  ['A, JWT only', { key: 'A', role: 'authenticated', guc: false }], ['anon', { key: null, role: 'anon', guc: false }]];
type Grant = { target: string; col: string; grantee: string; privilege: string; grantable: boolean };
// Sorted here: the catalog's names sort in collation "C", the backup's text columns in the database default.
const sorted = (list: Grant[]) => list.map((g) => [[g.target, g.col, g.grantee, g.privilege].join(' '), g] as const)
  .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, g]) => g);
class Rollback extends Error { constructor(readonly value: unknown) { super('rollback'); } }

(DB_URL ? describe : describe.skip)('billing rows are server-only', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const id = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(KEYS.map((k) => [k, randomUUID()])) as Record<Key, string>;
  const r = Object.fromEntries([...PATHS.map(([, row]) => row), 'pkgF', 'pkgK', 'budget']
    .map((k) => [k, randomUUID()])) as Record<string, string>;
  const run = randomUUID().slice(0, 8);
  const SECRET = { saleF: `pi_rls_${run}_F_secret_synthetic`, saleK: `pi_rls_${run}_K_secret_synthetic` };
  const now = new Date();

  const apply = (file: string) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const s of statements(file)) await tx.$executeRawUnsafe(s);
    }, { timeout: 30_000 });
  const insert = (table: string, data: Record<string, unknown>) =>
    prisma.$executeRawUnsafe(`INSERT INTO ${target(table)} (${Object.keys(data).map((c) => `"${c}"`).join(', ')})
      VALUES (${Object.keys(data).map((_, i) => `$${i + 1}`).join(', ')})`, ...Object.values(data));
  // Every grant anon, authenticated or PUBLIC holds on the listed tables, as the migration records them.
  const grants = () => prisma.$queryRaw<Grant[]>`
    SELECT format('public.%I', c.relname) AS "target", x.col, CASE WHEN a.grantee = 0::oid THEN 'PUBLIC'
           ELSE a.grantee::regrole::text END AS "grantee", a.privilege_type AS "privilege", bool_or(a.is_grantable) AS "grantable"
      FROM pg_class c
     CROSS JOIN LATERAL (SELECT '' AS col, c.relacl AS acl UNION ALL SELECT quote_ident(att.attname), att.attacl
                           FROM pg_attribute att WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped) x
     CROSS JOIN LATERAL aclexplode(x.acl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}::text[])
       AND a.grantee IN (0::oid, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
     GROUP BY 1, 2, 3, 4`.then(sorted);
  const backup = () => prisma.$queryRaw<Grant[]>`SELECT * FROM app.billing_api_grant_backup`.then(sorted);
  /** Rows of `rowId` read as the server (the superuser connection): the control. */
  const server = (table: string, rowId: string) =>
    prisma.$queryRawUnsafe<unknown[]>(`SELECT "id" FROM ${target(table)} WHERE "id" = $1`, rowId).then((x) => x.length);
  /** In one rolled-back transaction as `who`: their own "User" row (the control), then the rows of `sql` or its SQLSTATE. */
  const probe = async (who: Who, sql: string, ...params: unknown[]): Promise<{ self: number | null; out: number | string }> => {
    let self: number | null = null;
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who.role}`);
        await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
          JSON.stringify(who.key ? { sub: sub[who.key], role: who.role } : { role: who.role }));
        if (who.key && who.guc) {
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
          self = (await tx.$queryRawUnsafe<unknown[]>(`SELECT "id" FROM "User" WHERE "id" = $1`, id[who.key])).length;
        }
        throw new Rollback((await tx.$queryRawUnsafe<unknown[]>(sql, ...params)).length);
      });
    } catch (e) {
      if (e instanceof Rollback) return { self, out: e.value as number };
      const err = e as { code?: string; meta?: { code?: string } };
      if (err.code === 'P2010') return { self, out: String(err.meta?.code) };
      throw e;
    }
    throw new Error('unreachable');
  };
  const readRow = (who: Who, table: string, rowId: string) =>
    probe(who, `SELECT "id" FROM ${target(table)} WHERE "id" = $1`, rowId);
  const secret = (who: Who, sale: 'saleF' | 'saleK') => probe(who, `SELECT "stripe_client_secret" FROM "ClientPurchase"
    WHERE "id" = $1 AND "stripe_client_secret" = $2 AND "stripe_ephemeral_key" IS NOT NULL`, r[sale], SECRET[sale]);
  const ownRow = (who: Who) => (who.key && who.guc ? 1 : null);
  let chain: Grant[] = [];
  let recorded: Grant[] = [];

  beforeAll(async () => {
    for (const k of KEYS) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`billraw-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${k === 'A' ? id.F : null})`;
    }
    for (const [pkg, coach] of [[r.pkgF, id.F], [r.pkgK, id.K]]) {
      await prisma.coachPackage.create({ data: { id: pkg, coach_id: coach, name: 'RLS plan', amount_cents: 1000 } });
    }
    for (const [sale, coach, pkg] of [['saleF', id.F, r.pkgF], ['saleK', id.K, r.pkgK]] as const) {
      await insert('ClientPurchase', { id: r[sale], client_user_id: id.A, coach_user_id: coach, package_id: pkg,
        amount_cents: 1000, billing_type: 'recurring', status: 'pending', entitlement_active: false, trial_days: 7,
        trial_ends_at: now, stripe_checkout_session_id: `cs_${randomUUID()}`, idempotency_key: randomUUID(),
        stripe_client_secret: SECRET[sale], stripe_ephemeral_key: `ek_rls_${run}_synthetic`, updated_at: now });
    }
    const charge = `ch_${randomUUID()}`;
    const on = { purchase_id: r.saleF, updated_at: now };
    await insert('ChargeRefund', { id: r.refund, ...on, stripe_refund_id: `re_${randomUUID()}`, stripe_charge_id: charge, amount_cents: 500 });
    await insert('ChargeDispute', { id: r.dispute, ...on, stripe_dispute_id: `dp_${randomUUID()}`, stripe_charge_id: charge, amount_cents: 500 });
    await insert('PartialRefundDecision', { id: r.decision, client_purchase_id: r.saleF, stripe_refund_id: `re_${randomUUID()}` });
    await insert('ReconciliationSnapshot', { id: r.recon, ...on });
    await insert('ChargeSettlement', { id: r.settlement, ...on, coach_user_id: id.F, head_coach_user_id: null,
      stripe_charge_id: charge, platform_bps: 200, gross_cents: 1000 });
    await insert('SplitLedgerEntry', { id: r.split, ...on, payee_user_id: id.F, kind: 'destination', amount_cents: 100,
      idempotency_key: randomUUID(), stripe_charge_id: charge });
    await insert('ConnectTransfer', { id: r.transfer, ...on, settlement_id: r.settlement, destination_user_id: id.F,
      destination_stripe_account_id: `acct_${randomUUID()}`, amount_cents: 100, idempotency_key: randomUUID() });
    await insert('PayoutAdjustmentNotice', { id: r.notice, ...on, settlement_id: r.settlement, payee_user_id: id.F, role: 'coach',
      stripe_charge_id: charge, event: 'refund', charge_gross_cents: 1000, customer_refunded_cents: 100, reversed_cents: 100,
      held_cents: 0, held_tgp_fee_cents: 0, held_stripe_fee_cents: 0, held_dispute_fee_cents: 0, held_not_reversed_cents: 0,
      held_open_cents: 0, state_key: randomUUID(), idempotency_key: randomUUID(), title: 'RLS', body: 'RLS' });
    await insert('PayeeRecovery', { id: r.recovery, settlement_id: r.settlement, payee_user_id: id.F, amount_cents: 100,
      reason: 'refund', idempotency_key: randomUUID(), updated_at: now });
    await insert('PayoutSnapshot', { id: r.payout, coach_user_id: id.F, stripe_account_id: `acct_${randomUUID()}`, updated_at: now });
    await insert('ConnectAccount', { id: r.account, coach_user_id: id.F, stripe_account_id: `acct_${randomUUID()}`, updated_at: now });
    await insert('ConnectCustomer', { id: r.customer, client_user_id: id.A, stripe_customer_id: `cus_${randomUUID()}`,
      default_card_last4: '0000', updated_at: now });
    await insert('Invoice', { id: r.invoice, coach_id: id.K, stripe_invoice_id: `in_${randomUUID()}` });
    await insert('CoachSubscription', { id: r.subscription, coach_id: id.K, updated_at: now });
    await insert('PaymentFailure', { id: r.failure, coach_id: id.K });
    await insert('CoachAIBudget', { id: r.budget, coach_user_id: id.K, period_start: now,
      period_end: new Date(now.getTime() + 864e5), updated_at: now });
    await insert('CoachCreditPackPurchase', { id: r.pack, coach_user_id: id.K, budget_id: r.budget, paid_cents: 1000,
      actual_credit_cents: 1000, displayed_credit_cents: 1000, status: 'paid', updated_at: now });
    await insert('PackageTrialUsage', { id: r.trialUse, client_user_id: id.A, coach_user_id: id.K, package_id: r.pkgK,
      purchase_id: r.saleK, trial_days: 7, updated_at: now });
    await insert('PackageTrialNotice', { id: r.trialNotice, purchase_id: r.saleK, client_user_id: id.A, trial_ends_at: now,
      amount_cents: 1000, currency: 'usd', updated_at: now });
    await insert('coach_first_payment_notification', { id: r.firstPay, coachId: id.K, amount: 1000, currency: 'usd', clientId: id.A });
    await prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${id.K} WHERE "id" = ${id.A}`; // A moves F -> K
    chain = await grants();
    recorded = await backup();
  }, 60_000);
  afterAll(() => prisma.$disconnect());

  it('runs as a role that does not bypass row security', async () => {
    expect(await probe(party('F'), `SELECT 1 FROM pg_roles WHERE "rolname" = current_user AND NOT "rolbypassrls" AND NOT "rolsuper"`))
      .toEqual({ self: 1, out: 1 });
  });

  it('the path list is the migration\'s list: 20 billing tables, RLS on and forced, one seeded row each', async () => {
    const listed = /names text\[\] := ARRAY\[([^\]]+)\]/.exec(text('migration.sql'))![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1));
    expect(listed).toEqual(TABLES);
    expect(TABLES).toHaveLength(20);
    const forced = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${TABLES}::text[]) AND relrowsecurity AND relforcerowsecurity`;
    expect(forced).toEqual([{ n: 20 }]);
    for (const [table, row] of PATHS) expect(await server(table, r[row])).toBe(1);
  });

  describe('under down.sql (the old grants, exactly)', () => {
    beforeAll(() => apply('down.sql'), 30_000);
    afterAll(() => apply('migration.sql'), 30_000);

    it('restores every recorded grant and nothing else; authenticated read every table', async () => {
      expect(recorded.length).toBeGreaterThan(0);
      expect(await grants()).toEqual(recorded);
      for (const t of TABLES) {
        expect(recorded).toContainEqual(expect.objectContaining({ target: target(t), col: '', grantee: 'authenticated', privilege: 'SELECT' }));
      }
    });

    it('the hole: the coach the client left reads their pending payment secret', async () => {
      expect(await server('ClientPurchase', r.saleF)).toBe(1);
      expect(await secret(party('F'), 'saleF')).toEqual({ self: 1, out: 1 });
      expect(await secret(party('A'), 'saleF')).toEqual({ self: 1, out: 1 });
      expect(await secret(party('K'), 'saleK')).toEqual({ self: 1, out: 1 });
      expect(await secret(party('K'), 'saleF')).toEqual({ self: 1, out: 0 });
      expect(await secret(party('L'), 'saleF')).toEqual({ self: 1, out: 0 });
    });

    it.each(PATHS)('%s (%s): the parties its row rule names read it, nobody else', async (table, row, readers) => {
      for (const k of ['A', 'K', 'F', 'L'] as Key[]) {
        expect(await server(table, r[row])).toBe(1);
        expect(await readRow(party(k), table, r[row])).toEqual({ self: 1, out: readers.includes(k) ? 1 : 0 });
      }
    }, 30_000);
  });

  describe('after the migration', () => {
    it('gives the chain\'s state again: no API grant on any listed table, the same backup', async () => {
      expect(await grants()).toEqual(chain);
      expect(chain).toEqual([]);
      expect(await backup()).toEqual(recorded);
      const left = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM unnest(${TABLES}::text[]) t,
        unnest(ARRAY['anon', 'authenticated']) g
        WHERE has_table_privilege(g, format('public.%I', t), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           OR has_any_column_privilege(g, format('public.%I', t), 'SELECT, INSERT, UPDATE, REFERENCES')`;
      expect(left).toEqual([{ n: 0 }]);
      const kept = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM unnest(${TABLES}::text[]) t
        WHERE has_table_privilege('service_role', format('public.%I', t), 'SELECT')`;
      expect(kept).toEqual([{ n: 20 }]);
    });

    it('nobody signed in reads a pending payment secret; the server role still does', async () => {
      for (const [, who] of CALLERS) {
        expect(await server('ClientPurchase', r.saleF)).toBe(1);
        expect(await secret(who, 'saleF')).toEqual({ self: ownRow(who), out: DENIED });
      }
      const asServer = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
        return tx.$queryRawUnsafe<unknown[]>(`SELECT "stripe_client_secret" FROM "ClientPurchase" WHERE "id" = $1 AND
          "stripe_client_secret" = $2`, r.saleF, SECRET.saleF);
      });
      expect(asServer).toHaveLength(1);
    });

    it.each(PATHS)('%s (%s): every API caller is refused, reads and writes', async (table, row) => {
      for (const [, who] of CALLERS) {
        expect(await server(table, r[row])).toBe(1);
        expect(await readRow(who, table, r[row])).toEqual({ self: ownRow(who), out: DENIED });
        expect(await probe(who, `DELETE FROM ${target(table)} WHERE false`)).toEqual({ self: ownRow(who), out: DENIED });
      }
    }, 30_000);
  });
});
