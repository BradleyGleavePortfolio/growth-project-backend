/**
 * RLSPAY: live row-layer contract for every uncovered PAYREADY write table.
 * Reuses the money-write-lock suite's non-bypass SET LOCAL ROLE pattern.
 * CI discovers this file on its own copy of the fully replayed migration chain.
 * No policy changes: production grants are tested first, then temporary CRUD
 * grants (rolled back with the query) isolate RLS from missing table privileges.
 * JWT-only requests deliberately have no app identity; they must see nothing.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-payment-actions-rls: CI=true without TEST_DATABASE_URL; refusing to skip.');
}

const TABLES = [
  { table: 'ChargeSettlement', ownerAll: true },
  { table: 'PayoutAdjustmentNotice', ownerAll: true },
  { table: 'PayeeRecovery', ownerAll: true },
  { table: 'ConnectTransfer', ownerAll: true },
  { table: 'TransferReversalOp', ownerAll: true },
  { table: 'DunningState', ownerAll: false },
  { table: 'AuditLog', ownerAll: true },
  { table: 'SplitLedgerEntry', ownerAll: true },
  { table: 'GuestCheckout', ownerAll: false },
  { table: 'ScheduledDrop', ownerAll: false },
  { table: 'CronLease', ownerAll: true },
] as const;
type Table = typeof TABLES[number]['table'];
const ROLES = {
  coach: 'coach', otherCoach: 'coach', client: 'student', otherClient: 'student',
  subCoach: 'coach', headCoach: 'coach', owner: 'owner',
} as const;
type Key = keyof typeof ROLES;
type Who = { key: Key | null; sqlRole: 'authenticated' | 'anon'; jwtOnly: boolean };
type Data = Record<string, string | number | Date | null>;
type Row = { data: Data; readers: Key[] };
type Sql = { text: string; params: unknown[] };
const ACTORS: { label: string; key: Key | null; sqlRole: Who['sqlRole'] }[] = [
  ...Object.keys(ROLES).map((key) => ({
    label: key, key: key as Key, sqlRole: 'authenticated' as const,
  })),
  { label: 'anon', key: null, sqlRole: 'anon' },
  { label: 'authenticated without tenant', key: null, sqlRole: 'authenticated' },
];
const MODES = [
  { label: 'backend / production grants', jwtOnly: false, policyOnly: false },
  { label: 'backend / RLS alone', jwtOnly: false, policyOnly: true },
  { label: 'JWT only / production grants', jwtOnly: true, policyOnly: false },
  { label: 'JWT only / RLS alone', jwtOnly: true, policyOnly: true },
];
class Rollback extends Error {
  constructor(readonly value: unknown) { super('rollback'); }
}

(DB_URL ? describe : describe.skip)('coach payment action write tables: live RLS', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const keys = Object.keys(ROLES) as Key[];
  const id = Object.fromEntries(keys.map((key) => [key, randomUUID()])) as Record<Key, string>;
  const sub = Object.fromEntries(keys.map((key) => [key, randomUUID()])) as Record<Key, string>;
  const noTenantSub = randomUUID();
  const packages = [randomUUID(), randomUUID()];
  const purchases = [randomUUID(), randomUUID()];
  const sparePurchases = [randomUUID(), randomUUID()];
  const settlements = [randomUUID(), randomUUID()];
  const transfers = [randomUUID(), randomUUID()];
  const rows = new Map<Table, Row[]>();
  const now = new Date('2026-10-15T12:00:00Z');
  const primaryKey = (table: Table) => table === 'CronLease' ? 'name' : 'id';
  const rowId = (table: Table, row: Row) => String(row.data[primaryKey(table)]);
  const quote = (name: string) => `"${name}"`; // only constants / fixture column names
  const insert = (table: Table, row: Row): Sql => ({
    text: `INSERT INTO public.${quote(table)} (${Object.keys(row.data).map(quote).join(', ')})
      VALUES (${Object.keys(row.data).map((col, i) => `$${i + 1}${col === 'cadence_payload' ? '::jsonb' : ''}`).join(', ')})`,
    params: Object.values(row.data),
  });
  const read = (table: Table, row: Row): Sql => ({
    text: `SELECT ${quote(primaryKey(table))} AS id FROM public.${quote(table)} WHERE ${quote(primaryKey(table))} = $1`,
    params: [rowId(table, row)],
  });
  const mutation = (table: Table, row: Row, verb: 'UPDATE' | 'DELETE'): Sql => ({
    // Change actual money / state, not just a no-op timestamp.
    text: verb === 'DELETE'
      ? `DELETE FROM public.${quote(table)} WHERE ${quote(primaryKey(table))} = $1`
      : `UPDATE public.${quote(table)} SET ${table === 'AuditLog' ? '"action" = \'rls.changed\''
        : table === 'CronLease' ? '"holder" = \'rls.changed\''
        : table === 'ChargeSettlement' ? '"refunded_cents" = 100'
        : table === 'PayoutAdjustmentNotice' ? '"customer_refunded_cents" = 101'
        : ['PayeeRecovery', 'ConnectTransfer', 'SplitLedgerEntry', 'TransferReversalOp'].includes(table)
          ? '"amount_cents" = 101' : '"status" = \'refunded\''} WHERE ${quote(primaryKey(table))} = $1`,
    params: [rowId(table, row)],
  });

  // Every request, including a successful owner write or a temporary GRANT,
  // rolls back. Unknown errors fail loudly; only SQLSTATE 42501 is a denial.
  const run = async <T>(who: Who | null, grantTable: Table | null,
    query: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | '42501'> => {
    try {
      await prisma.$transaction(async (tx) => {
        if (who) {
          if (grantTable) {
            await tx.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${quote(grantTable)} TO ${who.sqlRole}`);
          }
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who.sqlRole}`);
          await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
            JSON.stringify({ role: who.sqlRole, ...(who.sqlRole === 'anon' ? {} : { sub: who.key ? sub[who.key] : noTenantSub }) }));
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`,
            who.key && !who.jwtOnly ? id[who.key] : '');
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`,
            who.key && !who.jwtOnly ? ROLES[who.key] : '');
        }
        throw new Rollback(await query(tx));
      });
    } catch (e) {
      if (e instanceof Rollback) return e.value as T;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010' && e.meta?.code === '42501') return '42501';
      throw e;
    }
    throw new Error('unreachable');
  };
  const select = (who: Who | null, grantTable: Table | null, sql: Sql) =>
    run(who, grantTable, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(sql.text, ...sql.params));
  const write = (who: Who | null, grantTable: Table | null, sql: Sql) =>
    run(who, grantTable, (tx) => tx.$executeRawUnsafe(sql.text, ...sql.params));

  // A and B have complete independent purchase/settlement/transfer paths.
  // Additional head-coach payee rows and a platform ledger row distinguish
  // "payee" from "seller", "client", "team member" and NULL.
  const fixture = (table: Table, side: number, fresh = false, payee?: Key | null): Row => {
    const coach: Key = side === 0 ? 'coach' : 'otherCoach';
    const client: Key = side === 0 ? 'client' : 'otherClient';
    const recipient = payee === undefined ? coach : payee;
    const data: Data = { id: randomUUID(), updated_at: now };
    const readers: Key[] = recipient ? [recipient] : [];
    const purchase = fresh ? sparePurchases[side] : purchases[side];
    switch (table) {
      case 'ChargeSettlement':
        Object.assign(data, { id: fresh ? randomUUID() : settlements[side], purchase_id: purchase,
          coach_user_id: id[coach], head_coach_user_id: side === 0 ? id.headCoach : null,
          stripe_charge_id: `ch_${randomUUID()}`, platform_bps: 200, gross_cents: 1000 });
        return { data, readers: side === 0 ? ['coach', 'headCoach'] : ['otherCoach'] };
      case 'PayoutAdjustmentNotice':
        Object.assign(data, { settlement_id: settlements[side], payee_user_id: id[recipient!],
          role: recipient === 'headCoach' ? 'head_coach' : 'coach', purchase_id: purchase,
          stripe_charge_id: `ch_${randomUUID()}`, event: 'refund', charge_gross_cents: 1000,
          customer_refunded_cents: 100, reversed_cents: 100, held_cents: 0, held_tgp_fee_cents: 0,
          held_stripe_fee_cents: 0, held_dispute_fee_cents: 0, held_not_reversed_cents: 0,
          held_open_cents: 0, state_key: randomUUID(), idempotency_key: randomUUID(), title: 'RLS', body: 'RLS' });
        break;
      case 'PayeeRecovery':
        Object.assign(data, { settlement_id: settlements[side], payee_user_id: id[recipient!],
          amount_cents: 100, reason: 'refund', idempotency_key: randomUUID() });
        break;
      case 'ConnectTransfer':
        Object.assign(data, { id: !fresh && payee === undefined ? transfers[side] : randomUUID(),
          purchase_id: purchase, settlement_id: settlements[side], destination_user_id: recipient ? id[recipient] : null,
          destination_stripe_account_id: `acct_${randomUUID()}`, amount_cents: 100, idempotency_key: randomUUID() });
        break;
      case 'SplitLedgerEntry':
        Object.assign(data, { purchase_id: purchase, payee_user_id: recipient ? id[recipient] : null,
          kind: recipient === null ? 'application_fee' : recipient === 'headCoach' ? 'head_coach_split' : 'destination',
          amount_cents: 100, idempotency_key: randomUUID(), stripe_charge_id: `ch_${randomUUID()}` });
        break;
      case 'TransferReversalOp':
        Object.assign(data, { transfer_id: transfers[side], seq: fresh ? 2 : 1,
          amount_cents: 100, base_reversed_cents: 0, idempotency_key: randomUUID() });
        return { data, readers: [] };
      case 'DunningState':
        Object.assign(data, { purchase_id: purchase });
        return { data, readers: [] };
      case 'AuditLog':
        delete data.updated_at;
        Object.assign(data, { action: 'coach_payments.refund_issued', actor_id: id[coach],
          actor_role: 'coach', target_user_id: id[client], tenant_coach_id: id[coach], target_id: purchase });
        return { data, readers: [] };
      case 'GuestCheckout':
        delete data.updated_at;
        Object.assign(data, { package_id: packages[side], created_user_id: id[client],
          stripe_payment_intent_id: `pi_${randomUUID()}`, guest_email: `rls-${randomUUID()}`,
          guest_name: 'RLS', idempotency_key: randomUUID() });
        return { data, readers: [] };
      case 'ScheduledDrop':
        Object.assign(data, { client_purchase_id: purchase, content_id: randomUUID(), asset_type: 'workout',
          asset_id: randomUUID(), cadence_kind: 'immediate', cadence_payload: '{}' });
        return { data, readers: [] };
      case 'CronLease':
        delete data.id;
        Object.assign(data, { name: `charge:${randomUUID()}`, holder: id[coach], acquired_at: now, lease_until: now });
        return { data, readers: [] };
    }
    return { data, readers };
  };

  beforeAll(async () => {
    for (const key of keys) {
      await prisma.user.create({ data: { id: id[key], supabase_id: sub[key], email: `rls-${id[key]}`,
        name: 'RLS', role: ROLES[key], coach_id: key === 'client' || key === 'subCoach'
          ? id.coach : key === 'otherClient' ? id.otherCoach : null } });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: id.coach, sub_coach_id: id.subCoach } });
    await prisma.subCoachAssignment.create({ data: { head_coach_id: id.coach, sub_coach_id: id.subCoach, client_id: id.client } });
    for (const side of [0, 1]) {
      const coach = side === 0 ? id.coach : id.otherCoach;
      const client = side === 0 ? id.client : id.otherClient;
      await prisma.coachPackage.create({ data: { id: packages[side], coach_id: coach, name: 'RLS', amount_cents: 1000 } });
      for (const purchase of [purchases[side], sparePurchases[side]]) {
        await prisma.clientPurchase.create({ data: { id: purchase, client_user_id: client, coach_user_id: coach,
          package_id: packages[side], amount_cents: 1000,
          stripe_checkout_session_id: `cs_${randomUUID()}`, idempotency_key: randomUUID() } });
      }
    }
    // TABLES order satisfies settlement -> transfer -> reversal foreign keys.
    for (const { table } of TABLES) {
      const seeded = [fixture(table, 0), fixture(table, 1)];
      if (['PayoutAdjustmentNotice', 'PayeeRecovery', 'ConnectTransfer', 'SplitLedgerEntry'].includes(table)) {
        seeded.push(fixture(table, 0, false, 'headCoach'));
      }
      if (table === 'SplitLedgerEntry') seeded.push(fixture(table, 0, false, null));
      rows.set(table, seeded);
      for (const row of seeded) {
        const sql = insert(table, row);
        expect(await prisma.$executeRawUnsafe(sql.text, ...sql.params)).toBe(1);
      }
    }
  });
  afterAll(() => prisma.$disconnect());

  it('has RLS enabled and forced on the entire path list', async () => {
    const state = await prisma.$queryRaw<{ table: string; enabled: boolean; forced: boolean }[]>`
      SELECT relname AS "table", relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${TABLES.map((t) => t.table)}::text[])
      ORDER BY relname`;
    expect(state).toEqual(TABLES.map(({ table }) => ({ table, enabled: true, forced: true }))
      .sort((a, b) => a.table.localeCompare(b.table)));
  });

  it.each(ACTORS)('$label really uses a non-superuser, non-bypass role and the intended identity', async (actor) => {
    for (const jwtOnly of [false, true]) {
      expect(await run({ ...actor, jwtOnly }, null, (tx) => tx.$queryRaw`
        SELECT current_user AS role, rolsuper AS super, rolbypassrls AS bypass,
          app.current_user_id() AS id, app.current_user_role() AS app_role
        FROM pg_roles WHERE rolname = current_user`)).toEqual([{
        role: actor.sqlRole, super: false, bypass: false,
        id: actor.key && !jwtOnly ? id[actor.key] : null,
        app_role: actor.key && !jwtOnly ? ROLES[actor.key] : null,
      }]);
    }
  });

  describe.each(TABLES)('$table', ({ table, ownerAll }) => {
    describe.each(MODES)('$label', ({ jwtOnly, policyOnly }) => {
      it.each(ACTORS)('$label gets exactly the permitted rows and CRUD', async (actor) => {
        const who = { ...actor, jwtOnly };
        const grants = policyOnly ? table : null;
        const owner = !jwtOnly && actor.key === 'owner' && ownerAll;
        const noSelectGrant = !policyOnly && table === 'ScheduledDrop';
        const noWriteGrant = !policyOnly && (table === 'ScheduledDrop' || actor.sqlRole === 'anon');
        for (const row of rows.get(table)!) {
          const sql = read(table, row);
          // A same-row control of 1 immediately before every filtered read.
          expect(await select(null, null, sql)).toEqual([{ id: rowId(table, row) }]);
          const allowed = owner || (!jwtOnly && actor.key !== null && row.readers.includes(actor.key));
          expect(await select(who, grants, sql)).toEqual(noSelectGrant ? '42501' : allowed ? [{ id: rowId(table, row) }] : []);
          for (const verb of ['UPDATE', 'DELETE'] as const) {
            const change = mutation(table, row, verb);
            expect(await select(null, null, sql)).toHaveLength(1);
            expect(await write(null, null, change)).toBe(1); // valid SQL, FK and CHECK constraints
            expect(await write(who, grants, change)).toBe(noWriteGrant ? '42501' : owner ? 1 : 0);
          }
          expect(await select(null, null, sql)).toHaveLength(1); // writes and grants rolled back
        }
        // Both own-tenant and foreign-tenant INSERTs must obey the same rule.
        for (const side of [0, 1]) {
          const pending = fixture(table, side, true);
          // Try self-ownership too, including the client and delegated coach.
          const ownership: Partial<Record<Table, string>> = {
            ChargeSettlement: 'coach_user_id', PayoutAdjustmentNotice: 'payee_user_id',
            PayeeRecovery: 'payee_user_id', ConnectTransfer: 'destination_user_id',
            SplitLedgerEntry: 'payee_user_id', AuditLog: 'tenant_coach_id', GuestCheckout: 'created_user_id',
          };
          const column = ownership[table];
          if (side === 0 && actor.key && column) pending.data[column] = id[actor.key];
          const sql = insert(table, pending);
          expect(await select(null, null, read(table, rows.get(table)![side]))).toHaveLength(1);
          expect(await write(null, null, sql)).toBe(1);
          expect(await write(who, grants, sql)).toBe(owner && !noWriteGrant ? 1 : '42501');
        }
      });
    });
  });
});
