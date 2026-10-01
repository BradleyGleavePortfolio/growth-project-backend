import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import {
  PROFILE_WRITE_MAX_ATTEMPTS,
  ProfileService,
  lockProfileRow,
} from '../src/profile/profile.service';
import { computeMacros, resolveMacroInputs } from '../src/macros/macro-calculator';
import type { PrismaService } from '../src/prisma.service';
import type { UpdateProfileDto } from '../src/profile/profile.dto';

// B606-3 (GPT-6.1 Sol, REQUEST CHANGES at 3c707694): two concurrent partial
// PUT /profile requests read the same row, each computed targets from its own
// stale snapshot, and the last writer stored targets that did not match the
// final saved profile (200 lb + moderate stored with 1,789 kcal computed from
// 172 lb).
//
// The fix serialises read -> merge -> compute -> write per user with a row
// lock taken as the FIRST statement of the transaction
// (`SELECT ... FOR UPDATE`), plus a bounded retry for the first-row creation
// race (unique user_id, P2002).
//
// The double below models the Postgres behaviour that matters here:
//   - transactions commit atomically and roll back on throw;
//   - `SELECT ... FOR UPDATE` on an existing row blocks until the holder ends;
//   - UPDATE also takes the row lock (so writers never interleave writes) and
//     applies its SET list onto the LATEST committed row version;
//   - every statement reads the latest committed data (READ COMMITTED);
//   - INSERT of a duplicate user_id waits for an in-flight insert and then
//     fails with P2002 if that insert committed.
// The CONTROL test runs the same interleaving with the lock statement
// neutralised and shows the race reproduces, so the green result is caused
// by the lock and not by the double.
//
// The same scenario runs against real Postgres in
// test/profile-put-concurrency.live.spec.ts (mwb-3-live-tests job).

type Row = Record<string, unknown>;

class Mutex {
  private held = false;
  private readonly queue: Array<() => void> = [];
  async acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on user_id', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

interface DoubleOptions {
  /** false = the lock statement is a no-op (control: the pre-fix behaviour). */
  honourLockStatement: boolean;
  /** Called after each transaction's profile read; may pause that transaction. */
  afterRead?: (txId: number) => Promise<void>;
}

function pgDouble(initial: Row | null, opts: DoubleOptions) {
  const rows = new Map<string, Row>();
  if (initial) rows.set(String(initial.user_id), { id: 'profile-1', ...initial });
  const locks = new Map<string, Mutex>();
  const inflightCreates = new Map<string, Promise<void>>();
  const logs = new Map<number, string[]>();
  let txSeq = 0;
  let transactions = 0;

  const mutex = (uid: string): Mutex => {
    let m = locks.get(uid);
    if (!m) {
      m = new Mutex();
      locks.set(uid, m);
    }
    return m;
  };

  async function $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    transactions += 1;
    const txId = ++txSeq;
    const log: string[] = [];
    logs.set(txId, log);
    const held = new Set<string>();
    const pending = new Map<string, Row>();
    const createDone: Array<() => void> = [];
    const lock = async (uid: string) => {
      if (held.has(uid)) return;
      await mutex(uid).acquire();
      held.add(uid);
    };
    const view = (uid: string): Row | undefined => pending.get(uid) ?? rows.get(uid);

    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('$1');
        log.push(`sql:${sql}`);
        const uid = String(values[0]);
        if (/FOR UPDATE/.test(sql) && opts.honourLockStatement && rows.has(uid)) await lock(uid);
        log.push('locked');
        return rows.has(uid) ? [{ id: rows.get(uid)?.id }] : [];
      },
      userProfile: {
        findUnique: async ({ where }: { where: { user_id: string } }) => {
          log.push('read');
          const r = view(where.user_id);
          const snapshot = r ? { ...r } : null;
          if (opts.afterRead) await opts.afterRead(txId);
          return snapshot;
        },
        update: async ({ where, data }: { where: { user_id: string }; data: Row }) => {
          log.push('update');
          await lock(where.user_id);
          const next = { ...(view(where.user_id) ?? {}), ...data };
          pending.set(where.user_id, next);
          return { ...next };
        },
        create: async ({ data }: { data: Row }) => {
          log.push('create');
          const uid = String(data.user_id);
          const inflight = inflightCreates.get(uid);
          if (inflight) await inflight;
          if (rows.has(uid)) throw p2002();
          let done: () => void = () => undefined;
          inflightCreates.set(
            uid,
            new Promise<void>((resolve) => {
              done = resolve;
            }),
          );
          createDone.push(() => {
            inflightCreates.delete(uid);
            done();
          });
          await lock(uid);
          const row = { id: `profile-tx${txId}`, ...data };
          pending.set(uid, row);
          return { ...row };
        },
      },
    };
    try {
      const out = await fn(tx);
      for (const [k, v] of pending) rows.set(k, v); // COMMIT
      return out;
    } finally {
      createDone.forEach((d) => d());
      for (const uid of held) mutex(uid).release();
    }
  }

  const prisma = { $transaction, userProfile: { findUnique: jest.fn() } };
  return {
    svc: new ProfileService(prisma as object as PrismaService),
    row: (uid: string) => rows.get(uid) ?? null,
    log: (txId: number) => logs.get(txId) ?? [],
    transactions: () => transactions,
  };
}

function dto(v: object): UpdateProfileDto {
  return v as UpdateProfileDto;
}

/** Targets a fresh calculation over the FINAL stored row would produce. */
function freshTargets(row: Row, now: Date) {
  const r = resolveMacroInputs(
    {
      current_weight_lbs: row.current_weight_lbs as number,
      target_weight_lbs: row.target_weight_lbs as number,
      height_cm: row.height_cm as number,
      date_of_birth: row.date_of_birth as Date,
      sex: row.sex as string,
      activity_level: row.activity_level as string,
      goal_type: row.goal_type as string,
    },
    now,
  );
  if (!r.ok) throw new Error(`final row not computable: ${r.missing.join(',')}`);
  const m = computeMacros(r.inputs);
  return {
    macro_target_calories: m.calories,
    macro_target_protein_g: m.protein_g,
    macro_target_carbs_g: m.carbs_g,
    macro_target_fat_g: m.fat_g,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let open: () => void = () => undefined;
  const p = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait: () => p, open: () => open() };
}

// The audit's exact reproduction (Sol B606-3).
const NOW = new Date('2026-10-01T12:00:00Z');
const AUDIT_ROW: Row = {
  user_id: 'audit-client',
  sex: 'female',
  date_of_birth: new Date('1988-04-01T00:00:00Z'),
  height_cm: 167.64,
  current_weight_lbs: 172,
  target_weight_lbs: 150,
  activity_level: 'sedentary',
  goal_type: 'fat_loss',
};

async function twoWriters(honourLockStatement: boolean) {
  const g = gate();
  const h = pgDouble(
    { ...AUDIT_ROW, ...freshTargets(AUDIT_ROW, NOW) },
    {
      honourLockStatement,
      // Writer 1 (tx 1) pauses right after its read while holding whatever
      // it holds; writer 2 runs meanwhile.
      afterRead: (txId) => (txId === 1 ? g.wait() : Promise.resolve()),
    },
  );
  const weight = h.svc.updateProfile('audit-client', dto({ current_weight_lbs: 200 }), NOW);
  await flush();
  const activity = h.svc.updateProfile('audit-client', dto({ activity_level: 'moderate' }), NOW);
  await flush();
  await flush();
  const writer2ReadBeforeWriter1Committed = h.log(2).includes('read');
  g.open();
  const [r1, r2] = await Promise.all([weight, activity]);
  return { h, r1, r2, writer2ReadBeforeWriter1Committed };
}

describe('B606-3: concurrent partial PUT /profile never stores targets inconsistent with the saved profile', () => {
  it('audit reproduction (weight -> 200 || activity -> moderate): final targets equal a fresh calculation of the final row (1,986 kcal)', async () => {
    const { h, r1, r2, writer2ReadBeforeWriter1Committed } = await twoWriters(true);
    // Writer 2 was blocked on the row lock and did not read the stale row.
    expect(writer2ReadBeforeWriter1Committed).toBe(false);
    const final = h.row('audit-client')!;
    expect(final).toMatchObject({ current_weight_lbs: 200, activity_level: 'moderate' });
    expect(final).toMatchObject(freshTargets(final, NOW));
    expect(final.macro_target_calories).toBe(1986);
    // Each response is the row that writer committed, internally consistent.
    for (const r of [r1, r2]) expect(r).toMatchObject(freshTargets(r, NOW));
    // The last committed response is the final row.
    expect(r2).toMatchObject({ current_weight_lbs: 200, activity_level: 'moderate' });
  });

  it('CONTROL: the same interleaving with the lock statement neutralised reproduces the audit defect (proves the test is sensitive)', async () => {
    const { h, writer2ReadBeforeWriter1Committed } = await twoWriters(false);
    expect(writer2ReadBeforeWriter1Committed).toBe(true);
    const final = h.row('audit-client')!;
    expect(final).toMatchObject({ current_weight_lbs: 200, activity_level: 'moderate' });
    expect(final.macro_target_calories).not.toBe(freshTargets(final, NOW).macro_target_calories);
  });

  it('the row lock is the FIRST statement of the write transaction, before the profile read', async () => {
    const h = pgDouble({ ...AUDIT_ROW }, { honourLockStatement: true });
    await h.svc.updateProfile('audit-client', dto({ bio: 'hello' }), NOW);
    const log = h.log(1);
    expect(log[0]).toBe('sql:SELECT "id" FROM "UserProfile" WHERE "user_id" = $1 FOR UPDATE');
    expect(log.indexOf('locked')).toBeLessThan(log.indexOf('read'));
  });

  it('first-row creation race: two first PUTs both succeed, the loser re-merges onto the winner, targets match the final row', async () => {
    const g = gate();
    const h = pgDouble(null, {
      honourLockStatement: true,
      afterRead: (txId) => (txId === 1 ? g.wait() : Promise.resolve()),
    });
    const { user_id: _uid, ...complete } = AUDIT_ROW;
    void _uid;
    const first = h.svc.updateProfile(
      'audit-client',
      dto({ ...complete, date_of_birth: '1988-04-01', current_weight_lbs: 200 }),
      NOW,
    );
    await flush();
    const second = h.svc.updateProfile(
      'audit-client',
      dto({ ...complete, date_of_birth: '1988-04-01', activity_level: 'moderate' }),
      NOW,
    );
    await flush();
    g.open();
    const results = await Promise.all([first, second]);
    expect(results).toHaveLength(2);
    // tx1 lost the INSERT race (P2002) and was retried as tx3.
    expect(h.transactions()).toBe(3);
    const final = h.row('audit-client')!;
    expect(final).toMatchObject(freshTargets(final, NOW));
    expect(final.current_weight_lbs).toBe(200);
  });

  it(`creation-race retries are bounded (${PROFILE_WRITE_MAX_ATTEMPTS} attempts), then the error surfaces`, async () => {
    let attempts = 0;
    const prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        attempts += 1;
        return fn({
          $queryRaw: async () => [],
          userProfile: {
            findUnique: async () => null,
            create: async () => {
              throw p2002();
            },
          },
        });
      }),
    };
    const svc = new ProfileService(prisma as object as PrismaService);
    const { user_id: _uid, ...complete } = AUDIT_ROW;
    void _uid;
    await expect(
      svc.updateProfile('u', dto({ ...complete, date_of_birth: '1988-04-01' }), NOW),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(attempts).toBe(PROFILE_WRITE_MAX_ATTEMPTS);
  });

  it('computeAndSaveMacros takes the same lock before reading', async () => {
    const h = pgDouble({ ...AUDIT_ROW }, { honourLockStatement: true });
    const out = await h.svc.computeAndSaveMacros('audit-client', NOW);
    expect(h.log(1)[0]).toMatch(/FOR UPDATE$/);
    expect(out).toMatchObject(freshTargets(AUDIT_ROW, NOW));
  });

  it('lockProfileRow issues a parameterised statement (no string interpolation of the user id)', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return [];
      },
    };
    await lockProfileRow(tx as object as Prisma.TransactionClient, "x'; DROP TABLE x; --");
    expect(calls).toEqual([
      {
        sql: 'SELECT "id" FROM "UserProfile" WHERE "user_id" = ? FOR UPDATE',
        values: ["x'; DROP TABLE x; --"],
      },
    ]);
  });
});
