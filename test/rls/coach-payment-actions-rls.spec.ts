/**
 * RLSPAY: live row-layer contract for every table a coach payment action
 * (refund, pause, resume, cancel) writes that had no running live test.
 * ChargeRefund and ClientPurchase are already proved by money-write-lock-rls.
 * Reuses the money-write-lock suite's non-bypass SET LOCAL ROLE pattern.
 * CI discovers this file on its own copy of the fully replayed migration chain.
 * No policy changes: production grants are tested first, then temporary CRUD
 * grants (rolled back with the query) isolate RLS from missing table privileges.
 * BILLRAW (20270502003500) took the API roles' grants on the six payout and
 * refund-decision tables (grants: 'none').
 * JWT-only requests deliberately have no app identity; they must see nothing.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('coach-payment-actions-rls: CI=true without TEST_DATABASE_URL; refusing to skip.');
}

// owner: what the owner app role may do. grants: none = no anon/authenticated
// grant at all; authenticated = anon holds none. anonHelper: the table's row
// rule calls a helper anon may not execute, so anon is refused with 42501.
// set: a real money / state change for UPDATE. TABLES order satisfies the FKs.
type Config = { table: string; set: string; key?: string; owner?: 'crud' | 'read-update';
  grants?: 'none' | 'authenticated'; anonHelper?: boolean; selfInsert?: string };
const TABLES = [
  { table: 'ChargeSettlement', set: '"refunded_cents" = 100', owner: 'crud', grants: 'none', anonHelper: true },
  { table: 'PayoutAdjustmentNotice', set: '"customer_refunded_cents" = 101', owner: 'crud', grants: 'none', anonHelper: true },
  { table: 'PayeeRecovery', set: '"amount_cents" = 101', owner: 'crud', grants: 'none', anonHelper: true },
  { table: 'ConnectTransfer', set: '"amount_cents" = 101', owner: 'crud', grants: 'none', anonHelper: true },
  { table: 'TransferReversalOp', set: '"amount_cents" = 101', owner: 'crud', anonHelper: true },
  { table: 'DunningState', set: '"status" = \'refunded\'' },
  { table: 'DunningNoticeDelivery', set: '"status" = \'canceled\'', grants: 'authenticated' },
  { table: 'DunningAttempt', set: '"status" = \'cancelled\'', grants: 'none' },
  { table: 'PaymentRecoveryToken', set: '"used_at" = now()', grants: 'none' },
  { table: 'AuditLog', set: '"action" = \'rls.changed\'', owner: 'crud', anonHelper: true },
  { table: 'SplitLedgerEntry', set: '"amount_cents" = 101', owner: 'crud', grants: 'none', anonHelper: true },
  { table: 'SplitLedgerReversal', set: '"cents" = 101' },
  { table: 'GuestCheckout', set: '"status" = \'refunded\'' },
  { table: 'ScheduledDrop', set: '"status" = \'refunded\'', grants: 'none' },
  { table: 'CronLease', set: '"holder" = \'rls.changed\'', key: 'name', owner: 'crud', anonHelper: true },
  { table: 'ClientBillingLease', set: '"fence" = 1', key: 'purchase_id', grants: 'authenticated' },
  { table: 'ClientBillingOperation', set: '"phase" = \'done\'', grants: 'authenticated' },
  { table: 'PartialRefundDecision', set: '"decision" = \'keep_drops\'', owner: 'read-update', grants: 'none', anonHelper: true },
  { table: 'Notification', set: '"read_at" = now()', selfInsert: 'user_id' },
] as const satisfies readonly Config[];
type Table = typeof TABLES[number]['table'];
const ROLES = {
  coach: 'coach', otherCoach: 'coach', client: 'student', otherClient: 'student',
  subCoach: 'coach', headCoach: 'coach', owner: 'owner',
} as const;
type Key = keyof typeof ROLES;
type Verb = 'SELECT' | 'UPDATE' | 'DELETE';
type Who = { key: Key | null; sqlRole: 'authenticated' | 'anon'; jwtOnly: boolean };
type Data = Record<string, string | number | Date | null>;
type Row = { data: Data; can: Record<Verb, Key[]> };
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
  const pair = () => [randomUUID(), randomUUID()];
  const noTenantSub = randomUUID();
  const [packages, purchases, sparePurchases, settlements, transfers, dunnings, attempts, spareAttempts, entries] =
    Array.from({ length: 9 }, pair);
  const rows = new Map<Table, Row[]>();
  const config = (table: Table): Config => TABLES.find((t) => t.table === table)!;
  const now = new Date('2026-10-15T12:00:00Z');
  const primaryKey = (table: Table) => config(table).key ?? 'id';
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
    text: verb === 'DELETE'
      ? `DELETE FROM public.${quote(table)} WHERE ${quote(primaryKey(table))} = $1`
      : `UPDATE public.${quote(table)} SET ${config(table).set} WHERE ${quote(primaryKey(table))} = $1`,
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
            // PartialRefundDecision's row rule reads its ClientPurchase, server-only since 20270502003500 (BILLRAW).
            await tx.$executeRawUnsafe(`GRANT SELECT ON public."ClientPurchase" TO ${who.sqlRole}`);
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

  // A and B have complete independent purchase/settlement/transfer/dunning
  // paths. Additional head-coach payee rows, a coach notice and a platform
  // ledger row distinguish "payee" from "seller", "client", "team member" and NULL.
  const fixture = (table: Table, side: number, fresh = false, payee?: Key | null): Row => {
    const coach: Key = side === 0 ? 'coach' : 'otherCoach';
    const client: Key = side === 0 ? 'client' : 'otherClient';
    const recipient = payee === undefined ? (table === 'Notification' ? client : coach) : payee;
    const data: Data = { id: randomUUID(), updated_at: now };
    const purchase = fresh ? sparePurchases[side] : purchases[side];
    const owner = config(table).owner;
    // Who may read / change / delete this row: the payee, plus the owner role.
    const can = (readers: Key[], updaters: Key[] = [], deleters: Key[] = []): Row => ({ data, can: {
      SELECT: owner ? [...readers, 'owner'] : readers,
      UPDATE: owner ? [...updaters, 'owner'] : updaters,
      DELETE: owner === 'crud' ? [...deleters, 'owner'] : deleters,
    } });
    const payeeRow = () => can(recipient ? [recipient] : []);
    switch (table) {
      case 'ChargeSettlement':
        Object.assign(data, { id: fresh ? randomUUID() : settlements[side], purchase_id: purchase,
          coach_user_id: id[coach], head_coach_user_id: side === 0 ? id.headCoach : null,
          stripe_charge_id: `ch_${randomUUID()}`, platform_bps: 200, gross_cents: 1000 });
        return can(side === 0 ? ['coach', 'headCoach'] : ['otherCoach']);
      case 'PayoutAdjustmentNotice':
        Object.assign(data, { settlement_id: settlements[side], payee_user_id: id[recipient!],
          role: recipient === 'headCoach' ? 'head_coach' : 'coach', purchase_id: purchase,
          stripe_charge_id: `ch_${randomUUID()}`, event: 'refund', charge_gross_cents: 1000,
          customer_refunded_cents: 100, reversed_cents: 100, held_cents: 0, held_tgp_fee_cents: 0,
          held_stripe_fee_cents: 0, held_dispute_fee_cents: 0, held_not_reversed_cents: 0,
          held_open_cents: 0, state_key: randomUUID(), idempotency_key: randomUUID(), title: 'RLS', body: 'RLS' });
        return payeeRow();
      case 'PayeeRecovery':
        Object.assign(data, { settlement_id: settlements[side], payee_user_id: id[recipient!],
          amount_cents: 100, reason: 'refund', idempotency_key: randomUUID() });
        return payeeRow();
      case 'ConnectTransfer':
        Object.assign(data, { id: !fresh && payee === undefined ? transfers[side] : randomUUID(),
          purchase_id: purchase, settlement_id: settlements[side], destination_user_id: recipient ? id[recipient] : null,
          destination_stripe_account_id: `acct_${randomUUID()}`, amount_cents: 100, idempotency_key: randomUUID() });
        return payeeRow();
      case 'SplitLedgerEntry':
        Object.assign(data, { id: !fresh && payee === undefined ? entries[side] : randomUUID(),
          purchase_id: purchase, payee_user_id: recipient ? id[recipient] : null,
          kind: recipient === null ? 'application_fee' : recipient === 'headCoach' ? 'head_coach_split' : 'destination',
          amount_cents: 100, idempotency_key: randomUUID(), stripe_charge_id: `ch_${randomUUID()}` });
        return payeeRow();
      case 'TransferReversalOp':
        Object.assign(data, { transfer_id: transfers[side], seq: fresh ? 2 : 1,
          amount_cents: 100, base_reversed_cents: 0, idempotency_key: randomUUID() });
        return can([]);
      case 'DunningState':
        Object.assign(data, { id: fresh ? randomUUID() : dunnings[side], purchase_id: purchase });
        return can([]);
      case 'DunningNoticeDelivery':
        Object.assign(data, { dunning_state_id: dunnings[side], cycle_key: randomUUID(), step_index: 0, channel: 'email' });
        return can([]);
      case 'DunningAttempt':
        Object.assign(data, { id: fresh ? randomUUID() : attempts[side], dunning_state_id: dunnings[side],
          step_index: fresh ? 2 : 1, kind: 'email', scheduled_for: now });
        return can([]);
      case 'PaymentRecoveryToken':
        delete data.updated_at;
        Object.assign(data, { dunning_attempt_id: fresh ? spareAttempts[side] : attempts[side],
          jwt_jti: randomUUID(), expires_at: now });
        return can([]);
      case 'AuditLog':
        delete data.updated_at;
        Object.assign(data, { action: 'coach_payments.refund_issued', actor_id: id[coach],
          actor_role: 'coach', target_user_id: id[client], tenant_coach_id: id[coach], target_id: purchase });
        return can([]);
      case 'SplitLedgerReversal':
        delete data.updated_at;
        Object.assign(data, { entry_id: entries[side], source_kind: 'refund', source_id: `re_${randomUUID()}`,
          cents: 100, posted_at: now });
        return can([]);
      case 'GuestCheckout':
        delete data.updated_at;
        Object.assign(data, { package_id: packages[side], created_user_id: id[client],
          stripe_payment_intent_id: `pi_${randomUUID()}`, guest_email: `rls-${randomUUID()}`,
          guest_name: 'RLS', idempotency_key: randomUUID(), expires_at: now });
        return can([]);
      case 'ScheduledDrop':
        Object.assign(data, { client_purchase_id: purchase, content_id: randomUUID(), asset_type: 'workout',
          asset_id: randomUUID(), cadence_kind: 'immediate', cadence_payload: '{}' });
        return can([]);
      case 'CronLease':
        delete data.id;
        Object.assign(data, { name: `charge:${randomUUID()}`, holder: id[coach], acquired_at: now, lease_until: now });
        return can([]);
      case 'ClientBillingLease':
        delete data.id;
        Object.assign(data, { purchase_id: purchase, holder: randomUUID(), holder_until: now });
        return can([]);
      case 'ClientBillingOperation':
        Object.assign(data, { purchase_id: purchase, kind: 'cancel', phase: 'voiding', fence: 0 });
        return can([]);
      case 'PartialRefundDecision':
        // The selling coach (not the head coach, sub-coach or client) reads and decides.
        delete data.updated_at;
        Object.assign(data, { client_purchase_id: purchase, stripe_refund_id: `re_${randomUUID()}` });
        return can([coach], [coach]);
      case 'Notification':
        // The recipient alone owns the row: no owner, coach or team access.
        delete data.updated_at;
        Object.assign(data, { user_id: id[recipient!], kind: 'DUNNING_BLOCKER', body: 'RLS', channel: 'inapp' });
        return can([recipient!], [recipient!], [recipient!]);
    }
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
    for (const { table } of TABLES) {
      const seeded = [fixture(table, 0), fixture(table, 1)];
      if (['PayoutAdjustmentNotice', 'PayeeRecovery', 'ConnectTransfer', 'SplitLedgerEntry'].includes(table)) {
        seeded.push(fixture(table, 0, false, 'headCoach'));
      }
      if (table === 'SplitLedgerEntry') seeded.push(fixture(table, 0, false, null));
      if (table === 'Notification') seeded.push(fixture(table, 0, false, 'coach'));
      rows.set(table, seeded);
      for (const row of seeded) {
        const sql = insert(table, row);
        expect(await prisma.$executeRawUnsafe(sql.text, ...sql.params)).toBe(1);
      }
      if (table === 'DunningAttempt') {
        for (const side of [0, 1]) {
          // Unused attempts, so a fresh recovery-token INSERT has a valid parent.
          await prisma.dunningAttempt.create({ data: { id: spareAttempts[side], dunning_state_id: dunnings[side],
            step_index: 9, kind: 'email', scheduled_for: now } });
        }
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
      const who = { ...actor, jwtOnly };
      expect(await run(who, null, (tx) => tx.$queryRaw`
        SELECT current_user AS role, rolsuper AS super, rolbypassrls AS bypass, app.current_user_id() AS id
        FROM pg_roles WHERE rolname = current_user`)).toEqual([{
        role: actor.sqlRole, super: false, bypass: false, id: actor.key && !jwtOnly ? id[actor.key] : null,
      }]);
      // anon may not even ask for a role: the role and owner helpers refuse it.
      expect(await run(who, null, (tx) => tx.$queryRaw`SELECT app.current_user_role() AS app_role`))
        .toEqual(actor.sqlRole === 'anon' ? '42501' : [{ app_role: actor.key && !jwtOnly ? ROLES[actor.key] : null }]);
    }
  });

  describe.each(TABLES as readonly Config[])('$table', ({ table: name, grants, anonHelper, selfInsert, owner: ownerRule }) => {
    const table = name as Table;
    describe.each(MODES)('$label', ({ jwtOnly, policyOnly }) => {
      it.each(ACTORS)('$label gets exactly the permitted rows and CRUD', async (actor) => {
        const who = { ...actor, jwtOnly };
        const grantTable = policyOnly ? table : null;
        const anon = actor.sqlRole === 'anon';
        const refused = anon && anonHelper; // 42501 from the row rule's helper, in every mode
        const noSelectGrant = refused || (!policyOnly && (grants === 'none' || (grants === 'authenticated' && anon)));
        const noWriteGrant = refused || (!policyOnly && (grants === 'none' || anon));
        const may = (row: Row, verb: Verb) => !jwtOnly && actor.key !== null && row.can[verb].includes(actor.key);
        for (const row of rows.get(table)!) {
          const sql = read(table, row);
          // A same-row control of 1 immediately before every filtered read.
          expect(await select(null, null, sql)).toEqual([{ id: rowId(table, row) }]);
          expect(await select(who, grantTable, sql))
            .toEqual(noSelectGrant ? '42501' : may(row, 'SELECT') ? [{ id: rowId(table, row) }] : []);
          for (const verb of ['UPDATE', 'DELETE'] as const) {
            const change = mutation(table, row, verb);
            expect(await select(null, null, sql)).toHaveLength(1);
            expect(await write(null, null, change)).toBe(1); // valid SQL, FK and CHECK constraints
            expect(await write(who, grantTable, change)).toBe(noWriteGrant ? '42501' : may(row, verb) ? 1 : 0);
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
            Notification: 'user_id',
          };
          const column = ownership[table];
          if (side === 0 && actor.key && column) pending.data[column] = id[actor.key];
          const allowed = !jwtOnly && actor.key !== null && ((ownerRule === 'crud' && actor.key === 'owner')
            || (selfInsert !== undefined && pending.data[selfInsert] === id[actor.key]));
          const sql = insert(table, pending);
          expect(await select(null, null, read(table, rows.get(table)![side]))).toHaveLength(1);
          expect(await write(null, null, sql)).toBe(1);
          expect(await write(who, grantTable, sql)).toBe(allowed && !noWriteGrant ? 1 : '42501');
        }
      });
    });
  });
});
