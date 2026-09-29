/**
 * importer-mapping-spend-ledger.live.spec.ts — L1-gw r3 real-PostgreSQL proof of
 * the `importer.mapping` spend ledger (R592-c7B-02, R592-c7A-04; closes the
 * "advisory lock unproven" evidence gap both c7 auditors raised).
 *
 * The unit suite (test/ai/importer-mapping-gateway.spec.ts) drives the ledger
 * over an in-memory Prisma double that serialises `$transaction` with a JS
 * mutex. That proves the gateway's ordering, not PostgreSQL's. This spec runs
 * the REAL `AuditSpendLedger` against a real Postgres through SEPARATE
 * PrismaClient instances (one per simulated application instance) and proves:
 *
 *   1. `pg_advisory_xact_lock(bigint)` with the JS BigInt key binds as int8 and
 *      BLOCKS a second connection until the holder commits — witnessed
 *      directly in `pg_locks` / `pg_stat_activity` (r4, R592-c7B2-C01: a
 *      not-granted advisory lock on the key whose backend waits on 'Lock'),
 *      not only by elapsed time;
 *   2. under N concurrent reservations from N connections with a cap sized for
 *      k < N, exactly k are admitted and the sum of reservations is ≤ cap
 *      (READ COMMITTED visibility of the previous holder's committed row after
 *      the lock wait);
 *   3. a reservation committed before a simulated provider call is visible to a
 *      second instance;
 *   4. the accounting day comes from the DATABASE clock inside the transaction:
 *      the row's `created_at` equals it, and rows dated yesterday / tomorrow
 *      (UTC) or belonging to another capability are excluded from the sum;
 *   5. a malformed ledger row closes the gate; a requester that is not a real
 *      User (FK) refuses before any call; a settle failure leaves the
 *      reservation at its maximum; a settlement above the reservation
 *      re-checks under the lock and records `cap_exceeded`.
 *
 * Lane: gated on L1GW_SPEND_LEDGER_DATABASE_URL (a THROWAWAY database — the
 * spec resets `public` and materialises the full Prisma schema). It runs in the
 * `mwb-3-live-tests` CI job (postgres:15 service) and describe.skips with a
 * logged reason when the variable is unset — never a silent pass.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import {
  AiGatewayError,
  AuditSpendLedger,
  IMPORTER_MAPPING_CAPABILITY,
  SpendReserveArgs,
  SpendReservation,
  advisoryLockKey,
  utcDay,
} from '../../src/ai/gateway/structured';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';

const TEST_DB_URL = process.env.L1GW_SPEND_LEDGER_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[l1gw-spend-ledger] L1GW_SPEND_LEDGER_DATABASE_URL not set — real-PostgreSQL spend-ledger suite skipped.',
  );
}

// pg_locks rows for a bigint advisory key (see test 1).
interface AdvisoryLockRow {
  pid: number;
  granted: boolean;
  waitEventType: string | null;
}

async function advisoryLockRows(admin: PrismaClient, key: bigint): Promise<AdvisoryLockRow[]> {
  // classid/objid are oid (unsigned 32-bit) columns; split the signed int8 key.
  // The two halves are computed integers (never user input), inlined as
  // literals so the int8→oid cast is unambiguous for values above 2^31.
  const unsigned = BigInt.asUintN(64, key);
  const classid = Number(unsigned >> 32n);
  const objid = Number(unsigned & 0xffffffffn);
  const rows = await admin.$queryRaw<
    Array<{ pid: number; granted: boolean; wait_event_type: string | null }>
  >`
    SELECT l.pid, l.granted, a.wait_event_type
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory'
       AND l.objsubid = 1
       AND l.classid = ${Prisma.raw(String(classid))}::oid
       AND l.objid = ${Prisma.raw(String(objid))}::oid
     ORDER BY l.granted DESC`;
  return rows.map((r) => ({
    pid: Number(r.pid),
    granted: r.granted,
    waitEventType: r.wait_event_type,
  }));
}

async function waitForAdvisoryWaiter(
  admin: PrismaClient,
  key: bigint,
  timeoutMs: number,
): Promise<AdvisoryLockRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiter = (await advisoryLockRows(admin, key)).find((r) => !r.granted);
    if (waiter && waiter.waitEventType === 'Lock') return waiter;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function asPrismaService(client: PrismaClient): PrismaService {
  // @ts-expect-error a real PrismaClient stands in for PrismaService (which only
  // adds Nest lifecycle hooks and a private logger) — R0-sanctioned escape.
  return client;
}

const COACH_ID = 'l1gw-ledger-coach';
const USD = 1_000_000; // µUSD per USD
const MAX_MICROS = 200_000; // $0.20 per reservation in these tests

function reserveArgs(
  overrides: Partial<SpendReserveArgs> & { requestId?: string } = {},
): SpendReserveArgs {
  const { requestId, ...rest } = overrides;
  return {
    capability: IMPORTER_MAPPING_CAPABILITY,
    capMicros: 20 * USD,
    maxMicros: MAX_MICROS,
    ...rest,
    audit: {
      requestId: requestId ?? `req-${Math.random().toString(16).slice(2)}`,
      requesterId: COACH_ID,
      requesterRole: 'coach',
      tenantCoachId: COACH_ID,
      provider: 'anthropic',
      model: 'model-live',
      promptHash: 'a'.repeat(64),
      redactions: null,
      metadata: { attempt: 0 },
      ...(rest.audit ?? {}),
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return AiGatewayError.is(e) ? `${e.code}:${e.detail.reason ?? ''}` : 'other';
  }
}

liveDescribe(
  'L1-gw r3 — AuditSpendLedger on real PostgreSQL (advisory lock, day window, visibility)',
  () => {
    let admin: PrismaClient;
    const clients: PrismaClient[] = [];

    const newClient = () => {
      const c = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
      clients.push(c);
      return c;
    };

    // The database's idea of "today" (UTC), read the same way the ledger does.
    async function dbToday(): Promise<{ now: Date; day: string }> {
      const rows = await admin.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
      const now = rows[0].now instanceof Date ? rows[0].now : new Date(String(rows[0].now));
      return { now, day: utcDay(now) };
    }

    async function seedRow(
      created_at: Date,
      metadata: Prisma.InputJsonValue,
      capability = IMPORTER_MAPPING_CAPABILITY,
    ) {
      return admin.aiRequestAudit.create({
        data: {
          request_id: `seed-${Math.random().toString(16).slice(2)}`,
          capability,
          requester_id: COACH_ID,
          requester_role: 'coach',
          provider: 'anthropic',
          model: 'seed',
          enabled: false,
          created_at,
          metadata,
        },
        select: { id: true },
      });
    }

    beforeAll(async () => {
      admin = newClient();
      await admin.$connect();
      await resetPublicSchema(admin);
      await bootstrapTestSchema(admin);
      await admin.user.create({
        data: {
          id: COACH_ID,
          supabase_id: `sb-${COACH_ID}`,
          email: `${COACH_ID}@example.test`,
          name: 'Ledger Coach',
          role: 'coach',
        },
      });
    }, 180_000);

    afterAll(async () => {
      for (const c of clients) await c.$disconnect();
    });

    beforeEach(async () => {
      await admin.aiRequestAudit.deleteMany({});
    });

    it('1. the advisory lock binds as int8 and BLOCKS a second connection until the holder commits', async () => {
      const { day } = await dbToday();
      const key = advisoryLockKey(IMPORTER_MAPPING_CAPABILITY, day);
      const holder = newClient();
      const ledger = new AuditSpendLedger(asPrismaService(newClient()));

      let releaseHolder!: () => void;
      const held = new Promise<void>((r) => (releaseHolder = r));
      let lockTaken!: () => void;
      const taken = new Promise<void>((r) => (lockTaken = r));
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
          lockTaken();
          await held;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
      await taken;

      let settled = false;
      const reserving = ledger.reserve(reserveArgs()).then((r) => {
        settled = true;
        return r;
      });
      // r4 (R592-c7B2-C01): prove the wait DIRECTLY from the server's lock
      // table rather than by elapsed time. `pg_advisory_xact_lock(bigint)`
      // shows up in pg_locks as locktype='advisory', classid = high 32 bits,
      // objid = low 32 bits, objsubid = 1; the waiter's row is NOT granted and
      // its backend reports wait_event_type='Lock'. Poll (bounded) until the
      // waiter is visible, then assert.
      const waiter = await waitForAdvisoryWaiter(admin, key, 10_000);
      expect(waiter).toMatchObject({ granted: false, waitEventType: 'Lock' });
      // The holder's row for the same key is granted on a different backend.
      const holderRows = await advisoryLockRows(admin, key);
      expect(holderRows.filter((r) => r.granted)).toHaveLength(1);
      expect(holderRows.filter((r) => !r.granted)).toHaveLength(1);
      expect(holderRows[0].pid).not.toBe(holderRows[1].pid);
      // And it still has not written anything (timing check kept as a second witness).
      await new Promise((r) => setTimeout(r, 750));
      expect(settled).toBe(false);
      expect(await admin.aiRequestAudit.count()).toBe(0);
      releaseHolder();
      await holding;
      const reservation = await reserving;
      expect(settled).toBe(true);
      expect(reservation.day).toBe(day);
      expect(await admin.aiRequestAudit.count()).toBe(1);
    }, 60_000);

    it('2. N=8 concurrent reservations from 8 connections, cap for k=3: exactly 3 admitted, sum ≤ cap, 5 refused daily-spend-cap', async () => {
      const capMicros = 3 * MAX_MICROS + MAX_MICROS / 2; // room for three, not four
      const ledgers = Array.from(
        { length: 8 },
        () => new AuditSpendLedger(asPrismaService(newClient())),
      );
      const outcomes = await Promise.all(
        ledgers.map((l, i) =>
          codeOf(l.reserve(reserveArgs({ capMicros, requestId: `conc-${i}` }))),
        ),
      );
      const admitted = outcomes.filter((o) => o === 'ok').length;
      const refused = outcomes.filter((o) => o === 'ai_budget_exhausted:daily-spend-cap').length;
      expect(admitted).toBe(3);
      expect(refused).toBe(5);
      const rows = await admin.aiRequestAudit.findMany({ select: { metadata: true } });
      expect(rows).toHaveLength(3);
      const sum = rows.reduce(
        (acc, r) => acc + Number((r.metadata as { charge_micros: number }).charge_micros),
        0,
      );
      expect(sum).toBe(3 * MAX_MICROS);
      expect(sum).toBeLessThanOrEqual(capMicros);
      // Each admitted row saw the committed rows before it (0, 1, 2 reservations).
      const before = rows
        .map((r) => Number((r.metadata as { spent_before_micros: number }).spent_before_micros))
        .sort((a, b) => a - b);
      expect(before).toEqual([0, MAX_MICROS, 2 * MAX_MICROS]);
    }, 60_000);

    it('3. a reservation committed on instance A (before its provider call) is visible to instance B', async () => {
      const a = new AuditSpendLedger(asPrismaService(newClient()));
      const b = new AuditSpendLedger(asPrismaService(newClient()));
      const ra = await a.reserve(reserveArgs());
      expect(ra.spentBeforeMicros).toBe(0);
      // A is "in flight" (not settled). B sums A's reservation.
      const rb = await b.reserve(reserveArgs());
      expect(rb.spentBeforeMicros).toBe(MAX_MICROS);
      // With the cap exactly filled, a third is refused while both are in flight.
      expect(await codeOf(b.reserve(reserveArgs({ capMicros: 2 * MAX_MICROS })))).toBe(
        'ai_budget_exhausted:daily-spend-cap',
      );
      const row = await admin.aiRequestAudit.findUnique({ where: { id: ra.auditId } });
      expect(row?.metadata).toMatchObject({ outcome: 'reserved', charge_micros: MAX_MICROS });
    }, 60_000);

    it('4. the day comes from the database clock: created_at == accounting day; yesterday, tomorrow and other capabilities are excluded', async () => {
      const { day } = await dbToday();
      const dayStart = new Date(`${day}T00:00:00.000Z`);
      const yesterdayLate = new Date(dayStart.getTime() - 1); // 23:59:59.999Z yesterday
      const tomorrowStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const huge = { charge_micros: 100 * USD, usd_estimate: 100 };
      await seedRow(yesterdayLate, huge);
      await seedRow(tomorrowStart, huge);
      await seedRow(dayStart, huge, 'chat.client_coach'); // another capability, today

      const ledger = new AuditSpendLedger(asPrismaService(newClient()));
      const r = await ledger.reserve(reserveArgs({ capMicros: 1 * USD }));
      expect(r.day).toBe(day);
      expect(r.spentBeforeMicros).toBe(0);
      const row = await admin.aiRequestAudit.findUnique({ where: { id: r.auditId } });
      expect(row).not.toBeNull();
      expect(utcDay(row!.created_at)).toBe(day);
      expect(row!.metadata).toMatchObject({ accounting_day: day, charge_micros: MAX_MICROS });

      // A row at 00:00:00.000Z today IS counted; the cap is then exceeded.
      await seedRow(dayStart, { charge_micros: 1 * USD, usd_estimate: 1 });
      expect(await codeOf(ledger.reserve(reserveArgs({ capMicros: 1 * USD })))).toBe(
        'ai_budget_exhausted:daily-spend-cap',
      );
    }, 60_000);

    it('5a. a malformed ledger row (no integer charge) closes the gate; a requester that is not a real User refuses (FK, fail closed)', async () => {
      const { now } = await dbToday();
      const ledger = new AuditSpendLedger(asPrismaService(newClient()));
      await seedRow(now, { outcome: 'ok', usd_estimate: 0.01 }); // r2 shape: float only
      expect(await codeOf(ledger.reserve(reserveArgs()))).toBe(
        'ai_budget_exhausted:ledger-malformed',
      );
      await admin.aiRequestAudit.deleteMany({});
      expect(
        await codeOf(
          ledger.reserve(
            reserveArgs({ audit: { requesterId: 'not-a-user' } as SpendReserveArgs['audit'] }),
          ),
        ),
      ).toBe('ai_unavailable:ledger-unavailable');
      expect(await admin.aiRequestAudit.count()).toBe(0);
    }, 60_000);

    it('5b. settle writes the actual charge; a settle failure leaves the maximum; an overage re-checks under the lock and records cap_exceeded', async () => {
      const ledger = new AuditSpendLedger(asPrismaService(newClient()));
      const settlement = (chargedMicros: number) => ({
        chargedMicros,
        outcome: 'ok',
        enabled: true,
        model: 'model-live',
        promptTokens: 10,
        responseTokens: 20,
        responseHash: 'b'.repeat(64),
        errorCode: null,
        metadata: { attempt: 0 },
      });

      // Normal settle: below the reservation.
      const r1 = await ledger.reserve(reserveArgs({ capMicros: 1 * USD }));
      expect(await ledger.settle(r1, settlement(50_000))).toEqual({
        ok: true,
        overage: false,
        capExceeded: false,
      });
      let row = await admin.aiRequestAudit.findUnique({ where: { id: r1.auditId } });
      expect(row?.metadata).toMatchObject({
        outcome: 'ok',
        charge_micros: 50_000,
        reserved_micros: MAX_MICROS,
        overage_micros: 0,
        cap_exceeded: false,
      });
      expect(row?.enabled).toBe(true);

      // Settle failure (row gone): the ledger reports it and nothing is refunded.
      const r2 = await ledger.reserve(reserveArgs({ capMicros: 1 * USD }));
      const ghost: SpendReservation = { ...r2, auditId: '00000000-0000-4000-8000-000000000000' };
      expect((await ledger.settle(ghost, settlement(1))).ok).toBe(false);
      row = await admin.aiRequestAudit.findUnique({ where: { id: r2.auditId } });
      expect(row?.metadata).toMatchObject({ outcome: 'reserved', charge_micros: MAX_MICROS });

      // Overage: actual above the reservation pushes the day (50 000 + 200 000 + X) over a $1 cap.
      const r3 = await ledger.reserve(reserveArgs({ capMicros: 1 * USD }));
      const res = await ledger.settle(r3, settlement(900_000));
      expect(res).toEqual({ ok: true, overage: true, capExceeded: true });
      row = await admin.aiRequestAudit.findUnique({ where: { id: r3.auditId } });
      expect(row?.metadata).toMatchObject({
        charge_micros: 900_000,
        overage_micros: 700_000,
        cap_exceeded: true,
      });
      // The recorded truth now exceeds the cap: the next admission is refused.
      expect(await codeOf(ledger.reserve(reserveArgs({ capMicros: 1 * USD })))).toBe(
        'ai_budget_exhausted:daily-spend-cap',
      );
    }, 60_000);
  },
);
