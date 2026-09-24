import {
  BackfillIntegrityError,
  backfillLedgerPlatform,
  classify,
  decideOutcome,
  exitCodeFor,
  isLockOrStatementTimeout,
  type BackfillClient,
  type BackfillTx,
  type Candidate,
} from './scout-ledger-backfill';
import { parseBackfillArgs } from './scout-ledger-backfill.cli';

// DB-free proof of the G2-B runner's control flow: classification, chunk cursor
// and pass termination, lock-retry bounds, integrity refusal and the drain
// verdict. The SQL itself, locking and real PostgreSQL behaviour are proven only
// by the guarded live spec test/rls-g2-b-drain.spec.ts; nothing here mocks a
// database result that the live proof does not also establish.

type LedgerRow = { id: string; platform: string | null; matches: number; staged: string | null };

/** In-memory ledger obeying the runner's SQL contract, with per-chunk fault injection. */
class FakeLedger implements BackfillClient {
  readonly statements: string[] = [];
  transactions = 0;
  rollbacks = 0;
  fenced = false;
  locked = new Set<string>();
  faults: Array<'lock' | 'other' | null> = [];
  mismatchOnce = false;

  constructor(readonly rows: LedgerRow[]) {}

  async $transaction<T>(fn: (tx: BackfillTx) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const fault = this.faults.shift() ?? null;
    if (fault === 'lock') {
      this.rollbacks += 1;
      throw new Error(
        'Raw query failed. Code: `55P03`. Message: canceling statement due to lock timeout',
      );
    }
    if (fault === 'other') {
      this.rollbacks += 1;
      throw new Error('Raw query failed. Code: `42P01`. Message: relation does not exist');
    }
    const snapshot = this.rows.map((r) => ({ ...r }));
    try {
      return await fn(this);
    } catch (err) {
      this.rows.splice(0, this.rows.length, ...snapshot);
      this.rollbacks += 1;
      throw err;
    }
  }

  async $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const text = query.join('?');
    this.statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
    if (!text.includes('UPDATE')) return 0;
    const ids = idsOf(values[0]);
    let updated = 0;
    for (const row of this.rows) {
      if (ids.has(row.id) && row.platform === null && row.staged !== null && row.matches === 1) {
        row.platform = row.staged;
        updated += 1;
      }
    }
    if (this.mismatchOnce) {
      this.mismatchOnce = false;
      return updated - 1;
    }
    return updated;
  }

  async $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<any> {
    const text = query.join('?');
    this.statements.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      const [after, limit] = values as [string, number];
      const candidates: Candidate[] = this.rows
        .filter((r) => r.platform === null && r.id > after && !this.locked.has(r.id))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ id: r.id, matches: r.matches, platform: r.staged }));
      return candidates;
    }
    if (text.includes('FILTER (WHERE source_platform IS NULL)')) {
      return [
        { total: this.rows.length, nulls: this.rows.filter((r) => r.platform === null).length },
      ];
    }
    if (text.includes('AS mismatch')) {
      return [
        {
          mismatch: this.rows.filter(
            (r) => r.platform !== null && r.staged !== null && r.platform !== r.staged,
          ).length,
        },
      ];
    }
    if (text.includes('pg_trigger')) return [{ fences: this.fenced ? 1 : 0 }];
    throw new Error(`unexpected query: ${text}`);
  }
}

/** Prisma.join(ids) arrives as a Sql object whose values are the ids. */
function idsOf(joined: unknown): Set<string> {
  const values = (joined as { values?: unknown[] }).values ?? [];
  return new Set(values.map(String));
}

const row = (id: string, staged: string | null = 'truecoach', matches = 1): LedgerRow => ({
  id,
  platform: null,
  matches,
  staged,
});
const claimed = (id: string, platform: string): LedgerRow => ({
  id,
  platform,
  matches: 1,
  staged: 'truecoach',
});

describe('G2-B classify', () => {
  it('resolves exactly one canonical staged match and classifies every other case', () => {
    expect(
      classify([
        { id: 'a', matches: 1, platform: 'truecoach' },
        { id: 'b', matches: 0, platform: null },
        { id: 'c', matches: 2, platform: 'truecoach' },
        { id: 'd', matches: 1, platform: 'Bad Platform' },
        { id: 'e', matches: 1, platform: '' },
        { id: 'f', matches: 1, platform: 'unknown' },
        { id: 'g', matches: 1, platform: null },
      ]),
    ).toEqual({ resolvable: ['a', 'f'], orphan: 1, ambiguous: 1, invalid: 3 });
  });
});

describe('G2-B decideOutcome / exit codes', () => {
  const none = { orphan: 0, invalid: 0, ambiguous: 0 };
  it('is drained only with zero NULL and the fence installed', () => {
    expect(decideOutcome(0, true, none)).toBe('drained');
    expect(decideOutcome(0, false, none)).toBe('complete_unfenced');
  });
  it('separates fully explained remainders from unexplained (locked/unprocessed) ones', () => {
    expect(decideOutcome(3, true, { orphan: 2, invalid: 1, ambiguous: 0 })).toBe('unresolved');
    expect(decideOutcome(4, true, { orphan: 2, invalid: 1, ambiguous: 0 })).toBe('stalled');
    expect(decideOutcome(1, true, none)).toBe('stalled');
  });
  it('exits 0 only for drained', () => {
    expect(exitCodeFor('drained')).toBe(0);
    expect(exitCodeFor('unresolved')).toBe(2);
    expect(exitCodeFor('stalled')).toBe(3);
    expect(exitCodeFor('complete_unfenced')).toBe(4);
  });
  it('recognises lock and statement timeouts only', () => {
    expect(isLockOrStatementTimeout(new Error('Code: `55P03`'))).toBe(true);
    expect(isLockOrStatementTimeout(new Error('due to statement timeout'))).toBe(true);
    expect(isLockOrStatementTimeout(new Error('Code: `57014`'))).toBe(true);
    expect(isLockOrStatementTimeout(new Error('Code: `23505`'))).toBe(false);
    expect(isLockOrStatementTimeout('string failure')).toBe(false);
  });
});

describe('G2-B backfillLedgerPlatform control flow', () => {
  it('walks NULL rows in id order in bounded chunks, resumes past unresolvable rows, and stops honestly', async () => {
    const rows: LedgerRow[] = [];
    for (let n = 1; n <= 7; n++) rows.push(row(`r${n}`));
    rows.push(row('o1', null, 0), row('i1', 'Bad Platform'), claimed('k1', 'truecoach'));
    rows.push(claimed('m1', 'different'));
    const db = new FakeLedger(rows);
    db.fenced = true;
    const report = await backfillLedgerPlatform(db, { batch: 3 });
    // Pass 1: chunks i1+o1+r1, r2-r4, r5-r7, then an empty chunk past r7 (a full chunk cannot
    // prove the end): 9 examined, 7 updated. Pass 2: i1+o1 only, nothing updated -> stop.
    // Claimed and mismatching rows are never candidates or updates.
    expect(report.passes.map((p) => [p.chunks, p.examined, p.updated])).toEqual([
      [4, 9, 7],
      [1, 2, 0],
    ]);
    expect(report).toMatchObject({
      batch: 3,
      ledgerTotal: 11,
      nullBefore: 9,
      nullAfter: 2,
      mismatch: 1,
      fenced: true,
      unresolved: { orphan: 1, invalid: 1, ambiguous: 0 },
      outcome: 'unresolved',
    });
    expect(rows.filter((r) => r.id.startsWith('r')).every((r) => r.platform === 'truecoach')).toBe(
      true,
    );
    expect(rows.find((r) => r.id === 'm1')?.platform).toBe('different');
    expect(rows.find((r) => r.id === 'o1')?.platform).toBeNull();
    // Every chunk transaction sets both budgets and takes the staging SHARE lock before selecting.
    expect(db.statements.filter((s) => s.startsWith('SET LOCAL lock_timeout'))).toHaveLength(5);
    expect(db.statements.filter((s) => s.startsWith('SET LOCAL statement_timeout'))).toHaveLength(
      5,
    );
    expect(db.statements.filter((s) => s.startsWith('LOCK TABLE'))).toHaveLength(5);
    expect(db.statements.filter((s) => s.startsWith('UPDATE'))).toHaveLength(3);
    expect(db.rollbacks).toBe(0);
    // Rerun is idempotent: one chunk, nothing to update, same verdict.
    const again = await backfillLedgerPlatform(db, { batch: 3 });
    expect(again.passes).toHaveLength(1);
    expect(again.passes[0]).toMatchObject({ examined: 2, updated: 0 });
    expect(again.outcome).toBe('unresolved');
  });

  it('reports completion without the fence as complete_unfenced, never drained', async () => {
    const db = new FakeLedger([row('a'), row('b')]);
    const report = await backfillLedgerPlatform(db, { batch: 500 });
    expect(report).toMatchObject({ nullAfter: 0, fenced: false, outcome: 'complete_unfenced' });
    // A productive pass is followed by one confirming pass that finds nothing.
    expect(report.passes.map((p) => p.examined)).toEqual([2, 0]);
  });

  it('skips locked rows without waiting, revisits them on the next pass, and reports a stall', async () => {
    const db = new FakeLedger([row('a'), row('b'), row('c')]);
    db.fenced = true;
    db.locked.add('b');
    const stalled = await backfillLedgerPlatform(db, { batch: 500, maxPasses: 3 });
    expect(stalled.passes.map((p) => [p.examined, p.updated])).toEqual([
      [2, 2],
      [0, 0],
    ]);
    expect(stalled).toMatchObject({
      nullAfter: 1,
      unresolved: { orphan: 0, invalid: 0, ambiguous: 0 },
      outcome: 'stalled',
    });
    db.locked.clear();
    const drained = await backfillLedgerPlatform(db, { batch: 500 });
    expect(drained.passes.map((p) => [p.examined, p.updated])).toEqual([
      [1, 1],
      [0, 0],
    ]);
    expect(drained.outcome).toBe('drained');
  });

  it('retries a chunk only for lock/statement timeouts, within the bound, then stalls', async () => {
    const db = new FakeLedger([row('a'), row('b')]);
    db.fenced = true;
    db.faults = ['lock', 'lock', 'lock'];
    const report = await backfillLedgerPlatform(db, { batch: 500, lockRetries: 2 });
    expect(report.passes).toEqual([
      expect.objectContaining({
        chunks: 0,
        examined: 0,
        updated: 0,
        lockFailures: 3,
        stalledByLocks: true,
      }),
    ]);
    expect(report.outcome).toBe('stalled');
    expect(db.transactions).toBe(3);
    // A recovered lock on the last permitted attempt completes the chunk normally.
    db.faults = ['lock'];
    const recovered = await backfillLedgerPlatform(db, { batch: 500, lockRetries: 1 });
    expect(recovered.passes[0]).toMatchObject({
      lockFailures: 1,
      updated: 2,
      stalledByLocks: false,
    });
    expect(recovered.outcome).toBe('drained');
    // Zero retries is a legal bound: exactly one attempt, then an honest stall (fresh fixture,
    // still holding a NULL row, so neither prior drain nor cumulative counters leak in).
    const fresh = new FakeLedger([row('a')]);
    fresh.fenced = true;
    fresh.faults = ['lock'];
    const once = await backfillLedgerPlatform(fresh, { batch: 500, lockRetries: 0 });
    expect(once.passes).toEqual([
      expect.objectContaining({ chunks: 0, lockFailures: 1, stalledByLocks: true }),
    ]);
    expect(once.outcome).toBe('stalled');
    expect(fresh.transactions).toBe(1);
  });

  it('propagates any non-timeout database failure instead of retrying or inventing a verdict', async () => {
    const db = new FakeLedger([row('a')]);
    db.faults = ['other'];
    await expect(backfillLedgerPlatform(db, { batch: 500 })).rejects.toThrow('42P01');
    expect(db.transactions).toBe(1);
  });

  it('refuses a chunk whose update count differs from the locked resolvable set and rolls it back', async () => {
    const db = new FakeLedger([row('a'), row('b')]);
    db.mismatchOnce = true;
    await expect(backfillLedgerPlatform(db, { batch: 500 })).rejects.toBeInstanceOf(
      BackfillIntegrityError,
    );
    expect(db.rollbacks).toBe(1);
    expect(db.rows.every((r) => r.platform === null)).toBe(true);
  });

  it('bounds batch, passes and retries before touching the database', async () => {
    const db = new FakeLedger([row('a')]);
    const invalid = [{ batch: 0 }, { batch: 2001 }, { maxPasses: 11 }, { lockRetries: -1 }];
    for (const options of [...invalid, { batch: 1.5 }]) {
      await expect(backfillLedgerPlatform(db, options)).rejects.toBeInstanceOf(RangeError);
    }
    expect(db.transactions).toBe(0);
    expect(db.statements).toHaveLength(0);
  });
});

describe('G2-B operator argument parsing', () => {
  it('accepts only the three bounded numeric flags', () => {
    expect(parseBackfillArgs(['--batch=250', '--passes=2', '--lock-retries=1'])).toEqual({
      batch: 250,
      maxPasses: 2,
      lockRetries: 1,
    });
    expect(parseBackfillArgs([])).toEqual({});
    for (const bad of ['--batch', '--batch=abc', '--force', 'positional', '--batch=-1']) {
      expect(() => parseBackfillArgs([bad])).toThrow(RangeError);
    }
  });
});
