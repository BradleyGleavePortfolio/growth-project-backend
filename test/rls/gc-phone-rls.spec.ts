/**
 * GC-PHONE (20270502006800): GuestCheckout.guest_phone on the replayed
 * migration chain. GuestCheckout keeps row security enabled and forced with
 * its restrictive deny-all policies (20260801000000), so no API role reads or
 * writes the buyer's phone: not coach K who sold the package, not client A the
 * checkout became, not coach L or L's client B, not a caller with no tenant,
 * not anon. Only the server's service_role does. Every 0 below follows the
 * server's control read of 1 on the same row, and the CHECK refuses anything
 * but E.164.
 *
 * Runs in the rls-live-tests job. Gate: TEST_DATABASE_URL. No URL -> skip,
 * except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('gc-phone-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

(DB_URL ? describe : describe.skip)("Row rules: the buyer's phone on a guest checkout", () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const u: Record<string, string> = Object.fromEntries([...'KALB'].map((k) => [k, randomUUID()]));
  const sub: Record<string, string> = Object.fromEntries(Object.keys(u).map((k) => [k, randomUUID()]));
  const coachOf: Record<string, string> = { A: 'K', B: 'L' };
  const isCoach = (k: string) => 'KL'.includes(k);
  const PHONE = '+14155550100';
  const checkout = randomUUID();
  const pkg = randomUUID();
  const SEEN = `SELECT count(*)::int AS "n" FROM "GuestCheckout" WHERE "id" = $1 AND "guest_phone" = '${PHONE}'`;
  const CHANGE = `UPDATE "GuestCheckout" SET "guest_phone" = '+14155550123' WHERE "id" = $1`;
  const CLEAR = `UPDATE "GuestCheckout" SET "guest_phone" = NULL WHERE "id" = $1`;
  // K, A, L, B; '-' an authenticated caller with no tenant; 'anon'.
  const CALLERS = ['K', 'A', 'L', 'B', '-', 'anon'];

  beforeAll(async () => {
    for (const k of Object.keys(u)) {
      await prisma.user.create({ data: { id: u[k], supabase_id: sub[k], email: `gcp-${u[k]}`, name: 'RLS user',
        role: isCoach(k) ? 'coach' : 'student', coach_id: coachOf[k] ? u[coachOf[k]] : null } });
    }
    await prisma.coachPackage.create({ data: { id: pkg, coach_id: u.K, name: 'RLS', amount_cents: 1000 } });
    await prisma.guestCheckout.create({ data: { id: checkout, package_id: pkg, created_user_id: u.A,
      stripe_payment_intent_id: `pi_${randomUUID()}`, guest_email: `gcp-${randomUUID()}`, guest_name: 'RLS',
      guest_phone: PHONE, status: 'converted', idempotency_key: randomUUID(), expires_at: new Date() } });
  });
  afterAll(() => prisma.$disconnect());

  const sqlstate = (e: unknown) => /Code: `([0-9A-Z]{5})`/.exec(String(e))?.[1] ?? 'refused';
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const role = who === 'anon' ? 'anon' : who === 'server' ? 'service_role' : 'authenticated';
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      const tenant = u[who] ?? '';
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, tenant);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`,
        tenant ? (isCoach(who) ? 'coach' : 'student') : '');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
        JSON.stringify(role === 'anon' ? { role } : { sub: sub[who] ?? randomUUID(), role }));
      return query(tx);
    });
  const reads = async (who: string) => {
    const [{ n }] = await as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(SEEN, checkout));
    return n;
  };
  const write = (who: string, sql: string) =>
    as(who, (tx) => tx.$executeRawUnsafe(sql, checkout)).then((n) => n, sqlstate);

  it('runs as roles that do not bypass row security, on a table that forces it with deny-all rules', async () => {
    for (const who of ['K', 'anon']) {
      expect(await as(who, (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
        SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
    }
    expect(await prisma.$queryRaw`
      SELECT "relrowsecurity" AS "enabled", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public."GuestCheckout"'::regclass`).toEqual([{ enabled: true, forced: true }]);
    expect(await prisma.$queryRaw`
      SELECT "policyname"::text AS "name", "permissive"::text AS "permissive", "cmd"::text AS "cmd" FROM pg_policies
      WHERE "schemaname" = 'public' AND "tablename" = 'GuestCheckout' ORDER BY "policyname"`).toEqual([
      { name: 'guest_checkout_deny_all_delete', permissive: 'RESTRICTIVE', cmd: 'DELETE' },
      { name: 'guest_checkout_deny_all_insert', permissive: 'RESTRICTIVE', cmd: 'INSERT' },
      { name: 'guest_checkout_deny_all_select', permissive: 'RESTRICTIVE', cmd: 'SELECT' },
      { name: 'guest_checkout_deny_all_update', permissive: 'RESTRICTIVE', cmd: 'UPDATE' },
    ]);
  });

  it("no API role reads the phone, the seller and the converted client included (each after the server's read of 1)", async () => {
    for (const who of CALLERS) {
      expect(await reads('server')).toBe(1);
      expect([who, await reads(who)]).toEqual([who, 0]);
    }
  });

  it('no API role changes or clears the phone; the server does', async () => {
    for (const who of CALLERS) {
      for (const sql of [CHANGE, CLEAR]) {
        expect(await reads('server')).toBe(1);
        // anon holds no UPDATE grant (20270502001000); authenticated matches no row.
        expect([who, await write(who, sql)]).toEqual([who, who === 'anon' ? '42501' : 0]);
      }
    }
    expect(await reads('server')).toBe(1);
    expect(await write('server', `UPDATE "GuestCheckout" SET "guest_phone" = '${PHONE}' WHERE "id" = $1`)).toBe(1);
  });

  it('no API role inserts a checkout carrying a phone', async () => {
    for (const who of CALLERS) {
      const sql = `INSERT INTO "GuestCheckout" ("id", "package_id", "stripe_payment_intent_id", "guest_email", "guest_name",
        "guest_phone", "idempotency_key", "expires_at") VALUES ($1, '${pkg}', '${`pi_${randomUUID()}`}', 'x', 'x',
        '${PHONE}', '${randomUUID()}', now())`;
      expect(await reads('server')).toBe(1);
      expect([who, await as(who, (tx) => tx.$executeRawUnsafe(sql, randomUUID())).then((n) => n, sqlstate)])
        .toEqual([who, '42501']);
    }
  });

  it('the database refuses a phone that is not E.164, and takes NULL (the PII scrub and account deletion)', async () => {
    for (const bad of ['4155550100', '+0123456789', '+1 415 555 0100', '+123456', '+1234567890123456', '']) {
      expect([bad, await write('server', `UPDATE "GuestCheckout" SET "guest_phone" = '${bad}' WHERE "id" = $1`)])
        .toEqual([bad, '23514']);
    }
    expect(await reads('server')).toBe(1);
    expect(await write('server', CLEAR)).toBe(1);
    expect(await reads('server')).toBe(0);
  });
});
