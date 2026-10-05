// AUD-OPUS-R34-119 — real PostgreSQL lock-mode probe for #680 @ 216489ff (never merged).
// A throwaway cluster on the Actions runner (never an app database). It
// checks the lock semantics B-680-6 relies on, using the exact statement the
// handler sends (lockPurchase) and the package lock (activateUnderPackageLock):
//  1. FOR NO KEY UPDATE conflicts with itself: two webhook workers serialize.
//  2. A plain UPDATE from another connection (R2's CAS write) waits for it.
//  3. A foreign-key insert from another connection (DunningState / PaymentReminder) does not.
//  4. Package lock then purchase lock, in the same order on both workers: the second waits on the
//     package lock and never holds the purchase lock while waiting (no deadlock).
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 55491;
let root: string;
let bin: string;
let started = false;
let a: PrismaClient;
let b: PrismaClient;

beforeAll(async () => {
  if (process.env.CI !== 'true') throw new Error('CI runner only');
  const versions = readdirSync('/usr/lib/postgresql').sort().reverse();
  bin = join(
    '/usr/lib/postgresql',
    versions.find((v) => existsSync(join('/usr/lib/postgresql', v, 'bin/initdb')))!,
    'bin',
  );
  root = mkdtempSync(join(tmpdir(), 'opus-r34-119-pg-'));
  execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '-U', 'postgres', '--no-sync'], {
    stdio: 'pipe',
  });
  execFileSync(
    join(bin, 'pg_ctl'),
    ['-D', join(root, 'data'), '-l', join(root, 'pg.log'), '-o', `-p ${PORT} -k ${root} -h 127.0.0.1 -F`, '-w', 'start'],
    { stdio: 'pipe' },
  );
  started = true;
  const url = `postgresql://postgres@127.0.0.1:${PORT}/postgres?connection_limit=1`;
  a = new PrismaClient({ datasources: { db: { url } } });
  b = new PrismaClient({ datasources: { db: { url } } });
  await a.$executeRawUnsafe('CREATE TABLE "CoachPackage" (id text PRIMARY KEY)');
  await a.$executeRawUnsafe('CREATE TABLE "ClientPurchase" (id text PRIMARY KEY, status text, updated_at timestamptz)');
  await a.$executeRawUnsafe(
    'CREATE TABLE "DunningState" (id text PRIMARY KEY, purchase_id text UNIQUE REFERENCES "ClientPurchase"(id) ON DELETE CASCADE)',
  );
  await a.$executeRawUnsafe(`INSERT INTO "CoachPackage" VALUES ('pkg')`);
  await a.$executeRawUnsafe(`INSERT INTO "ClientPurchase" VALUES ('cp', 'active', now())`);
}, 60_000);

afterAll(async () => {
  await a?.$disconnect();
  await b?.$disconnect();
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'immediate', 'stop'], { stdio: 'pipe' });
});

const lockPurchase = (c: any, id: string) =>
  c.$queryRaw`SELECT id FROM "ClientPurchase" WHERE id = ${id} FOR NO KEY UPDATE`;
const lockPackage = (c: any, id: string) => c.$queryRaw`SELECT id FROM "CoachPackage" WHERE id = ${id} FOR UPDATE`;

async function whileHeld(hold: (tx: any) => Promise<unknown>, other: () => Promise<unknown>): Promise<string> {
  let outcome = 'unset';
  await a.$transaction(
    async (tx) => {
      await hold(tx);
      try {
        await other();
        outcome = 'ran';
      } catch (err) {
        outcome = /55P03|lock timeout|canceling statement due to lock timeout/i.test(String(err)) ? 'blocked' : `error:${String(err)}`;
      }
    },
    { timeout: 20_000 },
  );
  return outcome;
}

describe('Opus R34-119 real PostgreSQL: lock modes the purchase lock relies on', () => {
  it('a second FOR NO KEY UPDATE on the same purchase waits (two workers serialize)', async () => {
    const r = await whileHeld(
      (tx) => lockPurchase(tx, 'cp'),
      () =>
        b.$transaction(async (t2) => {
          await t2.$executeRawUnsafe(`SET LOCAL lock_timeout = '700ms'`);
          await lockPurchase(t2, 'cp');
        }),
    );
    expect(r).toBe('blocked');
  });

  it('a plain UPDATE of the purchase from another connection waits (CAS writers serialize behind the webhook)', async () => {
    const r = await whileHeld(
      (tx) => lockPurchase(tx, 'cp'),
      () =>
        b.$transaction(async (t2) => {
          await t2.$executeRawUnsafe(`SET LOCAL lock_timeout = '700ms'`);
          await t2.$executeRawUnsafe(`UPDATE "ClientPurchase" SET status = 'past_due', updated_at = now() WHERE id = 'cp'`);
        }),
    );
    expect(r).toBe('blocked');
  });

  it('a DunningState insert referencing the purchase from another connection does not wait', async () => {
    const r = await whileHeld(
      (tx) => lockPurchase(tx, 'cp'),
      () =>
        b.$transaction(async (t2) => {
          await t2.$executeRawUnsafe(`SET LOCAL lock_timeout = '700ms'`);
          await t2.$executeRawUnsafe(`INSERT INTO "DunningState" VALUES ('ds1', 'cp')`);
        }),
    );
    expect(r).toBe('ran');
    const rows = await b.$queryRaw<Array<{ id: string }>>`SELECT id FROM "DunningState" WHERE purchase_id = 'cp'`;
    expect(rows).toHaveLength(1);
  });

  it('package then purchase on both workers: the second waits on the package lock, holding nothing (no deadlock)', async () => {
    const r = await whileHeld(
      async (tx) => {
        await lockPackage(tx, 'pkg');
        await lockPurchase(tx, 'cp');
      },
      () =>
        b.$transaction(async (t2) => {
          await t2.$executeRawUnsafe(`SET LOCAL lock_timeout = '700ms'`);
          await lockPackage(t2, 'pkg');
          await lockPurchase(t2, 'cp');
        }),
    );
    expect(r).toBe('blocked');
    // After the first commits, the second proceeds.
    await b.$transaction(async (t2) => {
      await lockPackage(t2, 'pkg');
      await lockPurchase(t2, 'cp');
    });
  });
});
