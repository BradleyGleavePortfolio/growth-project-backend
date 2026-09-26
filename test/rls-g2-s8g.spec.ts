/**
 * G2-S8-G live PostgreSQL 17 proof (explicitly guarded; run only through jest.rls.config.js on the
 * S8-G disposable lane bootstrapped by test/utils/g2-s8g-bootstrap.sh, never in the default suite).
 *
 * Exercises the REAL settle path — ScoutService.complete → ScoutLifecycleService.onTransferSettled
 * → ScoutReconstructService.reconstructRun → S7-L arbitration — in independent OS processes
 * (test/utils/g2-s8g-worker.cjs) with the owned family registry AND planner mappers injected from
 * the fixture spec + rule set, against the accepted S7-L run objects and S8-B provenance objects
 * on the base 62471b11 schema (S8-G ships no migration; identical to 1c5fbb04). Every assertion reads the database
 * through psql as the fixture owner. The fixture platform's staged tokens (`people`, `blocks`,
 * `routines`, `log`) deliberately differ from the family names so token forwarding is observable.
 *
 * Fixture facts that shape expectations (accepted S8-A/S8-C behaviour, not S8-G's to change):
 * the `clients` and `client_history` families resolve their mapper through the ACCEPTED registry,
 * so fixture-platform rows of those tokens ledger `skipped` `unsupported_platform:s8g-proof`; the
 * native `programs`/`workouts` families use the injected mappers and land real targets.
 */
import { execFileSync } from 'child_process';
import { RECONSTRUCT_MAX_ROWS } from '../src/scout/scout-reconstruct.dto';
import {
  catalog,
  completionRows,
  count,
  evidenceRows,
  expire,
  intent,
  ledgerByToken,
  ledgerRows,
  legacyRun,
  PLATFORM,
  plans,
  programs,
  provenanceRows,
  REGISTRY,
  resetData,
  runRow,
  stage,
  stagedCount,
  targetSnapshot,
  TOKEN,
  TOKEN_ORDER,
} from './utils/g2-s8g-harness';
import {
  appliedMigrations,
  BASE_HEAD,
  blocked,
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
} from './utils/g2-s8g-pg-harness';

jest.setTimeout(300000);

const COACH = 'coach';
const OTHER = 'other-coach';
const LEGACY_INTENT = 'intent_legacy_s8g';
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
const conflict = (code: string, extra: Record<string, unknown> = {}) =>
  expect.objectContaining({ status: 409, response: expect.objectContaining({ code, ...extra }) });

/* ---- query-log helpers (statement shapes only; the worker never logs parameters) ---- */
const isGate = (q: string) => /SET last_observed_at\s*=/.test(q);
const isLock = (q: string) => q.includes('FOR NO KEY UPDATE');
const isTerminal = (q: string) => q.includes('SET terminal_status = ');
const isFence = (q: string) => q.includes('SET fenced_at = ');
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
const firstIndex = (queries: string[], re: RegExp) => queries.findIndex((q) => re.test(q));
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

beforeEach(() => {
  resetData();
  catalog([{ id: CAT_ID, slug: CAT_SLUG }]);
});
afterAll(() => resetData());

describe('lane identity (bootstrap state, never repaired here)', () => {
  it('is the S8-G disposable PG17 lane at the accepted history through S7-L; S7-L and S8-B objects present', () => {
    const facts =
      jsonAdmin(`SELECT json_build_object('version',current_setting('server_version_num')::int,
      'cluster',current_setting('cluster_name'),'directory',current_setting('data_directory'),
      'port',inet_server_port(),'db',current_database())`);
    expect(facts).toEqual({
      version: expectedVersion,
      cluster: 's8g-disposable-pg17',
      directory,
      port: target.port,
      db: 'g2_s8g_disposable',
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

  it('the worker exposes the accepted family list and resolves fixture tokens through the injected planner', async () => {
    const result = await run({
      ...REGISTRY,
      action: 'status',
      coach: COACH,
      intent: intent(COACH),
    });
    expect(result.families).toEqual(['clients', 'workouts', 'client_history', 'programs']);
  });
});

describe('P01 — open run, /complete → one ordered pass → truthful terminal (G01)', () => {
  it('reconstructs every staged token in §3.8 order, forwards tokens into the ledger, settles partial/reconciliation_not_performed', async () => {
    const intentId = await started();
    for (const [token, entities] of [
      [
        TOKEN.clients,
        [
          { sourceId: 'p-1', payload: { name: 'A' } },
          { sourceId: 'p-2', payload: { name: 'B' } },
        ],
      ],
      [TOKEN.programs, [{ sourceId: 'blk-1', payload: PROGRAM }]],
      [
        TOKEN.workouts,
        [
          { sourceId: 'rt-1', payload: WORKOUT },
          { sourceId: 'rt-c', payload: { ...WORKOUT, title: 'Client Push', client_id: 'c-1' } },
        ],
      ],
      [TOKEN.client_history, [{ sourceId: 'h-1', payload: { title: 'note' } }]],
    ] as const) {
      const ingest = await run({
        action: 'ingest',
        coach: COACH,
        intent: intentId,
        body: { entity_type: token, entities },
      });
      expect(ingest.failure).toBeUndefined();
    }
    expect(stagedCount(COACH, intentId)).toBe(6);
    const done = await run({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: intentId,
      body: { terminal_status: 'success' },
    });
    expect(done.failure).toBeUndefined();
    expect(done.result).toEqual(ack(intentId));
    const row = runRow(COACH, intentId);
    expect(row).toMatchObject({
      mode: 'server',
      phase: 'reconciling',
      terminal_status: 'partial',
      state: 'partial',
      reason_code: 'reconciliation_not_performed',
      execution_epoch: 1,
      fenced_at: null,
    });
    expect(row.completed_at).not.toBeNull();
    expect(completionRows()).toEqual([[COACH, intentId, 'success']]);
    // Ledger carries the staged TOKEN (not the family) and covers every staged row.
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.clients]: { reconstructed: 0, skipped: 2, failed: 0 },
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
      [TOKEN.workouts]: { reconstructed: 2, skipped: 0, failed: 0 },
      [TOKEN.client_history]: { reconstructed: 0, skipped: 1, failed: 0 },
    });
    const ledger = ledgerRows(COACH, intentId);
    expect(ledger.find((r) => r.source_id === 'p-1')).toMatchObject({
      entity_type: TOKEN.clients,
      status: 'skipped',
      reason: `unsupported_platform:${PLATFORM}`,
    });
    expect(ledger.find((r) => r.source_id === 'rt-1')).toMatchObject({
      entity_type: TOKEN.workouts,
      status: 'reconstructed',
      target_kind: 'workout_plan',
    });
    expect(ledger.find((r) => r.source_id === 'rt-c')).toMatchObject({
      entity_type: TOKEN.workouts,
      status: 'reconstructed',
      target_kind: 'scout_entity',
    });
    expect(ledger.find((r) => r.source_id === 'blk-1')).toMatchObject({
      entity_type: TOKEN.programs,
      status: 'reconstructed',
      target_kind: 'workout_program',
    });
    // Native targets + provenance (provenance is keyed by the canonical family).
    expect(programs(COACH)).toHaveLength(1);
    expect(plans(COACH)).toHaveLength(1);
    expect(evidenceRows(COACH)).toEqual([
      { entity_type: 'workouts', source_id: 'rt-c', label: 'Client Push', client_source_id: 'c-1' },
    ]);
    const provenance = provenanceRows(COACH);
    expect(provenance.find((p) => p.source_id === 'blk-1')).toMatchObject({
      entity_type: 'programs',
      native_kind: 'workout_program',
      outcome: 'created',
      source_namespace: PLATFORM,
    });
    expect(provenance.find((p) => p.source_id === 'rt-c')).toMatchObject({
      outcome: 'unresolved',
      reason: 'unresolved:no_native_client_principal',
    });
    expect(count('Person')).toBe(0);
    expect(count('ClientWorkoutAssignment')).toBe(0);
    expect(count('Notification')).toBe(0);
    // §3.8 order in the writer's own log: first clients ledger write < first program insert <
    // first plan insert < the client_history ledger write (its rows skip, so the ledger is the trace).
    const q = done.queries;
    const clientsLedgerAt = firstIndex(q, /"ScoutReconstructionLedger"/);
    const programAt = firstIndex(q, /INSERT INTO "public"\."WorkoutProgram"/);
    const planAt = firstIndex(q, /INSERT INTO "public"\."WorkoutPlan" /);
    expect(clientsLedgerAt).toBeGreaterThanOrEqual(0);
    expect(programAt).toBeGreaterThan(clientsLedgerAt);
    expect(planAt).toBeGreaterThan(programAt);
    // Events: the accepted complete event, one reconstruct completion per planned token, one settle.
    const names = done.events.map((e) => e[1]);
    expect(names).toEqual(
      expect.arrayContaining([
        'scout.ingest.completed',
        'scout.reconstruct.completed',
        'scout.run.settled',
      ]),
    );
    expect(
      done.events
        .filter((e) => e[1] === 'scout.reconstruct.completed')
        .map((e) => e[2].entity_type),
    ).toEqual(TOKEN_ORDER);
    const settled = done.events.find((e) => e[1] === 'scout.run.settled');
    expect(settled[2]).toMatchObject({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
    expect(JSON.stringify(done.events)).not.toContain('"complete"');
    // G12: exactly one push for the whole /complete (S7-L's accepted notifyComplete), no side-effect loads.
    expect(done.pushes).toBe(1);
    expect(Object.values(done.sideEffectLoads).every((n) => n === 0)).toBe(true);
    // Status read after settle.
    const status = await run({ action: 'status', coach: COACH, intent: intentId });
    expect(status.result).toMatchObject({
      status: 'partial',
      mode: 'server',
      claimed_status: 'success',
      reason_code: 'reconciliation_not_performed',
    });
  });
});

describe('P02 — the gate is the first statement of every per-row transaction; the legacy route never gates (G02/G08)', () => {
  it('server pass: gate-first for success, skip, failure and unmapped outcomes; one gate per staged row; no lock inside the pass', async () => {
    const intentId = await started();
    stagePlanned(intentId);
    stage(COACH, intentId, 'notes', 'n-1');
    stage(COACH, intentId, 'notes', 'n-2');
    const pass = await run({
      ...REGISTRY,
      action: 'run-pass',
      coach: COACH,
      intent: intentId,
      mapper: 'throw',
      family: 'programs',
    });
    expect(pass.failure).toBeUndefined();
    expect(pass.result).toMatchObject({ stopped: null, unmapped_families: ['notes'] });
    const segs = segments(pass.queries);
    expect(segs).toHaveLength(8);
    for (const seg of segs) expect(isGate(seg[0])).toBe(true);
    expect(pass.queries.filter(isGate)).toHaveLength(8);
    expect(pass.queries.filter(isLock)).toHaveLength(0);
    expect(pass.queries.filter(isTerminal)).toHaveLength(0);
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.clients]: { reconstructed: 0, skipped: 2, failed: 0 },
      [TOKEN.programs]: { reconstructed: 0, skipped: 0, failed: 1 },
      [TOKEN.workouts]: { reconstructed: 2, skipped: 0, failed: 0 },
      [TOKEN.client_history]: { reconstructed: 0, skipped: 1, failed: 0 },
      notes: { reconstructed: 0, skipped: 2, failed: 0 },
    });
    const failedRow = ledgerRows(COACH, intentId).find((r) => r.source_id === 'blk-1');
    expect(failedRow).toMatchObject({ status: 'failed', reason: 'error:Error' });
    expect(
      ledgerRows(COACH, intentId)
        .filter((r) => r.entity_type === 'notes')
        .map((r) => r.reason),
    ).toEqual(['unresolved_family:notes', 'unresolved_family:notes']);
    expect(count('WorkoutProgram')).toBe(0);
    // The pass never touches the run's terminal fields.
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: null,
      fenced_at: null,
      execution_epoch: 1,
    });
  });

  it('legacy coach-JWT reconstruct on a settled legacy run: no gate, no lock, family-named ledger, replay byte-identical', async () => {
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
    expect(first.result).toEqual({
      intent_id: LEGACY_INTENT,
      staged: 2,
      reconstructed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(first.queries.filter(isGate)).toHaveLength(0);
    expect(first.queries.filter(isLock)).toHaveLength(0);
    expect(ledgerRows(COACH, LEGACY_INTENT).map((r) => r.entity_type)).toEqual([
      'workouts',
      'workouts',
    ]);
    const snapshot = targetSnapshot(COACH, LEGACY_INTENT);
    const replay = await run({
      ...REGISTRY,
      action: 'reconstruct',
      family: 'workouts',
      coach: COACH,
      intent: LEGACY_INTENT,
    });
    expect(replay.result).toEqual(first.result);
    expect(targetSnapshot(COACH, LEGACY_INTENT)).toEqual(snapshot);
    expect(replay.queries.join('\n')).not.toMatch(/INSERT INTO "public"\."WorkoutPlan" /);
    expect(runRow(COACH, LEGACY_INTENT)).toMatchObject({
      mode: 'legacy',
      terminal_status: 'success',
      state: 'success',
    });
  });
});

describe('P03/P04 — cancel during the pass (G03/G04)', () => {
  it('P03: cancel between rows — rows before the fence are kept, nothing further is written, no fabricated failed', async () => {
    const intentId = await started();
    stagePlanned(intentId);
    const pass = worker({
      ...REGISTRY,
      action: 'settled',
      coach: COACH,
      intent: intentId,
      pause: 'after-row',
      pauseRow: 2,
      body: { epoch: 1 },
    });
    await pass.ready;
    const afterTwo = targetSnapshot(COACH, intentId);
    expect(afterTwo.ledger).toHaveLength(2);
    const cancelled = await run({ action: 'cancel', coach: COACH, intent: intentId });
    expect(cancelled.failure).toBeUndefined();
    expect(cancelled.result).toEqual({
      intent_id: intentId,
      status: 'cancelled',
      execution_epoch: 2,
    });
    pass.resume();
    const done = await pass.done;
    expect(done.failure).toBeUndefined();
    // The pass stopped at row 3: its gate saw zero rows and the transaction rolled back.
    const q = done.queries;
    const gates = q.filter(isGate);
    expect(gates).toHaveLength(3);
    const lastGateAt = q.lastIndexOf(gates[2]);
    expect(q.slice(lastGateAt + 1).find((s) => s.startsWith('-- tx:'))).toBe('-- tx:rollback');
    expect(q.filter(isTerminal)).toHaveLength(0);
    expect(cancelled.queries.filter(isTerminal)).toHaveLength(1);
    expect(done.events.map((e) => e[1])).not.toContain('scout.run.settled');
    // Nothing further landed; the row snapshot after row 2 is the final snapshot.
    expect(targetSnapshot(COACH, intentId)).toEqual(afterTwo);
    expect(ledgerRows(COACH, intentId).filter((r) => r.status === 'failed')).toEqual([]);
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: 'cancelled',
      state: 'cancelled',
      fence_reason: 'cancelled',
      reason_code: 'cancelled_by_coach',
      execution_epoch: 2,
    });
  });

  it('P04: cancel racing an in-flight gated row waits on the row lock (no 40P01); row k commits and counts; the next gate stops the pass', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    const pass = worker({
      ...REGISTRY,
      action: 'run-pass',
      coach: COACH,
      intent: intentId,
      pause: 'gated',
      txTimeout: 30000,
    });
    await pass.ready;
    const cancel = worker({ action: 'cancel', coach: COACH, intent: intentId });
    await blocked(cancel.name);
    expect(ledgerRows(COACH, intentId)).toEqual([]);
    // The gated row's phase move is uncommitted: the owner still reads the pre-gate phase.
    expect(runRow(COACH, intentId)).toMatchObject({ fenced_at: null, phase: 'discovering' });
    pass.resume();
    const done = await pass.done;
    const cancelled = await cancel.done;
    expect(done.failure).toBeUndefined();
    expect(cancelled.failure).toBeUndefined();
    expect(done.result).toMatchObject({ stopped: 'gate_closed' });
    expect(cancelled.result).toEqual({
      intent_id: intentId,
      status: 'cancelled',
      execution_epoch: 2,
    });
    expect(programs(COACH)).toHaveLength(1);
    expect(plans(COACH)).toHaveLength(0);
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
    });
    expect(done.queries.filter(isGate)).toHaveLength(2);
    expect(done.failure?.code).not.toBe('40P01');
    expect(cancelled.failure?.code).not.toBe('40P01');
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: 'cancelled',
      execution_epoch: 2,
    });
  });
});

describe('P05 — deadline passes mid-pass (G05)', () => {
  it('the next gate sees zero rows, the pass rolls back, classifyClosed fences timed_out in a new transaction, the tail CAS misses', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    const settle = worker({
      ...REGISTRY,
      action: 'settled',
      coach: COACH,
      intent: intentId,
      pause: 'after-row',
      pauseRow: 1,
      body: { epoch: 1 },
    });
    await settle.ready;
    expire(COACH, intentId);
    settle.resume();
    const done = await settle.done;
    expect(done.failure).toBeUndefined();
    const q = done.queries;
    const gates = q.filter(isGate);
    expect(gates).toHaveLength(2);
    const gateAt = q.lastIndexOf(gates[1]);
    const rollbackAt = q.findIndex((s, i) => i > gateAt && s === '-- tx:rollback');
    const beginAt = q.findIndex((s, i) => i > rollbackAt && s === '-- tx:begin');
    const lockAt = q.findIndex((s, i) => i > beginAt && isLock(s));
    expect(rollbackAt).toBeGreaterThan(gateAt);
    expect(beginAt).toBeGreaterThan(rollbackAt);
    expect(lockAt).toBeGreaterThan(beginAt);
    expect(q.filter(isFence)).toHaveLength(1);
    expect(q.filter(isTerminal)).toHaveLength(1); // the fence's; the tail's CAS on epoch 1 misses
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: 'timed_out',
      state: 'timed_out',
      fence_reason: 'timed_out',
      reason_code: 'deadline_exceeded',
      execution_epoch: 2,
    });
    expect(programs(COACH)).toHaveLength(1);
    expect(plans(COACH)).toHaveLength(0);
    expect(done.events.map((e) => e[1])).toContain('scout.run.fenced');
    expect(done.events.map((e) => e[1])).not.toContain('scout.run.settled');
  });
});

describe('P06 — claim vs truth (G06)', () => {
  it('claim failed with zero staged → failed/transfer_failed and no pass; claim failed with staged rows → the pass runs, partial', async () => {
    const empty = await started();
    const b = await run({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: empty,
      body: { terminal_status: 'failed' },
    });
    expect(b.failure).toBeUndefined();
    expect(b.queries.filter(isGate)).toHaveLength(1); // the complete's own gate only
    expect(runRow(COACH, empty)).toMatchObject({
      terminal_status: 'failed',
      reason_code: 'transfer_failed',
      execution_epoch: 1,
    });
    expect(ledgerRows(COACH, empty)).toEqual([]);

    const withRows = await started();
    stage(COACH, withRows, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, withRows, TOKEN.workouts, 'rt-1', WORKOUT);
    const c = await run({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: withRows,
      body: { terminal_status: 'failed' },
    });
    expect(c.failure).toBeUndefined();
    expect(c.queries.filter(isGate)).toHaveLength(3);
    expect(runRow(COACH, withRows)).toMatchObject({
      terminal_status: 'partial',
      reason_code: 'reconciliation_not_performed',
    });
    const status = await run({ action: 'status', coach: COACH, intent: withRows });
    expect(status.result).toMatchObject({ status: 'partial', claimed_status: 'failed' });
  });
});

describe('P07 — duplicate and late /complete (G07)', () => {
  it('a concurrent second claim is a no-op ack with no pass of its own; exactly one completion row and one terminal write', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    // pauseRow 2: the complete's own gated transaction is the first committed gated transaction.
    const first = worker({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: intentId,
      pause: 'after-row',
      pauseRow: 2,
      body: { terminal_status: 'success' },
    });
    await first.ready;
    const second = await run({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: intentId,
      body: { terminal_status: 'failed' },
    });
    expect(second.result).toEqual(ack(intentId));
    expect(second.queries.filter(isGate)).toHaveLength(1);
    expect(second.queries.filter(isLock)).toHaveLength(0);
    expect(second.queries.filter(isTerminal)).toHaveLength(0);
    expect(second.queries).toContain('-- tx:rollback');
    expect(second.pushes).toBe(0);
    first.resume();
    const done = await first.done;
    expect(done.result).toEqual(ack(intentId));
    expect(completionRows()).toEqual([[COACH, intentId, 'success']]);
    expect(done.queries.filter(isTerminal)).toHaveLength(1);
    expect(done.queries.filter(isGate)).toHaveLength(3);
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: 'partial',
      execution_epoch: 1,
    });
    // Late claim after terminal: ack, row byte-equal, no pass.
    const rowAfter = runRow(COACH, intentId);
    const late = await run({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: intentId,
      body: { terminal_status: 'failed' },
    });
    expect(late.result).toEqual(ack(intentId));
    expect(late.queries.filter(isGate)).toHaveLength(1);
    expect(late.queries.filter(isTerminal)).toHaveLength(0);
    expect(runRow(COACH, intentId)).toEqual(rowAfter);
    expect(completionRows()).toEqual([[COACH, intentId, 'success']]);
  });

  it('/complete without a Start is 409 run_not_started: no completion row, no pass', async () => {
    const intentId = intent(COACH);
    const none = await run({ ...REGISTRY, action: 'complete', coach: COACH, intent: intentId });
    expect(none).toMatchObject({ failure: conflict('run_not_started') });
    expect(completionRows()).toEqual([]);
    expect(none.queries.filter(isLock)).toHaveLength(0);
  });
});

describe('P09 — the post-settle gate and readers during reconciling (G09)', () => {
  it('coach-JWT reconstruct is 409 during the pass; after the terminal it runs and replays idempotently; status reads running then partial', async () => {
    const intentId = await started();
    // A family-named token: the fixture spec declares no `workouts` step, so the PASS ledgers it
    // `unresolved_family:workouts`, while the legacy route (which selects by family name) can
    // address it afterwards — the two routes stay observably distinct on one run.
    stage(COACH, intentId, 'workouts', 'rt-1', WORKOUT);
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    const settle = worker({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: intentId,
      pause: 'after-row',
      pauseRow: 2,
      body: { terminal_status: 'success' },
    });
    await settle.ready;
    const during = await run({
      ...REGISTRY,
      action: 'reconstruct',
      family: 'workouts',
      coach: COACH,
      intent: intentId,
    });
    expect(during.failure).toMatchObject({
      status: 409,
      message: 'scout import intent has not settled; reconstruction is post-settle only',
    });
    expect(during.queries.filter(isGate)).toHaveLength(0);
    const running = await run({ action: 'status', coach: COACH, intent: intentId });
    expect(running.result).toMatchObject({
      status: 'running',
      mode: 'server',
      phase: 'reconciling',
    });
    settle.resume();
    const done = await settle.done;
    expect(done.failure).toBeUndefined();
    expect(runRow(COACH, intentId)).toMatchObject({ terminal_status: 'partial' });
    expect(ledgerRows(COACH, intentId).find((r) => r.source_id === 'rt-1')).toMatchObject({
      entity_type: 'workouts',
      status: 'skipped',
      reason: 'unresolved_family:workouts',
    });
    const first = await run({
      ...REGISTRY,
      action: 'reconstruct',
      family: 'workouts',
      coach: COACH,
      intent: intentId,
    });
    expect(first.failure).toBeUndefined();
    expect(first.result).toEqual({
      intent_id: intentId,
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(first.queries.filter(isGate)).toHaveLength(0);
    const snapshot = targetSnapshot(COACH, intentId);
    const second = await run({
      ...REGISTRY,
      action: 'reconstruct',
      family: 'workouts',
      coach: COACH,
      intent: intentId,
    });
    expect(second.result).toEqual(first.result);
    expect(targetSnapshot(COACH, intentId)).toEqual(snapshot);
    expect(plans(COACH)).toHaveLength(1);
  });
});

describe('P10 — unmapped token and over-ceiling source (G10)', () => {
  it('unmapped notes rows ledger skipped with the S8-A reason; status lists the token; terminal partial', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, 'notes', 'n-1');
    stage(COACH, intentId, 'notes', 'n-2');
    const done = await run({ ...REGISTRY, action: 'complete', coach: COACH, intent: intentId });
    expect(done.failure).toBeUndefined();
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
      notes: { reconstructed: 0, skipped: 2, failed: 0 },
    });
    expect(
      ledgerRows(COACH, intentId)
        .filter((r) => r.entity_type === 'notes')
        .every((r) => r.reason === 'unresolved_family:notes'),
    ).toBe(true);
    expect(runRow(COACH, intentId)).toMatchObject({ terminal_status: 'partial' });
    const status = await run({ action: 'status', coach: COACH, intent: intentId });
    expect(status.result.families).toEqual(
      expect.arrayContaining([expect.objectContaining({ family: 'notes', staged_unique: 2 })]),
    );
  });

  it('an over-ceiling source is isolated: no target, no ledger for it; the other family runs; one terminal write', async () => {
    const intentId = await started();
    const max = RECONSTRUCT_MAX_ROWS + 1; // fixture rows inserted directly as the owner, never through ingest
    sql(`INSERT INTO "ScoutIngestEntity" (id,coach_id,intent_id,entity_type,source_id,source_platform,payload)
      SELECT ${quote(`${COACH}-${intentId}-bulk-`)}||g, ${quote(COACH)}, ${quote(intentId)}, ${quote(TOKEN.programs)}, 'bulk-'||g, ${quote(PLATFORM)}, '{"title":"x"}'::jsonb
      FROM generate_series(1,${max}) g`);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    const pass = await run({ ...REGISTRY, action: 'run-pass', coach: COACH, intent: intentId });
    expect(pass.failure).toBeUndefined();
    expect(pass.result.stopped).toBeNull();
    expect(pass.result.families.find((f: any) => f.token === TOKEN.programs)).toMatchObject({
      stopped: 'over_ceiling',
      staged: max,
      reconstructed: 0,
    });
    expect(pass.result.families.find((f: any) => f.token === TOKEN.workouts)).toMatchObject({
      stopped: null,
      reconstructed: 1,
    });
    expect(count('WorkoutProgram')).toBe(0);
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.workouts]: { reconstructed: 1, skipped: 0, failed: 0 },
    });
    expect(pass.queries.filter(isGate)).toHaveLength(1);
    const done = await run({ ...REGISTRY, action: 'complete', coach: COACH, intent: intentId });
    expect(done.failure).toBeUndefined();
    expect(done.queries.filter(isTerminal)).toHaveLength(1);
    expect(runRow(COACH, intentId)).toMatchObject({ terminal_status: 'partial' });
  });
});

describe('P11 — tenant isolation, RLS, rollback (G11)', () => {
  it("A's pass never reads B's rows; anon/authenticated are refused by policy; a rolled-back service_role write persists nothing", async () => {
    const a = await started(COACH);
    const b = await started(OTHER);
    stage(COACH, a, TOKEN.programs, 'blk-1', PROGRAM);
    stage(OTHER, b, TOKEN.programs, 'blk-1', PROGRAM);
    stage(OTHER, b, TOKEN.workouts, 'rt-1', WORKOUT);
    const done = await run({ ...REGISTRY, action: 'complete', coach: COACH, intent: a });
    expect(done.failure).toBeUndefined();
    expect(ledgerRows(OTHER, b)).toEqual([]);
    expect(provenanceRows(OTHER)).toEqual([]);
    expect(programs(OTHER)).toEqual([]);
    expect(programs(COACH)).toHaveLength(1);
    expect(runRow(OTHER, b)).toMatchObject({ terminal_status: null, execution_epoch: 1 });
    const ledgerCount = count('ScoutReconstructionLedger');
    const provenanceCount = count('ImportNativeProvenance');
    for (const role of ['anon', 'authenticated']) {
      expect(sql(`SET ROLE ${role}; SELECT count(*) FROM "ScoutReconstructionLedger"`)).toBe('0');
      refused(
        `SET ROLE ${role}; SELECT count(*) FROM "ImportNativeProvenance"`,
        'permission denied',
      );
      refused(
        `SET ROLE ${role}; INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_platform,source_id,status)
         VALUES ('rls-${role}',${quote(COACH)},${quote(a)},'blocks',${quote(PLATFORM)},'rls','skipped')`,
        'row-level security',
      );
    }
    sqlAs(
      'service_role',
      `BEGIN; INSERT INTO "ScoutReconstructionLedger" (id,coach_id,intent_id,entity_type,source_platform,source_id,status)
       VALUES ('rb-1',${quote(COACH)},${quote(a)},'blocks',${quote(PLATFORM)},'rb','skipped'); ROLLBACK;`,
    );
    expect(count('ScoutReconstructionLedger')).toBe(ledgerCount);
    expect(count('ImportNativeProvenance')).toBe(provenanceCount);
  });
});

describe('P12 — zero side effects (G12)', () => {
  it('a replayed run-pass over a settled run loads no side-effect module and pushes nothing; targets unchanged', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    const done = await run({ ...REGISTRY, action: 'complete', coach: COACH, intent: intentId });
    expect(done.pushes).toBe(1);
    const snapshot = targetSnapshot(COACH, intentId);
    // The run is terminal: every gate of a replayed pass closes immediately; nothing is written.
    const replay = await run({ ...REGISTRY, action: 'run-pass', coach: COACH, intent: intentId });
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toMatchObject({ stopped: 'gate_closed' });
    expect(replay.pushes).toBe(0);
    expect(Object.values(replay.sideEffectLoads).every((n) => n === 0)).toBe(true);
    expect(Object.values(done.sideEffectLoads).every((n) => n === 0)).toBe(true);
    expect(targetSnapshot(COACH, intentId)).toEqual(snapshot);
    expect(count('ClientWorkoutAssignment')).toBe(0);
    expect(count('Notification')).toBe(0);
  });
});

describe('P13 — interrupted pass (G13)', () => {
  it('a killed pass leaves the run reconciling until the deadline poll fences timed_out; a new run replays without duplicates', async () => {
    const intentId = await started();
    stage(COACH, intentId, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, intentId, TOKEN.workouts, 'rt-1', WORKOUT);
    const settle = worker({
      ...REGISTRY,
      action: 'complete',
      coach: COACH,
      intent: intentId,
      pause: 'after-row',
      pauseRow: 2,
      body: { terminal_status: 'success' },
    });
    await settle.ready;
    settle.stop();
    // The interrupted worker's exit is the expected outcome here; its rejection is recorded, not swallowed silently.
    const interrupted = await settle.done.then(
      () => 'exited',
      (err: unknown) => `rejected:${String(err)}`,
    );
    expect(interrupted).toBeDefined();
    expect(runRow(COACH, intentId)).toMatchObject({
      phase: 'reconciling',
      terminal_status: null,
      execution_epoch: 1,
    });
    expect(programs(COACH)).toHaveLength(1);
    expect(plans(COACH)).toHaveLength(0);
    expire(COACH, intentId);
    const poll = await run({ action: 'status', coach: COACH, intent: intentId });
    expect(poll.result).toMatchObject({
      status: 'timed_out',
      reason_code: 'deadline_exceeded',
      execution_epoch: 2,
    });
    expect(runRow(COACH, intentId)).toMatchObject({
      terminal_status: 'timed_out',
      execution_epoch: 2,
    });
    const [program] = programs(COACH);
    // Run 2 over the same source identifiers: the native writer verifies the existing targets.
    const second = await started();
    stage(COACH, second, TOKEN.programs, 'blk-1', PROGRAM);
    stage(COACH, second, TOKEN.workouts, 'rt-1', WORKOUT);
    const done = await run({ ...REGISTRY, action: 'complete', coach: COACH, intent: second });
    expect(done.failure).toBeUndefined();
    expect(runRow(COACH, second)).toMatchObject({ terminal_status: 'partial' });
    expect(programs(COACH)).toHaveLength(1);
    expect(plans(COACH)).toHaveLength(1);
    expect(
      provenanceRows(COACH)
        .filter((p) => p.source_id === 'blk-1')
        .every((p) => p.native_id === program.id),
    ).toBe(true);
    expect(ledgerByToken(COACH, second)).toEqual({
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
      [TOKEN.workouts]: { reconstructed: 1, skipped: 0, failed: 0 },
    });
  });
});

describe('P14 — CAS/epoch on the settle tail (G14)', () => {
  it('a cancel between the pass and the tail lock raises the epoch; the tail writes no terminal; completed_at is set once', async () => {
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
    expect(ledgerByToken(COACH, intentId)).toEqual({
      [TOKEN.programs]: { reconstructed: 1, skipped: 0, failed: 0 },
    });
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
    expect(done.queries.filter(isLock)).toHaveLength(1);
    expect(done.queries.filter(isTerminal)).toHaveLength(0);
    expect(done.events.map((e) => e[1])).not.toContain('scout.run.settled');
    expect(runRow(COACH, intentId)).toEqual(fenced);
    expect(fenced).toMatchObject({ terminal_status: 'cancelled', execution_epoch: 2 });
    expect(fenced.completed_at).not.toBeNull();
    // A stale settle with the old epoch is also a no-op.
    const stale = await run({
      ...REGISTRY,
      action: 'settled',
      coach: COACH,
      intent: intentId,
      body: { epoch: 1 },
    });
    expect(stale.failure).toBeUndefined();
    expect(runRow(COACH, intentId)).toEqual(fenced);
  });
});
