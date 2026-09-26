/**
 * S9-C G2 live proof — reconciliation wiring (docs/decisions/2026-09-25-s9-reconciliation.md
 * D-S9-8 row S9-C; acceptance cases R09, R10(C), R11, R13, R15 of §3).
 *
 * Derived by literal substitution from the accepted test/rls-g2-s8g.spec.ts (at 771db62a), which
 * stays byte-identical and keeps governing the S8-G proof on its own lane. Same real psql, same
 * real generated Prisma client, real ScoutService → ScoutLifecycleService → ScoutReconstructService
 * → ReconciliationFactsService in separate OS processes (test/utils/g2-s9c-worker.cjs), no query or
 * transaction mocks. Only the S9-C-only lane (test/utils/g2-s9c-db.ts, G2_S9C_*, port chosen and
 * double-entered by the operator) is ever touched.
 *
 * What is proven here is the WIRING, not the S9-A classifier: the terminal the settle tail writes
 * IS `reconcile(facts).verdict` for the same run (run row reason_code == report.conditions[0]),
 * `complete` is never written, fence/claim precedence is unchanged, S9 writes nothing, a CAS miss
 * reads nothing, the status read carries the recomputed report additively and replays identically,
 * a legacy row keeps its S7-L shape, and no tenant sees another tenant's rows.
 */
import { execFileSync } from 'child_process';
import {
  catalog,
  completionRows,
  intent,
  ledgerByToken,
  ledgerRows,
  legacyRun,
  PLATFORM,
  programs,
  provenanceRows,
  REGISTRY,
  resetData,
  runRow,
  stage,
  stagedCount,
  TOKEN,
} from './utils/g2-s9c-harness';
import {
  appliedMigrations,
  BASE_HEAD,
  candidateHead,
  directory,
  EXPECTED_MIGRATIONS,
  expectedVersion,
  jsonAdmin,
  quote,
  refused,
  root,
  run,
  S7L_MIGRATION,
  sql,
  sqlAdmin,
  sqlAs,
  target,
  worker,
} from './utils/g2-s9c-pg-harness';

jest.setTimeout(300000);

const COACH = 'coach';
const OTHER = 'other-coach';
const LEGACY_INTENT = 'intent_legacy_s9c';
const CAT_ID = '11111111-1111-4111-8111-111111111111';
const CAT_SLUG = 'synthetic-bench-press';
const PROGRAM = { title: 'Base Block', weeks: 4, days: 3, notes: 'synthetic' };
const WORKOUT = {
  title: 'Push Day',
  kind: 'lift',
  minutes: 45,
  exercises: [{ id: 'e1', exercise: CAT_ID, sets: 3, reps: 8, kg: 100 }],
};
const ack = (intent_id: string) => ({ acknowledged: true, intent_id });

/** The three S9 codes appended after the six S7-L codes (D-S9-7); `complete` is never one. */
const S9_CODES = [
  'unresolved_family',
  'unresolved_identities',
  'relationship_unverified',
  'coverage_basis_unknown',
];
/** S7-L family projection keys (R13: a legacy row never gains any other key). */
const S7L_FAMILY_KEYS = [
  'already_present_verified',
  'created_native',
  'family',
  'ledger',
  'observed_unique',
  'rejected',
  'staged_unique',
  'unresolved',
];
/** The six additive S9-C keys (D-S9-5, doc §3 R15). */
const S9C_FAMILY_KEYS = [
  'canonical_family',
  'completeness_basis',
  'native_present_verified',
  'qualifiers',
  'reasons',
  'relationship_closure',
];

/* ---- query-log helpers (statement shapes only; the worker never logs parameters) ---- */
const isGate = (q: string) => /SET last_observed_at\s*=/.test(q);
const isLock = (q: string) => q.includes('FOR NO KEY UPDATE');
const isTerminal = (q: string) => q.includes('SET terminal_status = ');
const isWrite = (q: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q);
/**
 * The S9-B facts collector's signature statement (facts.service.ts `readProvenance`): the ONE
 * provenance read keyed by a `source_namespace IN (…)` list over the mapped families. S8-C's own
 * writer lookups (`findProvenance` findUnique, `countUnresolvedChildren`, the upsert's select)
 * address the table by an equality on `source_namespace`, never an IN list, and the entities
 * service's `findMany` filters by `native_id IN` / `outcome IN` — so none of them matches.
 */
const isS9Read = (q: string) =>
  /^\s*SELECT/i.test(q) && /"ImportNativeProvenance"/.test(q) && /"source_namespace" IN \(/.test(q);
const isNoise = (q: string) =>
  /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET |DEALLOCATE|SELECT 1\b)/i.test(q);
/** Statements of each fixture-marked transaction, in order (noise such as BEGIN/COMMIT removed). */
function segments(queries: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const q of queries) {
    if (q === '-- tx:begin') cur = [];
    else if (q === '-- tx:commit' || q === '-- tx:rollback') {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur && !isNoise(q)) cur.push(q);
  }
  return out;
}
/** The settle-tail transaction: the one segment that holds the FOR NO KEY UPDATE lock. */
const tailSegment = (queries: string[]) => segments(queries).find((s) => s.some(isLock)) ?? [];
const stagePlanned = (intentId: string, coach = COACH) => {
  stage(coach, intentId, TOKEN.clients, 'p-1');
  stage(coach, intentId, TOKEN.clients, 'p-2');
  stage(coach, intentId, TOKEN.programs, 'blk-1', PROGRAM);
  stage(coach, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
  stage(coach, intentId, TOKEN.workouts, 'rt-c', {
    ...WORKOUT,
    title: 'Client Push',
    client_id: 'c-1',
  });
  stage(coach, intentId, TOKEN.client_history, 'h-1', { title: 'note' });
};
const started = async (coach = COACH) => {
  const intentId = intent(coach);
  const start = await run({ action: 'start', coach, intent: intentId });
  expect(start.failure).toBeUndefined();
  return intentId;
};
const complete = (intentId: string, terminal_status = 'success', coach = COACH) =>
  run({ ...REGISTRY, action: 'complete', coach, intent: intentId, body: { terminal_status } });
const report = (intentId: string, coach = COACH) =>
  run({ ...REGISTRY, action: 'report', coach, intent: intentId });
const status = (intentId: string, coach = COACH) =>
  run({ ...REGISTRY, action: 'status', coach, intent: intentId });
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort();

beforeEach(() => {
  resetData();
  catalog([{ id: CAT_ID, slug: CAT_SLUG }]);
});
afterAll(() => resetData());

describe('lane identity (bootstrap state, never repaired here)', () => {
  it('is the S9-C disposable PG17 lane at the accepted history through S7-L; S7-L and S8-B objects present', () => {
    const facts =
      jsonAdmin(`SELECT json_build_object('version',current_setting('server_version_num')::int,
      'cluster',current_setting('cluster_name'),'directory',current_setting('data_directory'),
      'port',inet_server_port(),'db',current_database())`);
    expect(facts).toEqual({
      version: expectedVersion,
      cluster: 's9c-disposable-pg17',
      directory,
      port: target.port,
      db: 'g2_s9c_disposable',
    });
    expect(Number(appliedMigrations())).toBe(EXPECTED_MIGRATIONS);
    expect(
      sql(
        `SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC, migration_name DESC LIMIT 1`,
      ),
    ).toBe(S7L_MIGRATION);
    expect(sql(`SELECT to_regclass('public."ImportNativeProvenance"') IS NOT NULL`)).toBe('t');
    for (const column of [
      'mode',
      'phase',
      'execution_epoch',
      'fenced_at',
      'fence_reason',
      'deadline_at',
    ]) {
      expect(
        sql(
          `SELECT count(*) FROM information_schema.columns WHERE table_name='ScoutImport' AND column_name='${column}'`,
        ),
      ).toBe('1');
    }
    expect(
      sqlAdmin(`SELECT count(*) FROM pg_roles WHERE rolname IN ('supabase_admin','authenticator')`),
    ).toBe('0');
  });

  it('is bound to one attested candidate head that descends from the base and adds no migration', () => {
    expect(candidateHead).toMatch(/^[0-9a-f]{40}$/);
    expect(candidateHead).not.toBe(BASE_HEAD);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(
      candidateHead,
    );
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
    expect(() =>
      execFileSync('git', ['merge-base', '--is-ancestor', BASE_HEAD, candidateHead], {
        cwd: root,
        stdio: 'ignore',
      }),
    ).not.toThrow();
    expect(
      execFileSync(
        'git',
        [
          'diff',
          '--stat',
          BASE_HEAD,
          candidateHead,
          '--',
          'prisma/migrations',
          'prisma/schema.prisma',
        ],
        {
          cwd: root,
          encoding: 'utf8',
        },
      ).trim(),
    ).toBe('');
  });

  it('the worker exposes the accepted family list and the S9-C report action on an open run is null', async () => {
    const intentId = await started();
    const result = await status(intentId);
    expect(result.failure).toBeUndefined();
    expect(result.families).toEqual(['clients', 'workouts', 'client_history', 'programs']);
    const open = await report(intentId);
    expect(open.failure).toBeUndefined();
    expect(open.result).toBeNull();
    // An open run has no report: the status entries keep the S7-L shape.
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    const openStatus = await status(intentId);
    expect(openStatus.result.status).toBe('running');
    for (const entry of openStatus.result.families) expect(keysOf(entry)).toEqual(S7L_FAMILY_KEYS);
  });
});

describe('R09 — the settle tail writes the S9 verdict (D-S9-1), never complete, exactly once', () => {
  it('a fully staged run settles partial/unresolved_identities == report.conditions[0]; one terminal write; S9 reads inside the tail transaction only', async () => {
    const intentId = await started();
    stagePlanned(intentId);
    expect(stagedCount(COACH, intentId)).toBe(6);
    const done = await complete(intentId);
    expect(done.failure).toBeUndefined();
    expect(done.result).toEqual(ack(intentId));
    const row = runRow(COACH, intentId);
    expect(row).toMatchObject({
      mode: 'server',
      phase: 'reconciling',
      terminal_status: 'partial',
      state: 'partial',
      reason_code: 'unresolved_identities',
      execution_epoch: 1,
      fenced_at: null,
    });
    expect(row.completed_at).not.toBeNull();
    expect(completionRows()).toEqual([[COACH, intentId, 'success']]);
    // The S8-G pass is unchanged: ledger by token, provenance by family.
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.clients]: { reconstructed: 0, skipped: 2, failed: 0 },
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
      [TOKEN.workouts]: { reconstructed: 2, skipped: 0, failed: 0 },
      [TOKEN.client_history]: { reconstructed: 0, skipped: 1, failed: 0 },
    });
    expect(programs(COACH)).toHaveLength(1);
    // Exactly one terminal write, in the tail transaction, after the lock and after the S9 read;
    // the S9 reader issues no write anywhere in the whole /complete.
    expect(done.queries.filter(isTerminal)).toHaveLength(1);
    const tail = tailSegment(done.queries);
    expect(tail.findIndex(isLock)).toBe(0);
    const s9At = tail.findIndex(isS9Read);
    const terminalAt = tail.findIndex(isTerminal);
    expect(s9At).toBeGreaterThan(0);
    expect(terminalAt).toBe(tail.length - 1);
    expect(s9At).toBeLessThan(terminalAt);
    expect(tail.slice(0, terminalAt).filter(isWrite)).toEqual([]);
    // The S9 reader runs on the SAME transaction as the lock: no S9 read outside the tail.
    expect(done.queries.filter(isS9Read).length).toBe(tail.filter(isS9Read).length);
    // The verdict written IS the recomputed report's verdict (D-S9-1 == D-S9-5 basis).
    const rep = await report(intentId);
    expect(rep.failure).toBeUndefined();
    expect(rep.result).toMatchObject({ report_version: 1, basis: 'recomputed' });
    expect(rep.result.conditions[0]).toBe(row.reason_code);
    expect(rep.result.conditions).toContain('coverage_basis_unknown'); // D-S9-3: unknown, never 0
    expect(rep.result.conditions).not.toContain('unresolved_family'); // every token is mapped
    for (const code of rep.result.conditions) expect(S9_CODES).toContain(code);
    expect(JSON.stringify(done.events)).not.toContain('"complete"');
    const settled = done.events.find((e: any[]) => e[1] === 'scout.run.settled');
    expect(settled[2]).toMatchObject({
      terminal_status: 'partial',
      reason_code: 'unresolved_identities',
    });
    // The report action wrote nothing (S9 writes nothing).
    expect(rep.queries.filter(isWrite)).toEqual([]);
    expect(rep.queries.filter(isLock)).toEqual([]);
    expect(runRow(COACH, intentId)).toEqual(row);
  });

  it('a run of only verified native rows still never settles complete (no S10 basis: coverage_basis_unknown holds)', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    const done = await complete(intentId);
    expect(done.failure).toBeUndefined();
    const row = runRow(COACH, intentId);
    expect(row.terminal_status).toBe('partial');
    expect(row.state).toBe('partial');
    expect(S9_CODES).toContain(row.reason_code);
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
      [TOKEN.workouts]: { reconstructed: 1, skipped: 0, failed: 0 },
    });
    const rep = await report(intentId);
    expect(rep.result.conditions[0]).toBe(row.reason_code);
    expect(rep.result.conditions).toContain('coverage_basis_unknown');
    const blocks = rep.result.families.find((f: any) => f.family === 'programs');
    expect(blocks).toMatchObject({
      mapped: true,
      staged_unique: 1,
      native_present_verified: 1,
      rejected: 0,
      unresolved: 0,
      failed: 0,
      created_native: null,
      already_present_verified: null,
      completeness_basis: 'none',
      observed_unique: null,
    });
    for (const call of done.queries) expect(call).not.toMatch(/'complete'/);
  });

  it('claim failed with zero staged → failed/transfer_failed (claim precedence over the S9 verdict); one terminal write', async () => {
    const empty = await started();
    const b = await complete(empty, 'failed');
    expect(b.failure).toBeUndefined();
    expect(b.queries.filter(isGate)).toHaveLength(1); // the complete's own gate only
    expect(b.queries.filter(isTerminal)).toHaveLength(1);
    expect(runRow(COACH, empty)).toMatchObject({
      terminal_status: 'failed',
      state: 'failed',
      reason_code: 'transfer_failed',
      execution_epoch: 1,
    });
    expect(ledgerRows(COACH, empty)).toEqual([]);
    const st = await status(empty);
    expect(st.result).toMatchObject({ status: 'failed', claimed_status: 'failed', families: [] });

    // Claim failed WITH staged rows: the pass runs and the S9 verdict is the terminal.
    const withRows = await started();
    stage(COACH, withRows, TOKEN.programs, 'blk-1', PROGRAM);
    const c = await complete(withRows, 'failed');
    expect(c.failure).toBeUndefined();
    expect(c.queries.filter(isTerminal)).toHaveLength(1);
    const row = runRow(COACH, withRows);
    expect(row.terminal_status).toBe('partial');
    expect(S9_CODES).toContain(row.reason_code);
    const st2 = await status(withRows);
    expect(st2.result).toMatchObject({ status: 'partial', claimed_status: 'failed' });
  });

  it('a cancel between the pass and the tail lock wins: the tail reads no S9 facts, writes no terminal; a stale settle is a no-op', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    const settle = worker({
      ...REGISTRY,
      action: 'settled',
      coach: COACH,
      intent: intentId,
      pause: 'before-lock',
      body: { epoch: 1 },
    });
    await settle.ready;
    const cancelled = await run({ action: 'cancel', coach: COACH, intent: intentId });
    expect(cancelled.result).toEqual({
      intent_id: intentId,
      status: 'cancelled',
      execution_epoch: 2,
    });
    const fenced = runRow(COACH, intentId);
    settle.resume();
    const done = await settle.done;
    expect(done.failure).toBeUndefined();
    const tail = tailSegment(done.queries);
    expect(tail.filter(isLock)).toHaveLength(1);
    expect(tail.filter(isS9Read)).toEqual([]); // CAS miss: S9 never reads
    expect(tail.filter(isWrite)).toEqual([]);
    expect(done.queries.filter(isTerminal)).toHaveLength(0);
    expect(done.events.map((e: any[]) => e[1])).not.toContain('scout.run.settled');
    expect(runRow(COACH, intentId)).toEqual(fenced);
    expect(fenced).toMatchObject({
      terminal_status: 'cancelled',
      reason_code: 'cancelled_by_coach',
      execution_epoch: 2,
    });
    const stale = await run({
      ...REGISTRY,
      action: 'settled',
      coach: COACH,
      intent: intentId,
      body: { epoch: 1 },
    });
    expect(stale.failure).toBeUndefined();
    expect(tailSegment(stale.queries).filter(isS9Read)).toEqual([]);
    expect(runRow(COACH, intentId)).toEqual(fenced);
    // RC-2: a fenced server terminal still gets a report on read (recomputed, not stored).
    const rep = await report(intentId);
    expect(rep.result).toMatchObject({ report_version: 1, basis: 'recomputed' });
    expect(rep.queries.filter(isWrite)).toEqual([]);
    expect(runRow(COACH, intentId)).toEqual(fenced);
  });
});

describe('R10(C) / R15 — recompute-on-read: the status carries the report additively and replays identically', () => {
  it('status families[] of a settled server run equal the recomputed report per token, carry the six additive keys, and two reads are identical', async () => {
    const intentId = await started();
    stagePlanned(intentId);
    const done = await complete(intentId);
    expect(done.failure).toBeUndefined();
    const first = await status(intentId);
    expect(first.failure).toBeUndefined();
    expect(first.result).toMatchObject({
      status: 'partial',
      mode: 'server',
      claimed_status: 'success',
      reason_code: 'unresolved_identities',
    });
    // One interactive read transaction (the D-S9-5 REPEATABLE READ recompute; the isolation
    // option itself is pinned by the unit spec), no lock, no write on the status path.
    expect(first.queries.filter(isWrite)).toEqual([]);
    expect(first.queries.filter(isLock)).toEqual([]);
    expect(first.queries.filter((q: string) => q === '-- tx:begin')).toHaveLength(1);
    expect(first.queries.filter((q: string) => q === '-- tx:commit')).toHaveLength(1);
    expect(segments(first.queries)[0].some(isS9Read)).toBe(true);
    const provenanceBefore = provenanceRows(COACH);
    const rep = await report(intentId);
    const byToken = new Map<string, any>(first.result.families.map((f: any) => [f.family, f]));
    expect([...byToken.keys()].sort()).toEqual(
      [TOKEN.clients, TOKEN.programs, TOKEN.workouts, TOKEN.client_history].sort(),
    );
    for (const [token, canonical] of [
      [TOKEN.clients, 'clients'],
      [TOKEN.programs, 'programs'],
      [TOKEN.workouts, 'workouts'],
      [TOKEN.client_history, 'client_history'],
    ] as const) {
      const entry = byToken.get(token);
      const fam = rep.result.families.find((f: any) => f.family === canonical);
      expect(fam).toBeDefined();
      expect(keysOf(entry)).toEqual([...S7L_FAMILY_KEYS, ...S9C_FAMILY_KEYS].sort());
      expect(entry).toMatchObject({
        family: token,
        canonical_family: canonical,
        staged_unique: fam.staged_unique,
        native_present_verified: fam.native_present_verified,
        rejected: fam.rejected,
        unresolved: fam.unresolved,
        created_native: null,
        already_present_verified: null,
        observed_unique: null,
        completeness_basis: fam.completeness_basis,
        relationship_closure: fam.relationship_closure,
        reasons: fam.reasons,
        qualifiers: fam.qualifiers,
      });
    }
    // Truthful counts: the rejected clients are rejected, the client-owned evidence row is
    // unresolved, and `clients` carries the interim qualifier (S8-DOC L372-374).
    expect(byToken.get(TOKEN.clients)).toMatchObject({
      staged_unique: 2,
      native_present_verified: 0,
      rejected: 2,
      unresolved: 0,
      reasons: [{ code: `unsupported_platform:${PLATFORM}`, count: 2 }],
      qualifiers: ['roster_bridge_pending'],
    });
    expect(byToken.get(TOKEN.workouts)).toMatchObject({
      staged_unique: 2,
      native_present_verified: 1,
      unresolved: 1,
      reasons: [{ code: 'unresolved:no_native_client_principal', count: 1 }],
      qualifiers: [],
    });
    expect(byToken.get(TOKEN.programs)).toMatchObject({
      staged_unique: 1,
      native_present_verified: 1,
      rejected: 0,
      unresolved: 0,
    });
    // R10(C): replay — a second status read and a second report are byte-identical.
    const second = await status(intentId);
    expect(second.result).toEqual(first.result);
    const rep2 = await report(intentId);
    expect(rep2.result).toEqual(rep.result);
    expect(provenanceRows(COACH)).toEqual(provenanceBefore);
    expect(ledgerRows(COACH, intentId)).toHaveLength(6);
    expect(Buffer.byteLength(JSON.stringify(first.result), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('R13: a settled legacy row never asks for a report; its status families[] keep exactly the S7-L keys', async () => {
    legacyRun(COACH, LEGACY_INTENT, 'success');
    stage(COACH, LEGACY_INTENT, 'workouts', 'rt-1', WORKOUT);
    stage(COACH, LEGACY_INTENT, 'workouts', 'rt-2', { ...WORKOUT, title: 'Pull Day' });
    const first = await run({
      ...REGISTRY,
      action: 'reconstruct',
      family: 'workouts',
      coach: COACH,
      intent: LEGACY_INTENT,
    });
    expect(first.failure).toBeUndefined();
    const st = await status(LEGACY_INTENT);
    expect(st.failure).toBeUndefined();
    expect(st.result).toMatchObject({
      mode: 'legacy',
      status: 'success',
      claimed_status: 'success',
    });
    expect(st.result.families).toHaveLength(1);
    expect(keysOf(st.result.families[0])).toEqual(S7L_FAMILY_KEYS);
    expect(st.result.families[0]).toMatchObject({
      family: 'workouts',
      staged_unique: 2,
      ledger: { reconstructed: 2, skipped: 0, failed: 0 },
    });
    expect(st.queries.filter(isS9Read)).toEqual([]);
    expect(st.queries.filter((q: string) => q === '-- tx:begin')).toEqual([]);
    const rep = await report(LEGACY_INTENT);
    expect(rep.result).toBeNull();
  });
});

describe('R11 — tenant isolation of the S9 reads (no cross-tenant reads or writes)', () => {
  it("A's settle verdict and report count only A's rows; B's open run stays open with S7-L entries; anon/authenticated are refused", async () => {
    const a = await started(COACH);
    const b = await started(OTHER);
    stage(COACH, a, TOKEN.programs, 'blk-1', PROGRAM);
    stage(OTHER, b, TOKEN.programs, 'blk-1', PROGRAM);
    stage(OTHER, b, TOKEN.programs, 'blk-2', { ...PROGRAM, title: 'Other Block' });
    stage(OTHER, b, TOKEN.workouts, 'rt-1', WORKOUT);
    const done = await complete(a);
    expect(done.failure).toBeUndefined();
    expect(ledgerRows(OTHER, b)).toEqual([]);
    expect(provenanceRows(OTHER)).toEqual([]);
    expect(programs(OTHER)).toEqual([]);
    expect(programs(COACH)).toHaveLength(1);
    expect(runRow(OTHER, b)).toMatchObject({ terminal_status: null, execution_epoch: 1 });
    const rep = await report(a);
    // D-S9-2: required_families = A's staged families plus every family the staged platform's spec
    // declares, so A's report also carries zero-row entries for the families A never staged. None of
    // B's rows (blk-1, blk-2, rt-1) may appear in any count of A's report.
    expect(rep.result.families.map((f: any) => f.family)).toEqual([
      'client_history',
      'clients',
      'programs',
      'workouts',
    ]);
    for (const fam of rep.result.families) {
      expect(fam).toMatchObject(
        fam.family === 'programs'
          ? { staged_unique: 1, native_present_verified: 1 }
          : { staged_unique: 0, native_present_verified: 0 },
      );
    }
    const st = await status(a);
    expect(st.result.families).toHaveLength(1);
    expect(st.result.families[0]).toMatchObject({
      family: TOKEN.programs,
      canonical_family: 'programs',
      staged_unique: 1,
    });
    // B's open run: no report, S7-L entries, and A's settle changed nothing of B's.
    const other = await status(b, OTHER);
    expect(other.result.status).toBe('running');
    for (const entry of other.result.families) expect(keysOf(entry)).toEqual(S7L_FAMILY_KEYS);
    expect(await report(b, OTHER).then((r) => r.result)).toBeNull();
    // After B settles, B's report counts B's rows only (2 programs + 1 workout), never A's.
    const doneB = await complete(b, 'success', OTHER);
    expect(doneB.failure).toBeUndefined();
    const repB = await report(b, OTHER);
    expect(repB.result.families.find((f: any) => f.family === 'programs')).toMatchObject({
      staged_unique: 2,
    });
    expect(repB.result.families.find((f: any) => f.family === 'workouts')).toMatchObject({
      staged_unique: 1,
    });
    expect(programs(COACH)).toHaveLength(1);
    expect(runRow(COACH, a).execution_epoch).toBe(1);
    for (const role of ['anon', 'authenticated']) {
      expect(sql(`SET ROLE ${role}; SELECT count(*) FROM "ScoutReconstructionLedger"`)).toBe('0');
      refused(
        `SET ROLE ${role}; SELECT count(*) FROM "ImportNativeProvenance"`,
        'permission denied',
      );
    }
    sqlAs(
      'service_role',
      `BEGIN; INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_platform,source_id,status)
       VALUES ('rb-1',${quote(COACH)},${quote(a)},'blocks',${quote(PLATFORM)},'rb','skipped'); ROLLBACK;`,
    );
    expect(ledgerRows(COACH, a)).toHaveLength(1);
  });
});
