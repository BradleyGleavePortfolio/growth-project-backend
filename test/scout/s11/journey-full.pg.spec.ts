/**
 * S11-D — the full two-host journey (J19) and the core-diff check (J20).
 * docs/decisions/2026-09-26-s11-journey.md D-S11-8 row S11-D; §3 J19-J20; §4 invariant
 * cross-check row "CORE DIFF = 0"; D-S11-6 (spec cases only, the ONE S11 harness, unchanged);
 * OWNER_DECISION_S8D_2026-09-26.md (the mandatory honesty rule below).
 *
 * MANDATORY HONESTY (S11D_BUILD_GRANT.md; s10d2/d2_diagnose_fix.md): at this head a run that
 * stages ANY `clients` row cannot settle `complete` — the legacy Person handoff ledgers
 * `target_kind NULL`, S9-A buckets it (f) `unresolved:evidence_only`, and the run-level condition
 * `unresolved_identities` holds regardless of coverage (D2 case (h); S8-D is the owner-decided,
 * not-yet-built fix, OWNER_DECISION_S8D_2026-09-26.md). J19 therefore proves TWO separate legs on
 * TWO separate runs, never claims `complete` for a roster-bearing run, and states here — not just
 * in a comment buried in the assertions — that the roster-bearing leg's terminal is expected to
 * flip from `partial/unresolved_identities` to `complete` only after S8-D lands:
 *   Leg A (native-clean): J01 (setup/pair/Start across P1+P2, replayed Start) -> J09 (two
 *   platforms declared, transferred and observed across hosts, no `clients` row staged) -> J12
 *   (the settle is interrupted by a real process kill after the claim commits; the replayed claim
 *   on the OTHER host re-drives it to the identical verdict) -> J17 (readiness reads `terminal`)
 *   -> step 11, the native roster read, which is asserted EMPTY because none were staged (D-S11-2
 *   row 11) — not because the read failed or the run is not `complete`.
 *   Leg B (roster-bearing): the SAME declare/transfer/observe/complete chain, but the first
 *   platform's batch ALSO includes its roster token (D2's `u10-members`, family `clients`) beside
 *   the native-clean rows — exactly the D2 case (h) shape. This leg settles `partial` with
 *   `reason_code unresolved_identities` and qualifier `roster_bridge_pending` on the `clients`
 *   family (never `complete`, honestly), and its native roster read lists EXACTLY the staged
 *   people, `state: InvitePending` ("imported, not yet joined"), never a login principal.
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
 * typed in this file (grep-checked by the guard spec's existing "no real platform slug" rule and
 * re-confirmed by a static check below); the fixture's `source_platform` field is read at runtime.
 *
 * "P1"/"P2" label the host process; "phone"/"ext" label the client role, never an authenticated
 * principal (D-S11-1). Lane: the S11-only disposable PG17 lane (G2_S11_*). Without
 * G2_S11_DATABASE_URL this file is inert (describe.skip) and loads no harness. Run alone and in
 * band (it resets the lane's rows before every case):
 *   jest --runInBand test/scout/s11/journey-full.pg.spec.ts
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
  type Report = { coverage: CoverageCell[]; [key: string]: unknown };
  const coverage = (report: Report): CoverageCell[] => report.coverage;
  const byFamily = (report: Report, family: string): CoverageCell => {
    const cell = report.coverage.find((c) => c.family === family);
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

      // The replayed claim on P2 re-drives the settle: exactly one terminal write, one push.
      const redrive = await h.induction.complete('P2', COACH_A, intentId);
      expect(redrive.failure).toBeUndefined();
      expect(redrive.result).toEqual(ack(intentId));
      expect(redrive.queries.filter(isTerminal)).toHaveLength(1);
      expect(redrive.pushes).toBe(1);
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
      const lateReadiness = await h.pairCurrent('P2', COACH_A, intentId);
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
      const rosterP1 = await h.rosterOf('P1', COACH_A, intentId);
      expect(rosterP1.failure).toBeUndefined();
      expect(rosterP1.result.persons).toEqual([]);
      expect(rosterP1.result.accounting.staged).toBe(0);
      const rosterP2 = await h.rosterOf('P2', COACH_A, intentId);
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
    'J19 leg B (roster-bearing, MANDATORY HONESTY): the same chain with a staged `clients` ' +
      'row settles `partial/unresolved_identities` (qualifier roster_bridge_pending) — NEVER ' +
      '`complete` at this head — and step 11 lists exactly the staged people as imported, not ' +
      'yet joined',
    async () => {
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
      // this leg's own honesty is the point being proved, not a second re-drive).
      const done = await h.induction.complete('P1', COACH_B, intentId);
      expect(done.failure).toBeUndefined();
      expect(done.result).toEqual(ack(intentId));

      const run = h.runRow(COACH_B, intentId);
      // MANDATORY HONESTY: never `complete` for a roster-bearing run at this head.
      expect(run.terminal_status).toBe('partial');
      expect(run.reason_code).toBe('unresolved_identities');
      expect(run.terminal_status).not.toBe('complete');

      const basis = h.settledBasisRows(COACH_B, intentId)[0];
      expect(basis.report.conditions).toEqual(['unresolved_identities']);
      const clientsCell = byFamily(basis.report, 'clients');
      expect(clientsCell).toMatchObject({
        completeness_basis: 'source_signed_enumeration',
        observed_unique: rosterIds.size,
      });
      // The full identities table lives on the settled basis via the roster read below; the
      // point proved here is qualifier + honesty, matching D2 case (h) exactly.

      // ---- J17 (terminal, roster-bearing): readiness still reads only `terminal`, never leaking
      // `partial` or the reason code — the same neutral contract as leg A's terminal read.
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
      // principal, and never silently promoted to a client. This is the truth S8-D changes: once
      // it lands, an otherwise-identical run is expected to settle `complete` and this same read
      // is expected to keep listing these people, now bridged (owner-decided, not built here).
      const roster = await h.rosterOf('P1', COACH_B, intentId);
      expect(roster.failure).toBeUndefined();
      expect(roster.result.accounting.staged).toBe(rosterIds.size);
      const gotIds = roster.result.persons
        .map((p: { source_person_id: string }) => p.source_person_id)
        .sort();
      expect(gotIds).toEqual([...rosterIds].sort());
      for (const person of roster.result.persons) {
        expect(person.state).toBe('InvitePending');
        expect(person.source_platform).toBe(first.platform);
      }
      const rosterOther = await h.rosterOf('P2', COACH_B, intentId);
      expect(JSON.stringify(rosterOther.result)).toBe(JSON.stringify(roster.result));
    },
  );

  it('this file types no source-platform-slug literal (D-S11-7(7); own static check)', () => {
    const text = readFileSync(__filename, 'utf8');
    const slugs = [FIRST().platform, SECOND().platform];
    for (const slug of slugs) expect(text.includes(slug)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------
 * J20 (CORE DIFF, D-S10-5 / D-S11-7(7)) — a deterministic, no-database check. It needs no
 * PostgreSQL and runs regardless of the S11 lane env var (it is not inside the `live(...)`
 * block above): it only reads this git repository's own history and runs one repository script.
 *
 * Two parts, both must hold:
 *   (1) `rg -F -l <slug> src --type ts` finds NOTHING for every source slug this S11 slice
 *       touches (s10_unseen, and the S11-A2 second source `s11_second`), over EACH S11 slice
 *       commit's OWN src hunk -- not the working tree, and not one collapsed range, so that a
 *       slug hidden by an intermediate revert could not slip through a range diff.
 *   (2) `scripts/s10-core-diff-gate.sh` (unowned by this slice; D-S10-4/D-S10-5, S10-D) still
 *       passes against its pinned B, exactly as D2's own gate run pinned it
 *       (s10d2/d2_gate_summary.md step 9: `bash scripts/s10-core-diff-gate.sh 7fdcbc044dba...`).
 *
 * "Each S11 slice commit's own src hunk": the landed commits that touch `src/` between S11-A1
 * (3db615c0, which touches no `src/`) and this slice's base (03e7a234) -- S11-C (7fdcbc04),
 * S10-D D2 part 1 (144269d1, the source asset JSON -- D2 part 2 275e458c touches no `src/`),
 * S11-B (645fb6db) and S11-B r2 (dda794d7). Each is diffed against ITS OWN immediate parent
 * (`git diff <commit>^ <commit> -- src`), not a collapsed range, and requires no scratch clone:
 * `git show` reads history read-only. D2 is included because the grant names its source
 * (`s10_unseen`) explicitly ("incl. s10_unseen and the A2 second source"); S11-A2 (03e7a234)
 * itself touches no `src/` either (its second source is data-only under test/fixtures, D-S11-7(7)),
 * confirmed by its own empty diff below.
 * ------------------------------------------------------------------------------------------- */
describe('J20 -- CORE DIFF = 0 (no database; runs on every lane)', () => {
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
  ];
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

  it('every SLICE_COMMITS entry resolves and is an ancestor of HEAD (pins are real, not stale)', () => {
    const head = git(['rev-parse', 'HEAD']).trim();
    for (const commit of SLICE_COMMITS) {
      const resolved = git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).trim();
      expect(resolved).toBe(commit);
      expect(() => git(['merge-base', '--is-ancestor', commit, head])).not.toThrow();
    }
  });

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
