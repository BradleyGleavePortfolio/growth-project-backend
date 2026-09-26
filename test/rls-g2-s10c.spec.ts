/**
 * S10-C — live PostgreSQL proof of the settle write and the status preference
 * (docs/decisions/2026-09-26-s10-induction.md D-S10-4, D-S10-6, D-S10-7 row S10-C; acceptance
 * R33 (structural half), R34, R35, R36, R38; R23 terminal half).
 *
 * THROUGHPUT RULE: this file forks NO harness. It imports the S10-B lane verbatim
 * (test/utils/g2-s10b-{db,pg-harness,harness,fixtures}.ts and the S10-B worker) and drives the
 * S10-C paths by PARAMETER only: the worker's `complete` / `status` / `fence` actions run the real
 * ScoutService → ScoutLifecycleService settle tail and status read; `failAfter: { model:
 * 'scoutRunSettledBasis', n: 0 }` is the S10-B injected-create hook aimed at the new model. The
 * same guards apply (G2_S10B_* env, attested candidate head, clean tree); it runs ONLY where the
 * S10-B spec runs, on the same disposable cluster, after `prisma generate` at the candidate head.
 *
 * Known limit (stated, not hidden; review A finding 2): the landed S10-B worker constructs
 * ScoutLifecycleService with the two-argument signature, so its facts service builds the DEFAULT
 * induction registry (on-disk manifests: none at this head) and every family is unknown at
 * settle. The `complete` terminal therefore exercises the S9 closed set (`partial /
 * coverage_basis_unknown`, D-S10-8) and the STRUCTURAL D-S10-4 guarantees only. This file is NOT
 * the R33 live proof of the `complete → complete` verdict half; that half is proven at the unit
 * tier (facts.service.coverage.spec, lifecycle.service.spec) and its live case needs a worker
 * registry seam plus a signed-evidence fixture for a production-mapped platform (owner decision;
 * see s10c_builder_summary.md, open question 1).
 */
import {
  count,
  DECLARATION,
  intent,
  OBSERVATION,
  observationRows,
  PLATFORM,
  PLATFORM_B,
  REGISTRY,
  resetData,
  runRow,
  SETTLED,
  stage,
} from './utils/g2-s10b-harness';
import { blocked, json, quote, run, worker } from './utils/g2-s10b-pg-harness';
import { SCOPE_1, SCOPE_2 } from './utils/g2-s10b-fixtures';
import { RUN_REASON_CODES } from '../src/scout/lifecycle/reason-codes';
import { S9_REASON_CODES } from '../src/scout/reconciliation/types';

jest.setTimeout(300000);

const COACH = 'coach';
const OTHER = 'other-coach';

const started = async (coach = COACH) => {
  const intentId = intent(coach);
  const start = await run({ action: 'start', coach, intent: intentId });
  expect(start.failure).toBeUndefined();
  return intentId;
};
const PLATFORMS = [
  { source_platform: PLATFORM_B, account_scope_id_digests: [SCOPE_1] },
  { source_platform: PLATFORM, account_scope_id_digests: [SCOPE_2, SCOPE_1] },
];
const declare = (intentId: string, platforms: unknown = PLATFORMS, coach = COACH) =>
  run({ ...REGISTRY, action: 'declare', coach, intent: intentId, body: { platforms } });
const observe = (intentId: string, evidence: Record<string, unknown>[] = [{}], coach = COACH) =>
  run({ ...REGISTRY, action: 'observe', coach, intent: intentId, body: { evidence } });
const complete = (intentId: string, extra: Record<string, unknown> = {}, coach = COACH) =>
  run({ action: 'complete', coach, intent: intentId, ...extra });
const status = (intentId: string, coach = COACH) =>
  run({ action: 'status', coach, intent: intentId });

/** The one settled-basis row of a run, or null. */
const settledRow = (coach: string, intentId: string) =>
  json(
    `SELECT COALESCE((SELECT to_jsonb(s) FROM "${SETTLED}" s
        WHERE coach_id=${quote(coach)} AND intent_id=${quote(intentId)}),'null')`,
  );

const isTerminalCas = (q: string) =>
  /UPDATE "ScoutImport"/.test(q) && /SET terminal_status = /.test(q);
const isBasisInsert = (q: string) => /INSERT INTO (?:"public"\.)?"ScoutRunSettledBasis"/.test(q);
const isMarker = (q: string) => q.startsWith('-- tx:');
const isLock = (q: string) => q.includes('FOR NO KEY UPDATE');
/** INSERT/UPDATE/DELETE — the S9-C live spec's `isWrite` family. */
const isWrite = (q: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q);
/** The S9-B collector's signature provenance read (the S9-C live spec's `isS9Read`). */
const isS9Read = (q: string) =>
  /^\s*SELECT/i.test(q) && /"ImportNativeProvenance"/.test(q) && /"source_namespace" IN \(/.test(q);

/** A declared, staged and observed server run ready to be claimed. */
async function readyRun(): Promise<string> {
  const intentId = await started();
  expect((await declare(intentId)).failure).toBeUndefined();
  stage(COACH, intentId, 'clients', 'c1');
  stage(COACH, intentId, 'clients', 'c2');
  expect((await observe(intentId)).failure).toBeUndefined();
  expect(count(DECLARATION)).toBe(3);
  expect(count(OBSERVATION)).toBe(1);
  return intentId;
}

/** Zero customer side effects in a worker run (D-S10-6 invariant 5, R38). */
const noSideEffects = (r: { pushes: number; sideEffectLoads: Record<string, number> }) => {
  expect(r.pushes).toBe(0);
  expect(Object.values(r.sideEffectLoads).every((n) => n === 0)).toBe(true);
};

beforeEach(() => resetData());

describe('R33 STRUCTURAL half only (not the live Complete verdict) — one terminal, one basis row, same transaction, after the CAS', () => {
  it('complete → terminal from the S9 closed set + ONE ScoutRunSettledBasis row recording the settled report and the epoch digests', async () => {
    const intentId = await readyRun();
    const done = await complete(intentId);
    expect(done.failure).toBeUndefined();
    noSideEffects(done);

    const row = runRow(COACH, intentId);
    expect(row.terminal_status).not.toBeNull();
    expect(row.fenced_at).toBeNull();
    // D-S10-8: no new reason code. With no induction manifest on disk every basis is unknown, so
    // the S9 predicate refuses coverage and the arbiter writes the S9 code — never `complete`.
    expect(RUN_REASON_CODES).toContain(row.reason_code);
    expect(S9_REASON_CODES).toContain(row.reason_code);
    expect(row.terminal_status).not.toBe('complete');

    expect(count(SETTLED)).toBe(1);
    const basis = settledRow(COACH, intentId);
    expect(basis.coach_id).toBe(COACH);
    expect(basis.intent_id).toBe(intentId);
    expect(basis.execution_epoch).toBe(row.execution_epoch);
    expect(basis.report_version).toBe(1);
    expect(basis.report.basis).toBe('settled');
    expect(basis.report.report_version).toBe(1);
    expect(Array.isArray(basis.report.families)).toBe(true);
    expect(basis.report.conditions).toContain('coverage_basis_unknown');
    // Invariant 2 in the record: an unknown basis never becomes a 0 count.
    expect(basis.report.families.length).toBeGreaterThan(0);
    for (const family of basis.report.families) {
      expect(family.completeness_basis).toBe('none');
      expect(family.observed_unique).toBeNull();
    }
    // The digests are exactly the stored observations of this run at the settle epoch.
    const stored = observationRows(COACH, intentId)
      .filter((o) => o.execution_epoch === row.execution_epoch)
      .map((o) => o.evidence_digest)
      .sort();
    expect([...basis.observation_digests].sort()).toEqual(stored);
    expect(stored.length).toBe(1);

    // Same transaction, after the CAS: the INSERT follows the terminal UPDATE with no
    // transaction marker between them, and the next marker is the commit.
    const q: string[] = done.queries;
    const cas = q.findIndex(isTerminalCas);
    const insert = q.findIndex(isBasisInsert);
    expect(cas).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(cas);
    expect(q.slice(cas + 1, insert).some(isMarker)).toBe(false);
    const nextMarker = q.slice(insert + 1).find(isMarker);
    expect(nextMarker).toBe('-- tx:commit');
    // The arbiter's UPDATE is the only terminal write and the only ScoutImport UPDATE after it.
    expect(q.filter(isTerminalCas)).toHaveLength(1);
    expect(q.filter(isBasisInsert)).toHaveLength(1);
    // Invariant 6 live (review B-3; the S9-C tail assertion that survives D-S10-4): from the
    // `FOR NO KEY UPDATE` lock to the CAS the tail issues NO write — the arbiter's CAS is the
    // first write of the tail and the basis INSERT the only one after it.
    const lockIndexes = q.map((x, i) => (isLock(x) ? i : -1)).filter((i) => i >= 0 && i < cas);
    const lock = lockIndexes[lockIndexes.length - 1] ?? -1; // the tail's lock: the last before CAS
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(cas);
    expect(q.slice(lock, cas).filter(isWrite)).toEqual([]);
    expect(q.slice(lock, cas).some(isMarker)).toBe(false); // one tail transaction
    expect(q.slice(cas + 1, insert).filter(isWrite)).toEqual([]);
    expect(q.slice(insert + 1, q.indexOf('-- tx:commit', insert)).filter(isWrite)).toEqual([]);
  });

  it('a second claim after the terminal is refused and writes no second basis row (insert-only; one per run)', async () => {
    const intentId = await readyRun();
    expect((await complete(intentId)).failure).toBeUndefined();
    const again = await complete(intentId);
    expect(again.failure?.status).toBe(409);
    expect(count(SETTLED)).toBe(1);
    expect(again.queries.filter(isBasisInsert)).toHaveLength(0);
  });
});

describe('R34 — S9 codes win; a fence wins; nothing else decides the terminal', () => {
  it('claim partial → partial from the S9 set; still one basis row (a record, not a verdict)', async () => {
    const intentId = await readyRun();
    const done = await complete(intentId, { body: { terminal_status: 'partial' } });
    expect(done.failure).toBeUndefined();
    const row = runRow(COACH, intentId);
    expect(row.terminal_status).toBe('partial');
    expect(S9_REASON_CODES).toContain(row.reason_code);
    expect(count(SETTLED)).toBe(1);
  });

  it('a fenced run: the fence writes the terminal and NO basis; a later claim is refused and writes none', async () => {
    const intentId = await readyRun();
    const fenced = await run({
      action: 'fence',
      coach: COACH,
      intent: intentId,
      body: { reason: 'revoked' },
    });
    expect(fenced.failure).toBeUndefined();
    expect(fenced.queries.filter(isBasisInsert)).toHaveLength(0);
    const row = runRow(COACH, intentId);
    expect(row.fenced_at).not.toBeNull();
    expect(row.reason_code).toBe('revoked');
    expect(count(SETTLED)).toBe(0);
    const late = await complete(intentId);
    expect(late.failure?.status).toBe(409);
    expect(count(SETTLED)).toBe(0);
    expect(runRow(COACH, intentId).reason_code).toBe('revoked');
  });
});

describe('R36 — CAS miss or insert failure: no terminal, no basis', () => {
  it('an injected ScoutRunSettledBasis insert failure rolls the terminal back: terminal_status NULL, zero basis rows, no settle event', async () => {
    const intentId = await readyRun();
    const done = await complete(intentId, { failAfter: { model: 'scoutRunSettledBasis', n: 0 } });
    expect(done.failure?.injected).toBe(true);
    expect(done.queries).toContain('-- tx:rollback');
    const row = runRow(COACH, intentId);
    expect(row.terminal_status).toBeNull();
    expect(row.reason_code).toBeNull();
    expect(count(SETTLED)).toBe(0);
    // analytics.capture(coach, event, props) is recorded as its argument list.
    expect(done.events.filter((e: unknown[]) => /settled/i.test(String(e[1])))).toHaveLength(0);
    // The run is still open: the next claim settles it normally, with exactly one basis row.
    const retry = await complete(intentId);
    expect(retry.failure).toBeUndefined();
    expect(runRow(COACH, intentId).terminal_status).not.toBeNull();
    expect(count(SETTLED)).toBe(1);
  });

  it('two concurrent claims: exactly one terminal write and exactly one basis row (the CAS loser inserts nothing)', async () => {
    const intentId = await readyRun();
    const a = worker({
      action: 'complete',
      coach: COACH,
      intent: intentId,
      pause: 'locked',
      txTimeout: 60000,
    });
    await a.ready;
    const b = worker({ action: 'complete', coach: COACH, intent: intentId });
    await blocked(b.name);
    a.resume();
    const [ar, br] = await Promise.all([a.done, b.done]);
    expect(String(ar.failure?.message ?? '')).not.toMatch(/deadlock/i);
    expect(String(br.failure?.message ?? '')).not.toMatch(/deadlock/i);
    expect(runRow(COACH, intentId).terminal_status).not.toBeNull();
    expect(count(SETTLED)).toBe(1);
    const inserts = [...ar.queries, ...br.queries].filter(isBasisInsert);
    expect(inserts).toHaveLength(1);
    // Both may attempt the CAS; the database lets exactly one succeed, and only that one inserts
    // — carried by `count(SETTLED) === 1` and the single INSERT above.
  });
});

describe('R35 / R37 — the status read prefers the settled basis and is byte-identical over time', () => {
  it('R35: status after settle is the settled record — the world drifts between two reads, the report-derived fields do not, they equal the stored basis row, and no transaction or S9 read happens', async () => {
    const intentId = await readyRun();
    expect((await complete(intentId)).failure).toBeUndefined();
    const first = await status(intentId);
    expect(first.failure).toBeUndefined();
    noSideEffects(first);
    const basis = settledRow(COACH, intentId);
    const clientsHolder = basis.report.families.find((f: any) =>
      f.tokens.some((t: any) => t.token === 'clients'),
    );
    expect(clientsHolder).toBeDefined();
    const clientsBefore = first.result.families.find((f: any) => f.family === 'clients');
    expect(clientsBefore).toMatchObject({ staged_unique: 2, rejected: 2 });

    // REAL DRIFT (review B-1): a third staged `clients` row lands after the settle. The live S7-L
    // `staged_unique` (a groupBy) sees it; a RECOMPUTE would also reject it (`rejected` 3); the
    // settled record must not move.
    stage(COACH, intentId, 'clients', 'c3');
    const again = await status(intentId);
    expect(again.failure).toBeUndefined();
    noSideEffects(again);
    const clientsAfter = again.result.families.find((f: any) => f.family === 'clients');
    expect(clientsAfter.staged_unique).toBe(3); // the drift is visible to the live half
    expect(clientsAfter.rejected).toBe(2); // the report half is the settled record
    expect(clientsAfter.reasons).toEqual(clientsHolder.reasons);
    expect(clientsAfter.reasons.map((r: any) => r.count)).toEqual([2]);

    // Every report-derived field is unchanged between the reads and equals the stored row.
    const REPORT_KEYS = [
      'canonical_family',
      'completeness_basis',
      'native_present_verified',
      'observed_unique',
      'qualifiers',
      'reasons',
      'rejected',
      'relationship_closure',
      'unresolved',
    ];
    const reportPart = (families: any[]) =>
      JSON.stringify(
        families.map((f: any) => Object.fromEntries(REPORT_KEYS.map((k) => [k, f[k] ?? null]))),
      );
    expect(reportPart(again.result.families)).toBe(reportPart(first.result.families));
    for (const key of ['native_present_verified', 'rejected', 'unresolved', 'qualifiers']) {
      expect(clientsAfter[key]).toEqual(clientsHolder[key]);
    }
    expect(clientsAfter.completeness_basis).toBe(clientsHolder.completeness_basis);
    expect(clientsAfter.observed_unique).toBeNull(); // finding 7: unknown basis → null, never 0
    expect(clientsHolder.observed_unique).toBeNull();

    // The read path: ONE point read of the basis row; no transaction, no S9 recompute read
    // (the S9-B collector's signature provenance statement), no write.
    const basisRead = /FROM (?:"public"\.)?"ScoutRunSettledBasis"/;
    expect(again.queries.filter((q: string) => basisRead.test(q))).toHaveLength(1);
    expect(again.queries.filter((q: string) => q === '-- tx:begin')).toHaveLength(0);
    expect(again.queries.filter(isS9Read)).toHaveLength(0);
    expect(again.queries.filter(isWrite)).toHaveLength(0);
    expect(again.queries.filter(isTerminalCas)).toHaveLength(0);
    expect(again.queries.filter(isBasisInsert)).toHaveLength(0);
  });

  it('the other coach sees 404 for the run and reads no basis row', async () => {
    const intentId = await readyRun();
    expect((await complete(intentId)).failure).toBeUndefined();
    const foreign = await status(intentId, OTHER);
    expect(foreign.failure?.status).toBe(404);
    expect(foreign.queries.some((q: string) => /"ScoutRunSettledBasis"/.test(q))).toBe(false);
  });
});
