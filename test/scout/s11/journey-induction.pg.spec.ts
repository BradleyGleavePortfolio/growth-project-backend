/**
 * S11-A2 real-PG proof: the induction steps of the two-host journey over TWO synthetic sources
 * (docs/decisions/2026-09-26-s11-journey.md D-S11-6; §3 J09–J11; D-S11-8 row S11-A2; Q-S11-4:
 * J09 is a LOCAL synthetic proof only — no real source is signed here).
 *
 * The two sources are data only (D-S11-7(7)): the S10-D D2 synthetic source (repository-resident
 * spec / rules / manifest; rows, template and TEST-ONLY key in the D2 fixture directory that
 * test/fixtures/scout/s11/s11-sources.ts reads) and the S11-A2 synthetic source, whose EVERY artifact lives under
 * its own directory under test/fixtures/scout/s11/ and reaches the worker only through `input.induction`
 * (test/utils/g2-s11-worker.cjs: repository defaults + injected packages → ONE composed registry
 * for the planner, the native families, the facts service and the observation service). Slugs
 * are read from the fixture data (`h.SOURCES.first.platform`, `h.SOURCES.second.platform`); this
 * file types none. The second source has no roster family on purpose (programs + workouts), so
 * `clients` stays provable through the first source alone and J10 discriminates the families a
 * missing declaration leaves unknown from the one it does not.
 *
 * NATIVE-CLEAN SHAPE (s10d2/d2_diagnose_fix.md, the S10-D D2 learning). When this file was
 * written, a run that staged ANY `clients` row could not settle `complete`: the legacy Person
 * handoff ledgered `target_kind NULL`, the S9-A classifier put it in bucket (f) `unresolved`, and
 * the run-level condition `unresolved_identities` held regardless of coverage. J09 therefore
 * stages the native-clean shape for BOTH platforms — no `clients` row on either; `clients` is
 * DECLARED (the first source's manifest names it) and source-signed as the EMPTY enumeration;
 * every staged identity is native (coach-owned program / workout templates) — exactly the shape
 * the D2 live proof (test/scout/s10/s10-unseen.pg.spec.ts, r2 case (a)) settled `complete` with.
 * S8-D1 (docs/decisions/2026-09-26-s8d-person-link.md §5.1) has since landed the typed `person`
 * handoff, so a roster-bearing run CAN settle `complete` (pinned live by s10-unseen case (h) and
 * the S11 full journey's leg B). This file keeps its native-clean shape on purpose: J09–J11 prove
 * the induction / declaration / barrier mechanics, and no assertion here depends on the roster path.
 *
 * Statements are signed as the D2 proof signs them (test/fixtures/scout/s11/s11-sources.ts): the
 * identity-set digest is the INDEPENDENT reference implementation, the spec digest the service's
 * own over the parsed spec, `issued_at` is issued after the run's accepted start and before the
 * upload (a clock ordering, never a sync). J11's barrier is the worker's pause at the real
 * `FOR NO KEY UPDATE` / §3.1 gate (settle-redrive J13 shape): the blocked side is OBSERVED in
 * pg_stat_activity before the holder is released; no sleep orders anything.
 *
 * "P1"/"P2" label the host process; "phone"/"ext" label the client role, never a principal.
 * Lane: the S11-only disposable PG17 lane (G2_S11_*). Without G2_S11_DATABASE_URL this file is
 * inert (describe.skip) and loads no harness. Run it alone and in band (it resets the lane's rows
 * before every case):
 *   jest --runInBand test/scout/s11/journey-induction.pg.spec.ts
 */

// A module, not a script: journey-core.pg.spec.ts declares top-level names as a script.
export {};

type Harness = typeof import('../../utils/g2-s11-harness');
type PgHarness = typeof import('../../utils/g2-s11-pg-harness');
type Result = import('../../utils/g2-s11-pg-harness').Result;
type Host = import('../../utils/g2-s11-harness').Host;
type Source = import('../../utils/g2-s11-harness').SyntheticSource;

jest.setTimeout(600000);

const live = process.env.G2_S11_DATABASE_URL ? describe : describe.skip;

const COACH = 's11a2-coach-a';
const ack = (intent_id: string) => ({ acknowledged: true, intent_id });
const isTerminal = (q: string) =>
  /UPDATE "ScoutImport"/.test(q) && /SET terminal_status = /.test(q);
const isLock = (q: string) => q.includes('FOR NO KEY UPDATE');
const isGate = (q: string) => /SET last_observed_at\s*=/.test(q);
const isStagedInsert = (q: string) => /^\s*INSERT INTO (?:"public"\.)?"ScoutIngestEntity"/.test(q);
const isDeclarationInsert = (q: string) =>
  /^\s*INSERT INTO (?:"public"\.)?"ScoutRunDeclaration"/.test(q);
const conflict = (code: string) =>
  expect.objectContaining({ status: 409, response: expect.objectContaining({ code }) });
const byFamily = (report: Record<string, any>, family: string) =>
  report.families.find((f: Record<string, any>) => f.family === family);
/** The coverage cells of every report family, in report order (what C-COV is about). */
const coverage = (report: Record<string, any>) =>
  report.families.map((f: Record<string, any>) => ({
    family: f.family,
    completeness_basis: f.completeness_basis,
    observed_unique: f.observed_unique,
  }));
/** The native-identity cells of every report family (what C-ID is about). */
const identities = (report: Record<string, any>) =>
  report.families.map((f: Record<string, any>) => ({
    family: f.family,
    staged_unique: f.staged_unique,
    native_present_verified: f.native_present_verified,
    unresolved: f.unresolved,
    rejected: f.rejected,
    failed: f.failed,
  }));

live('S11-A2 induction — two sources, two hosts over one disposable PG (J09-J11)', () => {
  let h: Harness;
  let pg: PgHarness;
  let FIRST: Source;
  let SECOND: Source;

  beforeAll(() => {
    // Lazy: only a live run loads the harness (its import binds and validates the S11 lane).
    h = require('../../utils/g2-s11-harness');
    pg = require('../../utils/g2-s11-pg-harness');
    FIRST = h.SOURCES.first;
    SECOND = h.SOURCES.second;
    // The fixture shape the proof relies on: two DISTINCT platforms, one native-clean row set
    // each, the first emitting `clients` (declared, signed empty), the second not emitting it.
    expect(FIRST.platform).not.toBe(SECOND.platform);
    expect(FIRST.families).toEqual(['clients', 'programs', 'workouts']);
    expect(SECOND.families).toEqual(['programs', 'workouts']);
    expect(h.idsByFamily(FIRST, FIRST.nativeClean).clients).toEqual([]);
    expect(FIRST.nativeClean.length).toBeGreaterThan(0);
    expect(SECOND.nativeClean.length).toBeGreaterThan(0);
  });
  beforeEach(() => h.resetData());
  afterAll(() => {
    if (h) h.resetData();
  });

  /* ---- journey steps (thin: every behaviour is the real service in the worker) ---- */

  /** Steps 1-2 as a fixture (pairing is J01's proof), step 4 on `host`. */
  const started = async (coach: string, host: Host = 'P2') => {
    const intentId = h.intent(coach);
    const start = await h.induction.start(host, coach, intentId);
    expect(start.failure).toBeUndefined();
    expect(h.runRow(coach, intentId)).toMatchObject({ execution_epoch: 1, terminal_status: null });
    return intentId;
  };
  /** Step 5 for one source: one batch per staged token, hosts alternating from `first`. */
  const transfer = async (coach: string, intentId: string, src: Source, first: Host) => {
    const hosts: Host[] = first === 'P1' ? ['P1', 'P2'] : ['P2', 'P1'];
    const tokens = h.tokensOf(src.nativeClean);
    for (const [i, token] of tokens.entries()) {
      const batch = await h.induction.ingest(hosts[i % 2], coach, intentId, src, token);
      expect(batch.failure).toBeUndefined();
      const rows = src.nativeClean.filter((r) => r.token === token).length;
      expect(batch.result).toEqual({ received: rows, deduped: 0 });
    }
  };
  /** Step 6 for one source: every spec family signed over its staged ids (empty sets too). */
  const observe = async (
    host: Host,
    coach: string,
    intentId: string,
    src: Source,
    challengeB64: string,
  ) => {
    const issuedAt = await h.issuedAfterStart(coach, intentId);
    const evidence = h.evidenceSet(src, src.nativeClean, challengeB64, issuedAt);
    expect(evidence.length).toBe(src.families.length);
    return { evidence, upload: await h.induction.observe(host, coach, intentId, evidence) };
  };
  const stagedTotal = (coach: string, intentId: string) => h.stagedCount(coach, intentId);
  const nativeCounts = (coach: string) => ({
    persons: h.persons(coach).length,
    plans: h.plans(coach).length,
    programs: h.programs(coach).length,
  });

  /* =============================================================================================
   * J09 — two platforms, complete: declare both (P1, replay P2), transfer both (hosts alternating),
   * observe each source on its own host (replay across hosts), complete on P2 → `complete`,
   * ONE settled basis, the same status on both hosts.
   * ============================================================================================= */
  it('J09 declares, transfers and observes two platforms across two hosts and settles `complete`', async () => {
    const intentId = await started(COACH, 'P2');

    // Step 3 (declaration) on P1: both platforms, one scope each (E6: exactly one per platform).
    const declared = await h.induction.declare('P1', COACH, intentId, [FIRST, SECOND]);
    expect(declared.failure).toBeUndefined();
    expect(declared.result).toMatchObject({ intent_id: intentId });
    const challenge: string = declared.result.challenge_b64;
    expect(Buffer.from(challenge, 'base64').length).toBe(32);
    const rows = h.declarationRows(COACH, intentId);
    expect(
      rows.map((r) => [r.source_platform, r.account_scope_id_digest, r.challenge_b64]),
    ).toEqual(
      [
        [FIRST.platform, FIRST.scope, challenge],
        [SECOND.platform, SECOND.scope, challenge],
      ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
    // The identical declaration replayed on the OTHER host (order reversed) returns the ORIGINAL
    // challenge and writes no row (D-S11-7(3): idempotency is the run's, not a process's).
    const replay = await h.induction.declare('P2', COACH, intentId, [SECOND, FIRST]);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(declared.result);
    expect(replay.queries.filter(isDeclarationInsert)).toEqual([]);
    expect(h.declarationRows(COACH, intentId)).toEqual(rows);

    // Step 5 (transfer): the first source's batches start on P2, the second's on P1.
    await transfer(COACH, intentId, FIRST, 'P2');
    await transfer(COACH, intentId, SECOND, 'P1');
    const staged = FIRST.nativeClean.length + SECOND.nativeClean.length;
    expect(stagedTotal(COACH, intentId)).toBe(staged);
    // Native-clean on BOTH platforms: every staged group is a token of a native family.
    expect(
      h.stagedGroups(COACH, intentId).map((g) => [g.source_platform, g.entity_type, Number(g.n)]),
    ).toEqual(
      [
        ...h
          .tokensOf(FIRST.nativeClean)
          .map((t) => [FIRST.platform, t, FIRST.nativeClean.filter((r) => r.token === t).length]),
        ...h
          .tokensOf(SECOND.nativeClean)
          .map((t) => [SECOND.platform, t, SECOND.nativeClean.filter((r) => r.token === t).length]),
      ].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)),
    );

    // Step 6 (observation): each source's statements uploaded from a different host; every unit
    // stored once; the second source's set replayed on P1 stores nothing and replays everything.
    const first = await observe('P1', COACH, intentId, FIRST, challenge);
    expect(first.upload.failure).toBeUndefined();
    expect(first.upload.result).toEqual({
      intent_id: intentId,
      execution_epoch: 1,
      stored: FIRST.families.length,
      replayed: 0,
    });
    const second = await observe('P2', COACH, intentId, SECOND, challenge);
    expect(second.upload.failure).toBeUndefined();
    expect(second.upload.result).toEqual({
      intent_id: intentId,
      execution_epoch: 1,
      stored: SECOND.families.length,
      replayed: 0,
    });
    const again = await h.induction.observe('P1', COACH, intentId, second.evidence);
    expect(again.failure).toBeUndefined();
    expect(again.result).toEqual({
      intent_id: intentId,
      execution_epoch: 1,
      stored: 0,
      replayed: SECOND.families.length,
    });
    const observations = h.observationRows(COACH, intentId);
    expect(observations.map((o) => [o.source_platform, o.family, o.basis_kind])).toEqual(
      [
        ...FIRST.families.map((f) => [FIRST.platform, f, 'source_signed_enumeration']),
        ...SECOND.families.map((f) => [SECOND.platform, f, 'source_signed_enumeration']),
      ].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)),
    );
    expect(new Set(observations.map((o) => o.execution_epoch))).toEqual(new Set([1]));

    // Step 8 (complete) on P2: one terminal write, one push, `complete`.
    const done: Result = await h.induction.complete('P2', COACH, intentId);
    expect(done.failure).toBeUndefined();
    expect(done.result).toEqual(ack(intentId));
    expect(done.queries.filter(isTerminal).length).toBe(1);
    expect(done.pushes).toBe(1);
    const run = h.runRow(COACH, intentId);
    expect(run).toMatchObject({
      terminal_status: 'complete',
      reason_code: null,
      phase: 'reconciling',
      execution_epoch: 1,
    });
    expect(run.completed_at).not.toBeNull();
    expect(h.completionRows()).toEqual([[COACH, intentId, 'success']]);

    // The durable basis: ONE row, epoch 1, the settled report with NO condition, every required
    // family source-signed with a KNOWN count (the empty roster is 0, never null), every staged
    // identity native and verified, one digest per stored observation.
    const basis = h.settledBasisRows(COACH, intentId);
    expect(basis.length).toBe(1);
    expect(basis[0]).toMatchObject({ execution_epoch: 1, report_version: 1 });
    const report = basis[0].report;
    expect(report).toMatchObject({ report_version: 1, basis: 'settled', conditions: [] });
    expect(report.required_families).toEqual(['clients', 'programs', 'workouts']);
    const ids1 = h.idsByFamily(FIRST, FIRST.nativeClean);
    const ids2 = h.idsByFamily(SECOND, SECOND.nativeClean);
    const expectedCount = (family: string) =>
      new Set([...(ids1[family] ?? []), ...(ids2[family] ?? [])]).size;
    expect(coverage(report)).toEqual(
      ['clients', 'programs', 'workouts'].map((family) => ({
        family,
        completeness_basis: 'source_signed_enumeration',
        observed_unique: expectedCount(family),
      })),
    );
    expect(byFamily(report, 'clients').observed_unique).toBe(0);
    expect(identities(report)).toEqual(
      ['clients', 'programs', 'workouts'].map((family) => ({
        family,
        staged_unique: expectedCount(family),
        native_present_verified: expectedCount(family),
        unresolved: 0,
        rejected: 0,
        failed: 0,
      })),
    );
    expect([...basis[0].observation_digests].sort()).toEqual(
      observations.map((o) => o.evidence_digest).sort(),
    );
    expect(nativeCounts(COACH)).toEqual({
      persons: 0,
      plans: expectedCount('workouts'),
      programs: expectedCount('programs'),
    });
    expect(h.evidenceRows(COACH).length).toBe(0);
    expect(h.ledgerRows(COACH, intentId).length).toBe(staged);

    // Step 9: both hosts read the SAME settled verdict; the read writes nothing.
    const p1 = await h.induction.status('P1', COACH, intentId);
    const p2 = await h.induction.status('P2', COACH, intentId);
    expect(p1.failure).toBeUndefined();
    expect(p1.result).toMatchObject({
      status: 'complete',
      reason_code: null,
      claimed_status: 'success',
    });
    expect(JSON.stringify(p2.result)).toBe(JSON.stringify(p1.result));
    expect(h.runRow(COACH, intentId)).toEqual(run);
    expect(h.settledBasisRows(COACH, intentId)).toEqual(basis);
  });

  /* =============================================================================================
   * J10 — second platform staged but UNDECLARED: its evidence is refused, the run settles
   * `partial` with exactly `coverage_basis_unknown`, and the families it emits read
   * `completeness_basis: 'none'`, `observed_unique: null` — unknown, never zero — while every
   * staged identity is native and verified (C-ID never masks C-COV) and the first source's
   * `clients` stays a KNOWN empty enumeration.
   * ============================================================================================= */
  it('J10 settles `partial` / `coverage_basis_unknown` with null counts for the undeclared platform', async () => {
    const intentId = await started(COACH, 'P1');

    // Step 3: the FIRST platform only.
    const declared = await h.induction.declare('P2', COACH, intentId, [FIRST]);
    expect(declared.failure).toBeUndefined();
    const challenge: string = declared.result.challenge_b64;
    expect(h.declarationRows(COACH, intentId).map((r) => r.source_platform)).toEqual([
      FIRST.platform,
    ]);

    // Step 5: BOTH platforms staged (the second one undeclared).
    await transfer(COACH, intentId, FIRST, 'P1');
    await transfer(COACH, intentId, SECOND, 'P2');
    const staged = FIRST.nativeClean.length + SECOND.nativeClean.length;
    expect(stagedTotal(COACH, intentId)).toBe(staged);

    // Step 6: the first source's statements are stored; the second source's are REFUSED as a unit
    // (`observation_not_declared`), storing nothing — an undeclared platform cannot be proven.
    const first = await observe('P1', COACH, intentId, FIRST, challenge);
    expect(first.upload.failure).toBeUndefined();
    expect(first.upload.result).toMatchObject({ stored: FIRST.families.length, replayed: 0 });
    const second = await observe('P2', COACH, intentId, SECOND, challenge);
    expect(second.upload.result).toBeUndefined();
    expect(second.upload.failure).toEqual(conflict('observation_not_declared'));
    const observations = h.observationRows(COACH, intentId);
    expect(observations.map((o) => o.source_platform)).toEqual(
      FIRST.families.map(() => FIRST.platform),
    );

    // Step 8 on P1: settles, but partial for the coverage reason ONLY.
    const done = await h.induction.complete('P1', COACH, intentId);
    expect(done.failure).toBeUndefined();
    expect(done.result).toEqual(ack(intentId));
    expect(done.pushes).toBe(1);
    const run = h.runRow(COACH, intentId);
    expect(run).toMatchObject({
      terminal_status: 'partial',
      reason_code: 'coverage_basis_unknown',
      execution_epoch: 1,
    });
    const basis = h.settledBasisRows(COACH, intentId);
    expect(basis.length).toBe(1);
    const report = basis[0].report;
    expect(report.basis).toBe('settled');
    expect(report.conditions).toEqual(['coverage_basis_unknown']);
    expect(report.required_families).toEqual(['clients', 'programs', 'workouts']);
    // C-COV: the second source emits programs + workouts → those two families are UNKNOWN (null,
    // never 0, even though the first source signed its own part of them); `clients` — emitted by
    // the declared source only — stays a KNOWN empty enumeration.
    expect(coverage(report)).toEqual([
      { family: 'clients', completeness_basis: 'source_signed_enumeration', observed_unique: 0 },
      { family: 'programs', completeness_basis: 'none', observed_unique: null },
      { family: 'workouts', completeness_basis: 'none', observed_unique: null },
    ]);
    // C-ID is CLEAN: every staged identity of both platforms is native and verified, so the only
    // thing the verdict can be about is coverage.
    const ids1 = h.idsByFamily(FIRST, FIRST.nativeClean);
    const ids2 = h.idsByFamily(SECOND, SECOND.nativeClean);
    const expectedCount = (family: string) =>
      new Set([...(ids1[family] ?? []), ...(ids2[family] ?? [])]).size;
    expect(identities(report)).toEqual(
      ['clients', 'programs', 'workouts'].map((family) => ({
        family,
        staged_unique: expectedCount(family),
        native_present_verified: expectedCount(family),
        unresolved: 0,
        rejected: 0,
        failed: 0,
      })),
    );
    expect(report.ledger_without_staged).toBe(0);
    expect(nativeCounts(COACH)).toEqual({
      persons: 0,
      plans: expectedCount('workouts'),
      programs: expectedCount('programs'),
    });
    expect([...basis[0].observation_digests].sort()).toEqual(
      observations.map((o) => o.evidence_digest).sort(),
    );

    // Step 9: both hosts read `partial` / `coverage_basis_unknown`; a token of the undeclared
    // platform carries NO observed_unique (unknown, never 0) — token-shaped projection, D-S10 F7.
    const p1 = await h.induction.status('P1', COACH, intentId);
    const p2 = await h.induction.status('P2', COACH, intentId);
    expect(p1.failure).toBeUndefined();
    expect(p1.result).toMatchObject({ status: 'partial', reason_code: 'coverage_basis_unknown' });
    expect(JSON.stringify(p2.result)).toBe(JSON.stringify(p1.result));
    for (const token of h.tokensOf(SECOND.nativeClean)) {
      const entry = p1.result.families.find((f: Record<string, any>) => f.family === token);
      expect(entry).toBeDefined();
      expect(entry.observed_unique ?? null).toBeNull();
    }
  });

  /* =============================================================================================
   * J11 — the declaration on P1 races the first batch on P2 at the run row (real lock, real
   * blocked wait observed in pg_stat_activity). Whichever side commits first decides: the run is
   * EITHER declared-then-ingested (declaration rows exist, the batch lands) OR the declaration
   * is refused `declaration_after_ingest` (no declaration row, the batch lands) — never both,
   * never neither. Both orderings are driven deterministically.
   * ============================================================================================= */
  const xorOutcome = (coach: string, intentId: string, declare: Result, ingest: Result) => {
    const declaredRows = h.declarationRows(coach, intentId).length;
    const declaredOk = declare.failure === undefined;
    const refused = declare.failure !== undefined;
    // The batch is never the loser: ingest does not depend on a declaration.
    expect(ingest.failure).toBeUndefined();
    expect(ingest.result).toMatchObject({ deduped: 0 });
    expect(declaredOk !== refused).toBe(true);
    if (declaredOk) expect(declaredRows).toBe(2);
    else {
      expect(declare.failure).toEqual(conflict('declaration_after_ingest'));
      expect(declaredRows).toBe(0);
    }
    return declaredOk ? 'declared_then_ingested' : 'declaration_after_ingest';
  };
  const firstToken = (src: Source) => h.tokensOf(src.nativeClean)[0];
  const firstBatchRows = (src: Source) =>
    src.nativeClean.filter((r) => r.token === firstToken(src)).length;

  it('J11(a) declaration on P1 holds the run row first → declared, then the batch on P2 lands', async () => {
    const intentId = await started(COACH, 'P2');
    // P1: the declaration transaction pauses AFTER its FOR NO KEY UPDATE returned (lock held).
    const declaring = h.induction.held('P1', 'ext', {
      action: 'declare',
      coach: COACH,
      intent: intentId,
      body: { platforms: [FIRST, SECOND].map(h.declarationOf) },
      pause: 'locked',
      txTimeout: 60000,
    });
    expect(await declaring.ready).toBe('locked');
    expect(h.declarationRows(COACH, intentId)).toEqual([]);
    // P2: the first batch's §3.1 gate UPDATE on the same row must wait — observed, not assumed.
    const ingesting = h.induction.held('P2', 'ext', {
      action: 'ingest',
      coach: COACH,
      intent: intentId,
      body: h.batchOf(SECOND, firstToken(SECOND), SECOND.nativeClean),
      txTimeout: 60000,
    });
    await pg.blocked(ingesting.name);
    expect(stagedTotal(COACH, intentId)).toBe(0);
    declaring.resume();
    const declare = await declaring.done;
    const ingest = await ingesting.done;
    expect(xorOutcome(COACH, intentId, declare, ingest)).toBe('declared_then_ingested');
    expect(declare.result).toMatchObject({ intent_id: intentId });
    expect(declare.queries.filter(isLock).length).toBe(1);
    expect(ingest.result).toEqual({ received: firstBatchRows(SECOND), deduped: 0 });
    expect(stagedTotal(COACH, intentId)).toBe(firstBatchRows(SECOND));
    // The declaration is now fixed for the run: a later identical replay (other host) returns the
    // same challenge; a different one is `declaration_conflict`, never `declaration_after_ingest`.
    const replay = await h.induction.declare('P2', COACH, intentId, [FIRST, SECOND]);
    expect(replay.result).toEqual(declare.result);
    const other = await h.induction.declare('P2', COACH, intentId, [FIRST]);
    expect(other.failure).toEqual(conflict('declaration_conflict'));
    expect(h.declarationRows(COACH, intentId).length).toBe(2);
  });

  it('J11(b) the batch on P2 holds the run row first → the batch lands, the declaration on P1 is refused', async () => {
    const intentId = await started(COACH, 'P1');
    // P2: the first batch pauses AFTER the §3.1 gate UPDATE returned (row lock held, no staged row
    // committed yet).
    const ingesting = h.induction.held('P2', 'ext', {
      action: 'ingest',
      coach: COACH,
      intent: intentId,
      body: h.batchOf(SECOND, firstToken(SECOND), SECOND.nativeClean),
      pause: 'gated',
      txTimeout: 60000,
    });
    expect(await ingesting.ready).toBe('gated');
    expect(stagedTotal(COACH, intentId)).toBe(0);
    // P1: the declaration's FOR NO KEY UPDATE on the same row must wait — observed, not assumed.
    const declaring = h.induction.held('P1', 'ext', {
      action: 'declare',
      coach: COACH,
      intent: intentId,
      body: { platforms: [FIRST, SECOND].map(h.declarationOf) },
      txTimeout: 60000,
    });
    await pg.blocked(declaring.name);
    ingesting.resume();
    const ingest = await ingesting.done;
    const declare = await declaring.done;
    expect(xorOutcome(COACH, intentId, declare, ingest)).toBe('declaration_after_ingest');
    expect(ingest.queries.filter(isGate).length).toBe(1);
    expect(ingest.queries.filter(isStagedInsert).length).toBeGreaterThan(0);
    expect(declare.queries.filter(isDeclarationInsert)).toEqual([]);
    expect(stagedTotal(COACH, intentId)).toBe(firstBatchRows(SECOND));
    // Deterministic afterwards on either host: the run stays undeclared for good.
    const again = await h.induction.declare('P2', COACH, intentId, [FIRST, SECOND]);
    expect(again.failure).toEqual(conflict('declaration_after_ingest'));
    expect(h.declarationRows(COACH, intentId)).toEqual([]);
    // And an observation without a declaration is refused for the missing declaration, not
    // stored: unknown coverage stays unknown.
    const issuedAt = await h.issuedAfterStart(COACH, intentId);
    const evidence = h.evidenceSet(
      SECOND,
      SECOND.nativeClean,
      Buffer.alloc(32, 7).toString('base64'),
      issuedAt,
    );
    const upload = await h.induction.observe('P1', COACH, intentId, evidence);
    expect(upload.failure).toEqual(conflict('declaration_missing'));
    expect(h.observationRows(COACH, intentId)).toEqual([]);
  });
});
