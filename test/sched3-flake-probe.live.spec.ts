/**
 * SCHED3-FLAKE-BE lane-only probe (never merged; lives only on a ci/ branch).
 *
 * Holds an older REPEATABLE READ snapshot on a second connection, the way an
 * open transaction elsewhere does in CI, and runs both cleanups of the S-SCHED-3
 * C-634-2 test against the real migration:
 *  1. the PR's one-transaction version: rejected by the range preflight, the
 *     constraint is kept, no row is left, and even a full re-run of the
 *     migration (constraint rebuild) with the old snapshot still open passes;
 *  2. main's delete-then-rebuild version: the rebuild ~immediately after the
 *     delete indexes the deleted inverted row and raises 22000.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;

const MIGRATION_SQL = path.resolve(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20270222000000_scheduling_lifecycle_integrity',
  'migration.sql',
);
const COACH_ID = 'sched3-probe-coach';
const CONSTRAINT = 'CoachingSession_no_overlapping_active_booking';

function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (!inDollar && (trimmed.startsWith('--') || trimmed === '')) continue;
    buf += `${line}\n`;
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;
    if (!inDollar && trimmed.endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function inverted(id: string): Prisma.CoachingSessionUncheckedCreateInput {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 9);
  start.setUTCHours(10, 0, 0, 0);
  return {
    id,
    coach_id: COACH_ID,
    status: 'scheduled',
    start_at: start,
    end_at: new Date(start.getTime() - 60_000),
    title: 'inverted',
  };
}

liveDescribe('SCHED3-FLAKE-BE probe: older snapshot open during the S-SCHED-3 cleanup', () => {
  let prisma: PrismaService;
  let holder: PrismaService;
  let statements: string[];
  let rangePreflight: string;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    holder = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await holder.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    statements = splitSql(fs.readFileSync(MIGRATION_SQL, 'utf8'));
    for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
    rangePreflight = statements.find((s) => s.includes('S-SCHED-2 range preflight')) ?? '';
    expect(rangePreflight).not.toBe('');
    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'Probe Coach',
        role: 'coach',
      },
    });
  }, 240_000);

  afterAll(async () => {
    if (holder) await holder.$disconnect();
    if (prisma) await prisma.$disconnect();
  });

  // Opens a REPEATABLE READ transaction on the second client and takes its
  // snapshot now; the returned function ends it.
  async function holdSnapshot(): Promise<() => Promise<void>> {
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((r) => {
      ready = r;
    });
    const tx = holder.$transaction(
      async (t) => {
        await t.$queryRaw`SELECT 1`;
        ready();
        await released;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 120_000,
        maxWait: 10_000,
      },
    );
    await isReady;
    const held = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND backend_xmin IS NOT NULL AND pid <> pg_backend_pid()`;
    expect(Number(held[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    return async () => {
      release();
      await tx;
    };
  }

  async function constraintCount(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint WHERE conname = ${CONSTRAINT}`;
    return rows.length;
  }

  it('PR version: one transaction, rolled back by the preflight; kept constraint; a rebuild with the old snapshot open still passes', async () => {
    const releaseSnapshot = await holdSnapshot();
    try {
      await expect(
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              `ALTER TABLE "CoachingSession" DROP CONSTRAINT "${CONSTRAINT}"`,
            );
            await tx.coachingSession.create({ data: inverted('probe-pr-inverted') });
            await tx.$executeRawUnsafe(rangePreflight);
            throw new Error('range preflight passed an inverted active row');
          },
          { timeout: 60_000, maxWait: 10_000 },
        ),
      ).rejects.toThrow(/range preflight: 1 active CoachingSession row/);
      expect(await constraintCount()).toBe(1);
      expect(await prisma.coachingSession.count({ where: { id: 'probe-pr-inverted' } })).toBe(0);
      // Even a full migration re-run (drop + rebuild of the constraint) with
      // the old snapshot still open passes: the aborted row is never indexed.
      for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
      expect(await constraintCount()).toBe(1);
    } finally {
      await releaseSnapshot();
    }
  });

  it("main's version: delete then rebuild with an older snapshot open raises 22000 on the deleted inverted row", async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "CoachingSession" DROP CONSTRAINT "${CONSTRAINT}"`);
    await prisma.coachingSession.create({ data: inverted('probe-main-inverted') });
    await expect(prisma.$executeRawUnsafe(rangePreflight)).rejects.toThrow(
      /range preflight: 1 active CoachingSession row/,
    );
    const releaseSnapshot = await holdSnapshot();
    let rebuildError: unknown = null;
    try {
      await prisma.coachingSession.deleteMany({ where: { id: 'probe-main-inverted' } });
      try {
        for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
      } catch (err) {
        rebuildError = err;
      }
    } finally {
      await releaseSnapshot();
    }
    expect(rebuildError).not.toBeNull();
    const message = rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
    // eslint-disable-next-line no-console
    console.log(`[SCHED3-FLAKE-BE probe] main's rebuild error: ${message}`);
    expect(message).toMatch(/range lower bound must be less than or equal to range upper bound/);
    expect(message).toMatch(/22000/);
  });

  // Class check (sibling test at spec :247): rows with valid ranges deleted
  // just before the same rebuild, with the same older snapshot open, are
  // indexable, so that cleanup is not in this race's class.
  it('sibling control: delete of valid overlapping rows then rebuild with an older snapshot open passes', async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "CoachingSession" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`,
    );
    const base = inverted('unused');
    const start = new Date(base.start_at as Date);
    const end = new Date(start.getTime() + 30 * 60_000);
    for (const id of ['probe-pre-a', 'probe-pre-b']) {
      await prisma.coachingSession.create({
        data: {
          id,
          coach_id: COACH_ID,
          status: 'scheduled',
          start_at: start,
          end_at: end,
          title: 'x',
        },
      });
    }
    const overlapPreflight = statements.find((s) => s.includes('S-SCHED-2 preflight')) ?? '';
    await expect(prisma.$executeRawUnsafe(overlapPreflight)).rejects.toThrow(
      /S-SCHED-2 preflight: 1 pair/,
    );
    const releaseSnapshot = await holdSnapshot();
    try {
      await prisma.coachingSession.deleteMany({
        where: { id: { in: ['probe-pre-a', 'probe-pre-b'] } },
      });
      for (const stmt of statements) await prisma.$executeRawUnsafe(stmt);
      expect(await constraintCount()).toBe(1);
    } finally {
      await releaseSnapshot();
    }
  });
});
