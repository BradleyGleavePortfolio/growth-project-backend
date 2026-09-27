/**
 * S11-D — the full two-host journey (J19) and the core-diff check (J20).
 * docs/decisions/2026-09-26-s11-journey.md D-S11-8 row S11-D; §3 J19-J20; §4 invariant
 * cross-check row "CORE DIFF = 0"; D-S11-6 (spec cases only, the ONE S11 harness, unchanged);
 * OWNER_DECISION_S8D_2026-09-26.md (the mandatory honesty rule below).
 *
 * MANDATORY HONESTY (S11D_BUILD_GRANT.md; s10d2/d2_diagnose_fix.md), as it stood at the S11-D
 * head: a run that staged ANY `clients` row could not settle `complete` — the legacy Person
 * handoff ledgered `target_kind NULL`, S9-A bucketed it (f) `unresolved:evidence_only`, and the
 * run-level condition `unresolved_identities` held regardless of coverage (D2 case (h)). S8-D1
 * (docs/decisions/2026-09-26-s8d-person-link.md §5.1, the owner-decided fix this file said it was
 * waiting for) has since landed the typed, create-only `person` writer: ledger kind `person` + a
 * provenance row, verified by S9 as bucket j. J19 still proves TWO separate legs on TWO separate
 * runs; leg B's terminal is the one this file always said would flip, and it now asserts the
 * flipped truth (`complete`) with the SAME chain, the same roster read and the still-carried
 * `roster_bridge_pending` qualifier (retiring that qualifier is S8-D2, not D1):
 *   Leg A (native-clean): J01 (setup/pair/Start across P1+P2, replayed Start) -> J09 (two
 *   platforms declared, transferred and observed across hosts, no `clients` row staged) -> J12
 *   (the settle is interrupted by a real process kill after the claim commits; the replayed claim
 *   on the OTHER host re-drives it to the identical verdict) -> J17 (readiness reads `terminal`)
 *   -> step 11, the native roster read, which is asserted EMPTY because none were staged (D-S11-2
 *   row 11) — not because the read failed or the run is not `complete`.
 *   Leg B (roster-bearing): the SAME declare/transfer/observe/complete chain, but the first
 *   platform's batch ALSO includes its roster token (D2's `u10-members`, family `clients`) beside
 *   the native-clean rows — exactly the D2 case (h) shape. Since S8-D1 this leg settles
 *   `complete` (reason_code null, no conditions) with the `clients` family fully verified and
 *   qualifier `roster_bridge_pending` still carried, and its native roster read lists EXACTLY
 *   the staged people, `state: InvitePending` ("imported, not yet joined"), never a login
 *   principal — no User is minted (D-S8-2 (a)).
 *
 * Both legs run the two-process, two-source, cross-host mechanics S11-A1/A2 proved in isolation
 * (H-S, H-O; D-S11-1); this file COMPOSES them into one scenario per leg and adds the terminal
 * native roster read neither A1, A2, B nor C exercises together with a full settle. It re-derives
 * no new assertion technique: declare/transfer/observe/complete/readiness are S11-A2/S11-C's own
 * wrappers (`h.induction.*`, `h.pairSession`), and the interrupt+re-drive is S11-B's own kill
 * (`pg.worker({..., pause:'after-row', pauseRow})`, `.stop()`, replayed `complete`).
 *
 * Two sources (D-S11-7(7)): `h.SOURCES.first` (S10-D D2's `s10_unseen`, repository-resident) and
 * `h.SOURCES.second` (S11-A2's synthetic source, data-only under test/fixtures/scout/s11/). Leg
 * B's extra roster rows are read directly from the D2 fixture's raw `base` set (the same file
 * `test/fixtures/scout/s10_unseen/staged-rows.json` D2's own live spec reads) — this file does not
 * add, inject or duplicate any fixture; it reads the existing one exactly as D2 does. No slug is
 * typed in this file (grep-checked by the guard spec's existing "no real platform slug" rule);
 * the fixture's `source_platform` field is read at runtime, in both J19 and J20 below.
 *
 * "P1"/"P2" label the host process; "phone"/"ext" label the client role, never an authenticated
 * principal (D-S11-1). Lane: the S11-only disposable PG17 lane (G2_S11_*). Without
 * G2_S11_DATABASE_URL this file is inert (describe.skip) and loads no harness. Run alone and in
 * band (it resets the lane's rows before every case):
 *   jest --runInBand test/scout/s11/journey-full.pg.spec.ts
 *
 * J20 (the core-diff check, below) lives INSIDE this same `live(...)` gate, not as a separate
 * always-on describe (S11D review round 2, B1): it needs several historical commits to resolve
 * as real ancestors of HEAD, and GitHub Actions' default `actions/checkout@v6` step is a shallow
 * depth-1 checkout that does not carry that history — an ungated J20 would be deterministically
 * red in default CI even though the code under test is fine. Gating J20 the same way as every
 * other pg case in this file means: no `G2_S11_DATABASE_URL` -> J20 reports `skipped`, never a
 * false pass; `G2_S11_DATABASE_URL` set, run from a full-history local clone -> J20 runs for real
 * and fails hard (not silently) if a pinned commit is missing from history. J20's evidence is
 * therefore a PARENT-ONLY proof-lane receipt from a full-history local clone, exactly like J19's
 * — never a claim about the default no-DB/CI run, which only ever proves the file loads, parses,
 * and stays fully inert.
 */

// A module, not a script: journey-core.pg.spec.ts declares the same top-level names as a script,
// and `tsc --noEmit` compiles every file under test/ in one program.
export {};

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';

type Harness = typeof import('../../utils/g2-s11-harness');
type PgHarness = typeof import('../../utils/g2-s11-pg-harness');
type Host = import('../../utils/g2-s11-harness').Host;
type Source = import('../../utils/g2-s11-harness').SyntheticSource;
type FixtureRow = import('../../utils/g2-s11-harness').FixtureRow;

jest.setTimeout(600000);

const live = process.env.G2_S11_DATABASE_URL ? describe : describe.skip;

const COACH_A = 's11d-coach-clean';
const COACH_B = 's11d-coach-roster';
const ack = (intent_id: string) => ({ acknowledged: true, intent_id });
const isTerminal = (q: string) =>
  /UPDATE "ScoutImport"/.test(q) && /SET terminal_status = /.test(q);

live('S11-D full journey (J19) and core diff (J20)', () => {
  let h: Harness;
  let pg: PgHarness;
  /** The D2 fixture's raw rows, read exactly as D2's own live spec reads them (no new fixture). */
  let ROSTER_ROWS: FixtureRow[];

  beforeAll(() => {
    // Lazy: only a live run loads the harness (its import binds and validates the S11 lane).
    h = require('../../utils/g2-s11-harness');
    pg = require('../../utils/g2-s11-pg-harness');
    const rows: { sets: { base: FixtureRow[] } } = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/scout/s10_unseen/staged-rows.json'), 'utf8'),
    );
    // The D2 roster token (`u10-members`, family `clients`); D2's own spec derives it the same way.
    ROSTER_ROWS = rows.sets.base.filter((r) => r.token === 'u10-members');
    expect(ROSTER_ROWS.length).toBeGreaterThan(0);
  });
  beforeEach(() => h.resetData());
  afterAll(() => h?.resetData());

  const FIRST = () => h.SOURCES.first;
  /** A roster read on `host` through the two-source induction registry (review B B1). */
  const rosterVia = (host: Host, coach: string, intentId: string) =>
    h.onInduction(host, 'phone', { action: 'roster', coach, intent: intentId });
  const SECOND = () => h.SOURCES.second;

  /** Steps 1-2: setup on the phone (P1), pairing on the extension (P2). */
  const paired = async (coach: string): Promise<string> => {
    const init = await h.pairInit('P1', coach);
    expect(init.failure).toBeUndefined();
    const redeem = await h.pairRedeem('P2', init.result.pairing_code);
    expect(redeem.failure).toBeUndefined();
    return init.result.import_intent_id;
  };

  /** One ingest batch of `rows` (not just a source's native-clean set) split by token. */
  const transferRows = async (
    coach: string,
    intentId: string,
    src: Source,
    host: Host,
    rows: readonly FixtureRow[],
  ) => {
    for (const token of h.tokensOf(rows)) {
      const batch = await h.induction.ingest(host, coach, intentId, src, token, rows);
      expect(batch.failure).toBeUndefined();
    }
  };

  /** Step 6: sign and upload every family of `src` over `rows`, from `host`. */
  const observeRows = async (
    host: Host,
    coach: string,
    intentId: string,
    src: Source,
    rows: readonly FixtureRow[],
    challengeB64: string,
  ) => {
    const issuedAt = await h.issuedAfterStart(coach, intentId);
    const evidence = h.evidenceSet(src, rows, challengeB64, issuedAt);
    const upload = await h.induction.observe(host, coach, intentId, evidence);
    expect(upload.failure).toBeUndefined();
    return upload;
  };

  type CoverageCell = {
    family: string;
    completeness_basis: string;
    observed_unique: number | null;
  };
  // Round 3 (proof v1 finding, leg B): the report's array of per-family coverage cells is
  // called `families`, not `coverage` (src/scout/reconciliation/types.ts:324,
  // `ReconciliationReportV1.families: readonly ReconciliationFamilyV1[]`; confirmed live-passing
  // at test/scout/s10/s10-unseen.pg.spec.ts:302-303, `basis.report.families.find(...)`). There is
  // a same-named but unrelated `coverage` field on the (different) RunFactsV1 type
  // (types.ts:242, a Record, not an array) that this file never reads.
  type Report = { families: CoverageCell[]; [key: string]: unknown };
  const coverage = (report: Report): CoverageCell[] => report.families;
  const byFamily = (report: Report, family: string): CoverageCell => {
    const cell = report.families.find((c) => c.family === family);
    if (cell === undefined) throw new Error(`no coverage cell for family ${family}`);
    return cell;
  };

  it(
    'J19 leg A (native-clean): J01 -> J09 -> J12 -> J17 on two processes, ending `complete` ' +
      'with an EMPTY step-11 native roster read (nothing staged, D-S11-2 row 11)',
    async () => {
      const first = FIRST();
      const second = SECOND();

      // ---- J01: setup to Start across processes; a replayed Start returns the identical result.
      const init = await h.pairInit('P1', COACH_A);
      expect(init.failure).toBeUndefined();
      const redeem = await h.pairRedeem('P2', init.result.pairing_code);
      expect(redeem.failure).toBeUndefined();
      const intentId: string = init.result.import_intent_id;
      const current = await h.pairCurrent('P1', COACH_A);
      expect(current.failure).toBeUndefined();
      expect(current.result.status).toBe('paired');
      const started = await h.startRun('P2', COACH_A, intentId);
      expect(started.failure).toBeUndefined();
      expect(h.runCount()).toBe(1);
      const replayedStart = await h.startRun('P1', COACH_A, intentId);
      expect(replayedStart.failure).toBeUndefined();
      expect(replayedStart.result).toEqual(started.result);
      expect(h.runCount()).toBe(1);

      // ---- J17 (partial, before declaration): readiness is `open`, not declared, before any
      // declaration exists — the readiness block the phone renders while waiting on J6.
      const earlyReadiness = await h.pairSession('P2', COACH_A, intentId);
      expect(earlyReadiness.failure).toBeUndefined();
      expect(earlyReadiness.result.readiness).toEqual({
        run: 'open',
        source_declared: false,
        declared_platforms: 0,
      });

      // ---- J09: two platforms declared, transferred and observed across hosts, native-clean
      // (NO `clients` row on either platform — the D2 native-clean shape this leg must stay in).
      const declared = await h.induction.declare('P1', COACH_A, intentId, [first, second]);
      expect(declared.failure).toBeUndefined();
      const challenge: string = declared.result.challenge_b64;

      // ---- J17 (after declaration, before settle): `source_declared` true, `declared_platforms`
      // 2, run still `open` — read from the OTHER host than the one that declared.
      const midReadiness = await h.pairSession('P2', COACH_A, intentId);
      expect(midReadiness.failure).toBeUndefined();
      expect(midReadiness.result.readiness).toEqual({
        run: 'open',
        source_declared: true,
        declared_platforms: 2,
      });

      await transferRows(COACH_A, intentId, first, 'P2', first.nativeClean);
      await transferRows(COACH_A, intentId, second, 'P1', second.nativeClean);
      expect(h.stagedCount(COACH_A, intentId)).toBe(
        first.nativeClean.length + second.nativeClean.length,
      );
      // Every staged group is a token of a native family; no roster token anywhere in this leg.
      for (const row of [...first.nativeClean, ...second.nativeClean]) {
        expect(row.token).not.toBe('u10-members');
      }

      await observeRows('P1', COACH_A, intentId, first, first.nativeClean, challenge);
      await observeRows('P2', COACH_A, intentId, second, second.nativeClean, challenge);
      const observed = h.observationRows(COACH_A, intentId);
      expect(observed.length).toBe(first.families.length + second.families.length);

      // ---- J12 (G1): the claim commits on P1 and P1 is killed mid-reconstruction; the replayed
      // claim on P2 re-drives the settle to the identical terminal verdict — the honest fix for
      // "press Start once, zero routine actions" surviving a process loss.
      const victim = pg.worker({
        ...h.INDUCTION,
        host: 'P1',
        role: 'ext',
        action: 'complete',
        coach: COACH_A,
        intent: intentId,
        body: { terminal_status: 'success' },
        pause: 'after-row',
        pauseRow: 1,
      });
      expect(await victim.ready).toBe('after-row');
      victim.stop();
      await expect(victim.done).rejects.toThrow(/worker exited/);
      const interrupted = h.runRow(COACH_A, intentId);
      expect(interrupted).toMatchObject({
        terminal_status: null,
        fenced_at: null,
        phase: 'reconciling',
        execution_epoch: 1,
      });
      expect(h.settledBasisRows(COACH_A, intentId)).toEqual([]);

      // A status read on the OTHER host sees the open run truthfully and writes nothing (H-S).
      const midStatus = await h.induction.status('P2', COACH_A, intentId);
      expect(midStatus.failure).toBeUndefined();
      expect(midStatus.result).toMatchObject({
        status: 'running',
        phase: 'reconciling',
        claimed_status: 'success',
      });
      expect(
        midStatus.queries.filter((q: string) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q)),
      ).toEqual([]);

      // The replayed claim on P2 re-drives the settle: exactly one terminal write, but the push
      // and analytics event stay first-claim-only (src/scout/scout.service.ts:369-371's own
      // docblock; the `completeServerRun` P2002 branch at :407-412 calls `onTransferSettled`
      // directly and never `notifyComplete` or `analytics.capture`, unlike the firstTime path at
      // :415-419) — confirmed live-passing at test/scout/s11/settle-redrive.pg.spec.ts:263-266's
      // `expectNoClaimSideEffects(replay)`, which asserts `replay.pushes` is 0, not 1, for the
      // identical G1-redrive shape this leg drives on two real processes instead of one.
      const redrive = await h.induction.complete('P2', COACH_A, intentId);
      expect(redrive.failure).toBeUndefined();
      expect(redrive.result).toEqual(ack(intentId));
      expect(redrive.queries.filter(isTerminal)).toHaveLength(1);
      expect(redrive.pushes).toBe(0);
      const run = h.runRow(COACH_A, intentId);
      expect(run).toMatchObject({
        terminal_status: 'complete',
        reason_code: null,
        phase: 'reconciling',
        execution_epoch: 1,
      });
      expect(h.settledBasisRows(COACH_A, intentId).length).toBe(1);

      // A THIRD claim (after the terminal) is a no-op: ack, no further terminal or basis write.
      const third = await h.induction.complete('P1', COACH_A, intentId);
      expect(third.failure).toBeUndefined();
      expect(third.result).toEqual(ack(intentId));
      expect(third.queries.filter(isTerminal)).toHaveLength(0);
      expect(third.pushes).toBe(0);
      expect(h.settledBasisRows(COACH_A, intentId).length).toBe(1);

      // ---- Uninterrupted-equivalence: the re-driven verdict is `complete` with no condition, the
      // required families all KNOWN, and identity cells fully resolved — the same shape J09 proves
      // for an uninterrupted run of this exact native-clean pair.
      const basis = h.settledBasisRows(COACH_A, intentId)[0];
      expect(basis.report).toMatchObject({ basis: 'settled', conditions: [] });
      expect(basis.report.required_families).toEqual(['clients', 'programs', 'workouts']);
      for (const cell of coverage(basis.report)) {
        expect(cell.completeness_basis).toBe('source_signed_enumeration');
      }
      expect(byFamily(basis.report, 'clients').observed_unique).toBe(0);

      // ---- J17 (terminal): readiness reads `terminal` on either host, with no reason code leaked.
      // Round 4 (proof v2 finding, leg A :313): `pairCurrent`'s third argument is the SETUP
      // NONCE (test/utils/g2-s11-harness.ts `pairCurrent = (host, coach, nonce?)` ->
      // `pairing.current(coach, nonce)`, src/extension-pair/extension-pair.service.ts `current`:
      // a nonce filters `setup_nonce`), so passing the intent id there read a setup that does
      // not exist -> 404 "Pairing session not found". The nonce-less read (the coach's current,
      // non-superseded setup) is the live-passing terminal-readiness precedent at
      // test/scout/s11/readiness.pg.spec.ts:139-144 (R4, `h.pairCurrent('P1', COACH)` after the
      // run went terminal), and J01 above already read this same coach's setup that way.
      const lateReadiness = await h.pairCurrent('P2', COACH_A);
      expect(lateReadiness.failure).toBeUndefined();
      expect(lateReadiness.result.readiness).toEqual({
        run: 'terminal',
        source_declared: true,
        declared_platforms: 2,
      });
      expect(JSON.stringify(lateReadiness.result)).not.toContain('complete');

      // ---- Step 11 (native review): the final roster read lists EXACTLY the reconstructed
      // identities — for this native-clean run that is the exact EMPTY roster, asserted empty
      // BECAUSE none were staged (not because of a failure or a non-`complete` terminal).
      // Round 4: the empty projection is DISCRIMINATED from a blind reader by a direct read of
      // the coach's Person rows (test/scout/s11/journey-induction.pg.spec.ts:147 and
      // settle-redrive.pg.spec.ts:146 read `h.persons(coach)` the same way, live-passing): no
      // Person exists for this coach, so an empty roster is the truth, not a reader gap.
      expect(h.persons(COACH_A)).toEqual([]);
      // S11-E r2 (review B B1): the roster reads go through the TWO-SOURCE induction registry
      // (`h.onInduction`, the registry this leg planned with), not `h.rosterOf`'s single
      // A1-platform REGISTRY, which classifies none of this leg's tokens.
      const rosterP1 = await rosterVia('P1', COACH_A, intentId);
      expect(rosterP1.failure).toBeUndefined();
      expect(rosterP1.result.persons).toEqual([]);
      expect(rosterP1.result.accounting.staged).toBe(0);
      const rosterP2 = await rosterVia('P2', COACH_A, intentId);
      expect(rosterP2.failure).toBeUndefined();
      expect(JSON.stringify(rosterP2.result)).toBe(JSON.stringify(rosterP1.result));

      // Status is byte-identical (apart from the mirror snapshot, which neither host posted) on
      // both hosts, and matches the run row.
      const p1 = await h.induction.status('P1', COACH_A, intentId);
      const p2 = await h.induction.status('P2', COACH_A, intentId);
      expect(JSON.stringify(p2.result)).toBe(JSON.stringify(p1.result));
      expect(p1.result).toMatchObject({ status: 'complete', reason_code: null });
    },
  );

  it(
    'J19 leg B (roster-bearing, S8-D1): the same chain with a staged `clients` row settles ' +
      '`complete` (clients verified through the typed person handoff, qualifier ' +
      'roster_bridge_pending still carried) and step 11 lists exactly the staged people as ' +
      'imported, not yet joined',
    async () => {
      // S8-D1 honesty-sweep flip (docs/decisions/2026-09-26-s8d-person-link.md §5.1). This leg
      // asserted `partial / unresolved_identities` while the `clients` writer was the legacy
      // string handoff. The chain, the staged rows and the roster read are unchanged; only the
      // terminal and the clients cell flip, because of the code D1 landed: `clientsFamily.persist`
      // now calls `persistPerson` (src/scout/reconstruct/families.ts →
      // src/scout/reconstruct/native/person-writer.ts), which creates the Person and a
      // `person`/`created` provenance row in the same transaction; the engine's typed branch
      // ledgers `target_kind: 'person'` beside the target id (src/scout/scout-reconstruct.service.ts);
      // S9 joins ledger and provenance and reads the Person (src/scout/reconciliation/facts.service.ts
      // `readPersons`, `state !== Deleted` → live) so S9-A classifies each roster identity bucket (j)
      // `native_present_verified` (src/scout/reconciliation/reconcile.ts) instead of (f)
      // `evidence_only`. With the first source's signed enumeration covering the roster ids and
      // every other family verified exactly as on leg A, the verdict is `complete` (the D2 shape
      // live-pinned by test/scout/s10/s10-unseen.pg.spec.ts case (h)).
      const first = FIRST();
      const second = SECOND();
      // The first source's batch carries its roster rows ALONGSIDE its native-clean rows —
      // exactly the D2 case (h) shape (`[...ROSTER, ...NATIVE_CLEAN]`), staged this time through
      // the S11 two-host worker instead of D2's single-process live spec.
      const firstRowsWithRoster = [...ROSTER_ROWS, ...first.nativeClean];

      const intentId = await paired(COACH_B);
      const started = await h.startRun('P1', COACH_B, intentId);
      expect(started.failure).toBeUndefined();

      const declared = await h.induction.declare('P2', COACH_B, intentId, [first, second]);
      expect(declared.failure).toBeUndefined();
      const challenge: string = declared.result.challenge_b64;

      await transferRows(COACH_B, intentId, first, 'P1', firstRowsWithRoster);
      await transferRows(COACH_B, intentId, second, 'P2', second.nativeClean);
      expect(h.stagedCount(COACH_B, intentId)).toBe(
        firstRowsWithRoster.length + second.nativeClean.length,
      );
      // Confirms the roster rows really landed staged under family `clients` this leg on purpose.
      const rosterIds = new Set(ROSTER_ROWS.map((r) => r.source_id));
      expect(rosterIds.size).toBe(ROSTER_ROWS.length);

      await observeRows('P2', COACH_B, intentId, first, firstRowsWithRoster, challenge);
      await observeRows('P1', COACH_B, intentId, second, second.nativeClean, challenge);

      // ---- Claim and settle (uninterrupted on this leg — J12's interrupt is proved on leg A;
      // this leg's roster verification is the point being proved, not a second re-drive).
      const done = await h.induction.complete('P1', COACH_B, intentId);
      expect(done.failure).toBeUndefined();
      expect(done.result).toEqual(ack(intentId));

      const run = h.runRow(COACH_B, intentId);
      // S8-D1: a roster-bearing run settles honestly `complete` — every family verified, the
      // basis known for each (source-signed enumeration), no run-level condition left.
      expect(run.terminal_status).toBe('complete');
      expect(run.reason_code).toBeNull();

      const basis = h.settledBasisRows(COACH_B, intentId)[0];
      expect(basis.report.conditions).toEqual([]);
      const clientsCell = byFamily(basis.report, 'clients');
      // D2 case (h) shape (test/scout/s10/s10-unseen.pg.spec.ts, case (h)): the clients cell is
      // now bucket j for every staged person, and the qualifier is STILL asserted — unchanged by
      // D1, descriptive only, never a verdict input (S8-D2 retires it).
      expect(clientsCell).toMatchObject({
        staged_unique: rosterIds.size,
        native_present_verified: rosterIds.size,
        unresolved: 0,
        reasons: [],
        completeness_basis: 'source_signed_enumeration',
        observed_unique: rosterIds.size,
        qualifiers: ['roster_bridge_pending'],
      });
      // The full identities table lives on the settled basis via the roster read below; the
      // point proved here is verification + qualifier, matching D2 case (h) exactly.

      // ---- J17 (terminal, roster-bearing): readiness still reads only `terminal`, never leaking
      // an outcome or a reason code — the same neutral contract as leg A's terminal read (the
      // two `not.toContain` checks stay meaningful: nothing about the verdict may surface here).
      const readiness = await h.pairSession('P2', COACH_B, intentId);
      expect(readiness.failure).toBeUndefined();
      expect(readiness.result.readiness).toEqual({
        run: 'terminal',
        source_declared: true,
        declared_platforms: 2,
      });
      expect(JSON.stringify(readiness.result)).not.toContain('partial');
      expect(JSON.stringify(readiness.result)).not.toContain('unresolved_identities');

      // ---- Step 11 (native review), the roster-bearing leg: the roster read lists EXACTLY the
      // staged people as imported, not yet joined (PersonState.InvitePending) — never a login
      // principal, and never silently promoted to a client. S8-D1 kept this read's promise: the
      // run above now settles `complete` and this same read keeps listing these people, still
      // InvitePending (no User minted — D-S8-2 (a); the bridge itself is S8-D2).
      const roster = await rosterVia('P1', COACH_B, intentId);
      expect(roster.failure).toBeUndefined();
      // Response-level bridge-pending qualifier (src/scout/scout-roster.service.ts:178-179,
      // `roster_bridge_pending: ROSTER_BRIDGE_PENDING`; the constant is defined fixed `true` at
      // src/scout/scout-roster.dto.ts:42, `ROSTER_BRIDGE_PENDING = true as const`) — the native
      // roster response's own field for "imported, not yet joined," asserted alongside the
      // per-person `InvitePending` state below, not merely narrated in a comment.
      expect(roster.result.roster_bridge_pending).toBe(true);
      // S11-E (src/scout/scout-roster.service.ts, `classifyFamilyScope`): `staged` counts the
      // staged (source_platform, token) groups that classify to the roster family through the
      // engine's registry — so the D2 roster token counts here although it is not literally
      // `clients` (the proof v2 leg-B failure at :426, `staged` 0 vs 2, was the reader filtering
      // `entity_type == 'clients'`). `unclassified` is the additive honesty field: staged rows
      // NO spec classifies. It is 0 here because the read goes through the two-source induction
      // registry (`rosterVia` → `h.onInduction`; review B B1: `h.rosterOf` carries the single
      // A1-platform REGISTRY, under which every token of this leg is unclassified) and the
      // worker hands the reader the SAME composed registry the engine planned with
      // (test/utils/g2-s11-worker.cjs `roster.sourceMappers = reconstruct.sourceMappers`), so
      // the second source's rows classify to their own native families. Traced against that
      // registry: (first, roster token) → clients: staged 2; (first, two native tokens) and
      // (second, two native tokens) → their own families: unclassified 0.
      expect(roster.result.accounting.unclassified).toBe(0);
      expect(roster.result.accounting.staged).toBe(rosterIds.size);
      const gotIds = roster.result.persons
        .map((p: { source_person_id: string }) => p.source_person_id)
        .sort();
      expect(gotIds).toEqual([...rosterIds].sort());
      for (const person of roster.result.persons) {
        expect(person.state).toBe('InvitePending');
        expect(person.source_platform).toBe(first.platform);
      }
      const rosterOther = await rosterVia('P2', COACH_B, intentId);
      expect(JSON.stringify(rosterOther.result)).toBe(JSON.stringify(roster.result));
    },
  );

  /* ---------------------------------------------------------------------------------------
   * J20 (CORE DIFF, D-S10-5 / D-S11-7(7)) -- a deterministic check. Round 2 (S11D review B1):
   * this check now lives INSIDE the outer `live(...)` gate, exactly like every other pg case
   * in this file -- it does NOT run in the default no-DB/CI config, and reports `skipped`
   * there, never a false pass. It runs only in the parent's S11 lane proof, in a full-history
   * local clone (never GitHub Actions' shallow `actions/checkout@v6` default depth-1 checkout,
   * which does not carry the historical commits these checks resolve). J20's evidence is
   * therefore a PARENT-ONLY proof-lane receipt (this builder does not run
   * G2_S11_DATABASE_URL itself, per WORKER_RULES SS3) -- not a claim of a passing default CI
   * run.
   *
   * Two parts, both must hold, and both fail hard -- never silently pass -- if a pinned
   * commit is missing from history (see the ancestor check immediately below, which the other
   * two checks depend on and which itself throws via `git rev-parse --verify` if a SHA is
   * absent):
   *   (1) `rg -F -l <slug> src --type ts` finds NOTHING for every source slug this S11 slice
   *       touches (s10_unseen, and the S11-A2 second source `s11_second`), over EACH S11 slice
   *       commit's OWN src hunk -- not the working tree, and not one collapsed range, so that a
   *       slug hidden by an intermediate revert could not slip through a range diff.
   *   (2) `scripts/s10-core-diff-gate.sh` (unowned by this slice; D-S10-4/D-S10-5, S10-D) still
   *       passes against its pinned B, exactly as D2's own gate run pinned it
   *       (s10d2/d2_gate_summary.md step 9: `bash scripts/s10-core-diff-gate.sh 7fdcbc044dba...`).
   *
   * "Each S11 slice commit's own src hunk": the landed commits that touch `src/` between
   * S11-A1 (3db615c0, which touches no `src/`) and this slice's base (03e7a234) -- S11-C
   * (7fdcbc04), S10-D D2 part 1 (144269d1, the source asset JSON -- D2 part 2 275e458c touches
   * no `src/`), S11-B (645fb6db) and S11-B r2 (dda794d7). Each is diffed against ITS OWN
   * immediate parent (`git diff <commit>^ <commit> -- src`), not a collapsed range, and
   * requires no scratch clone: `git show` reads history read-only. D2 is included because the
   * grant names its source (`s10_unseen`) explicitly ("incl. s10_unseen and the A2 second
   * source"); S11-A2 (03e7a234) itself touches no `src/` either (its second source is
   * data-only under test/fixtures, D-S11-7(7)), confirmed by its own empty diff below.
   *
   * Round 2 (S11D review C): SLICE_COMMITS below is a curated, manually pinned list, not a
   * discovered one. A companion check ("no unlisted src-touching commit slipped in") walks
   * `git rev-list 3db615c0^..S11_RANGE_END`, diffs EVERY commit in that full range against
   * its own parent for `-- src`, and fails loudly if any src-touching commit is absent from
   * SLICE_COMMITS -- so a rebase/insertion inside the range that adds an uncovered src commit
   * is caught here rather than silently passing the two checks above (which only ever iterate
   * the pinned list itself, and could not otherwise notice a missing entry).
   *
   * S11-E: the range is closed at S11_RANGE_END (the S11-E src commit), not at `HEAD`: the
   * S11 slice's src surface is now complete, and later slices (S12+) pin their own ranges
   * under their own gates rather than silently widening this one. The ancestor check
   * includes S11_RANGE_END, so the walk can never run over an unreachable end.
   * --------------------------------------------------------------------------------------- */
  const repoRoot = resolve(__dirname, '../../..');
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

  /** Every S11-slice commit that changed `src/**`, diffed against its OWN immediate parent. */
  const SLICE_COMMITS = [
    '3db615c0a5e64a63b910d34ce7c732ee6e63f24d', // S11-A1 (no src change; included for completeness)
    '7fdcbc044dba1747d0db2f2750ced951f3b6b752', // S11-C
    '144269d13db5275a2d6689bebb2f7dca8367593c', // S10-D D2 part 1 (s10_unseen source assets)
    '275e458ca5a6b3684bb6ec83edb2a854056a6fd0', // S10-D D2 part 2 (no src change)
    '645fb6db022f2ef6299ed4aa2bcd3f409d2a8298', // S11-B (settle re-drive)
    'dda794d7e8bee0482a7ad373795fcc51dcf54bb5', // S11-B r2 (raw-query retry)
    '03e7a2344ef95b019c751983527bbc9f78200921', // S11-A2 (no src change; the base this slice builds on)
    'ce37c6eeb49be1d65ee7c38f86068bd92af824b0', // S11-E (readers classify tokens through the registry)
  ];
  /** The last commit of the S11 slice's src surface (S11-E); the full-range walk ends here. */
  const S11_RANGE_END = 'ce37c6eeb49be1d65ee7c38f86068bd92af824b0';
  /** The pinned B for scripts/s10-core-diff-gate.sh (D2 diagnose/fix gate run; s10d2/d2_diagnose_fix.md
   *  lines 129-130: `s10-core-diff-gate.sh 7fdcbc044dba...` -> `PASS B=7fdcbc04... HEAD=275e458c...`). */
  const GATE_B = '7fdcbc044dba1747d0db2f2750ced951f3b6b752';
  /** The exact HEAD that gate run was pinned against (D2 part 2's own landed commit). The gate
   *  script's `ALLOWED` array is a literal list of D2's 8 files, so it can only ever pass with
   *  HEAD checked out AT that D2 commit -- never at a later HEAD carrying S11-B/S11-C's own
   *  files on top, which is why this check runs in a disposable, read-only scratch worktree
   *  pinned to GATE_HEAD, not against `git rev-parse HEAD` of this repository. */
  const GATE_HEAD = '275e458ca5a6b3684bb6ec83edb2a854056a6fd0';
  /** Every source slug this S11 slice touches (read from the D2 and A2 fixtures, never typed). */
  const SLUGS = (): string[] => {
    const d2: { source_platform: string } = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/scout/s10_unseen/staged-rows.json'), 'utf8'),
    );
    const a2: { source_platform: string } = JSON.parse(
      readFileSync(join(__dirname, '../../fixtures/scout/s11/s11_second/staged-rows.json'), 'utf8'),
    );
    return [d2.source_platform, a2.source_platform];
  };

  it('every SLICE_COMMITS entry and S11_RANGE_END resolve and are ancestors of HEAD (pins are real, not stale)', () => {
    const head = git(['rev-parse', 'HEAD']).trim();
    for (const commit of [...SLICE_COMMITS, S11_RANGE_END]) {
      const resolved = git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).trim();
      expect(resolved).toBe(commit);
      expect(() => git(['merge-base', '--is-ancestor', commit, head])).not.toThrow();
    }
  });

  it(
    'no src-touching commit in 3db615c0^..S11_RANGE_END is missing from the curated SLICE_COMMITS pins ' +
      '(D-S11D review C: the pins are curated, not discovered -- this walks the FULL range and ' +
      'fails loudly on any uncovered src commit, so a future rebase/insertion cannot silently ' +
      'bypass the two checks below, which only ever iterate the pinned list itself)',
    () => {
      const base = '3db615c0a5e64a63b910d34ce7c732ee6e63f24d';
      const range = git(['rev-list', `${base}^..${S11_RANGE_END}`])
        .split('\n')
        .filter(Boolean);
      expect(range.length).toBeGreaterThan(0);
      const pinned = new Set(SLICE_COMMITS);
      const missing: string[] = [];
      for (const commit of range) {
        const changed = git(['diff', '--name-only', `${commit}^`, commit, '--', 'src'])
          .split('\n')
          .filter(Boolean);
        if (changed.length > 0 && !pinned.has(commit)) {
          missing.push(
            `${commit}: touches src/ (${changed.join(', ')}) but is NOT in SLICE_COMMITS`,
          );
        }
      }
      expect(missing).toEqual([]);
    },
  );

  it(
    "rg -F -l finds no source slug in any S11 slice commit's own src/**/*.ts hunk " +
      '(D-S11-7(7); a deterministic per-commit check, not a collapsed range)',
    () => {
      const slugs = SLUGS();
      expect(slugs.length).toBe(2);
      expect(new Set(slugs).size).toBe(2); // distinct slugs, as D-S11-1 requires
      const failures: string[] = [];
      for (const commit of SLICE_COMMITS) {
        let changed: string[];
        try {
          changed = git(['diff', '--name-only', `${commit}^`, commit, '--', 'src'])
            .split('\n')
            .filter(Boolean);
        } catch (e) {
          failures.push(`${commit}: git diff failed: ${String(e)}`);
          continue;
        }
        if (changed.length === 0) continue; // this commit touches no src/ (e.g. A1, A2, D2 part 2)
        for (const path of changed) {
          if (!path.endsWith('.ts')) continue; // rg --type ts scope; JSON source assets are data
          let blob: string;
          try {
            blob = git(['show', `${commit}:${path}`]);
          } catch (e) {
            failures.push(`${commit}:${path}: git show failed: ${String(e)}`);
            continue;
          }
          for (const slug of slugs) {
            if (blob.includes(slug)) {
              failures.push(
                `CORE DIFF VIOLATION: commit ${commit} path ${path} contains the source slug ` +
                  `"${slug}" in a .ts hunk -- a new source must never be keyed by platform slug ` +
                  `in src/**/*.ts (D-S11-7(7), D-S10-5).`,
              );
            }
          }
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it(
    'scripts/s10-core-diff-gate.sh still passes against its pinned B at the pinned D2 HEAD ' +
      '(7fdcbc04.../275e458c..., s10d2/d2_diagnose_fix.md L129-130) -- run in a disposable, ' +
      "read-only scratch worktree, since the gate's ALLOWED array is a literal list of D2's " +
      "8 files and can only ever match AT that commit, never at this slice's own later HEAD",
    () => {
      const scratch = join(
        os.tmpdir(),
        `s11d-core-diff-gate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      let output = '';
      let rc = 0;
      try {
        git(['worktree', 'add', '--detach', scratch, GATE_HEAD]);
        try {
          output = execFileSync('bash', ['scripts/s10-core-diff-gate.sh', GATE_B, 'HEAD'], {
            cwd: scratch,
            encoding: 'utf8',
          });
        } catch (e: unknown) {
          const err = e as { status?: number; stdout?: string; stderr?: string };
          rc = err.status ?? 1;
          output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        }
      } finally {
        // Always clean up the scratch worktree, pass or fail, so no disposable material is left
        // behind (mirrors D2's own negative-control cleanup discipline, d2_gate_summary.md).
        try {
          git(['worktree', 'remove', scratch, '--force']);
        } catch {
          /* best-effort cleanup; the outer expects below are the actual assertion */
        }
      }
      // A clear failure message on any non-zero exit: the gate's own PASS/FAIL line, verbatim.
      expect({ rc, output }).toMatchObject({ rc: 0 });
      expect(output).toContain(`s10-core-diff-gate: PASS B=${GATE_B} HEAD=${GATE_HEAD}`);
    },
  );
});
