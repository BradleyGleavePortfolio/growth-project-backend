/**
 * S11-B real-PG proof: the re-drivable settle (docs/decisions/2026-09-26-s11-journey.md D-S11-4;
 * §3 J12-J15; D-S11-8 row S11-B). G1: a claim that committed on one host and whose settle died
 * with that host's process must be finished by the replayed claim on the other host, with exactly
 * the verdict an uninterrupted run gets — no duplicate native, provenance or ledger row, no second
 * push, no second `scout.ingest.completed`.
 *
 * Every step is the real service in a NEW OS process (test/utils/g2-s11-worker.cjs, the ONE S11
 * harness, used unchanged by import only). The kill is a real process termination: the worker
 * pauses at the harness `after-row` barrier (after the `pauseRow`-th COMMITTED gated transaction:
 * 1 = the claim itself, 2 = claim plus the first reconstruction row) and is `stop()`ped there. The
 * J13 race stands BOTH replays at the `before-lock` barrier — the barrier in front of the settle
 * tail's `FOR NO KEY UPDATE`, the first such statement on the replay path — and waits for both
 * `ready` signals before releasing either (review A B-1 / review B B1): reaching it is a positive
 * per-worker observation that the claim was refused, the eligibility gate re-read the run and the
 * pass ran while the run was still open.
 *
 * "P1"/"P2" label the host process; "phone"/"ext" label the client role, never a principal.
 * Lane: the S11-only disposable PG17 lane (G2_S11_*). Without G2_S11_DATABASE_URL this file is
 * inert (describe.skip) and loads no harness. Run it alone and in band (it resets the lane's rows
 * before every case):
 *   jest --runInBand test/scout/s11/settle-redrive.pg.spec.ts
 */

// A module, not a script: journey-core.pg.spec.ts declares the same top-level names as a script
// (it has no import/export), and tsc compiles both files in one program.
export {};

type Harness = typeof import('../../utils/g2-s11-harness');
type PgHarness = typeof import('../../utils/g2-s11-pg-harness');
type Result = import('../../utils/g2-s11-pg-harness').Result;
type Host = import('../../utils/g2-s11-harness').Host;

jest.setTimeout(600000);

const live = process.env.G2_S11_DATABASE_URL ? describe : describe.skip;

const COACH = 's11b-coach-a';
const OTHER = 's11b-coach-b';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const CAT_SLUG = 'synthetic-back-squat';
const SETTLED_BASIS = 'ScoutRunSettledBasis';
const PROGRAM = { title: 'Base Block', weeks: 4, days: 3, notes: 'synthetic' };
const WORKOUT = {
  title: 'Push Day',
  kind: 'lift',
  minutes: 45,
  exercises: [{ id: 'e1', exercise: CAT_ID, sets: 3, reps: 8, kg: 100 }],
};
const ack = (intent_id: string) => ({ acknowledged: true, intent_id });
const isGate = (q: string) => /SET last_observed_at\s*=/.test(q);
const isTerminal = (q: string) =>
  /UPDATE "ScoutImport"/.test(q) && /SET terminal_status = /.test(q);
const isBasisInsert = (q: string) =>
  /^\s*INSERT INTO (?:"public"\.)?"ScoutRunSettledBasis"/.test(q);
const isCompletionInsert = (q: string) =>
  /^\s*INSERT INTO (?:"public"\.)?"ScoutImportCompletion"/.test(q);
/** The S11-B eligibility read (`isSettlePending`): the only statement naming both tables. */
const isPendingRead = (q: string) =>
  /^\s*SELECT/.test(q) && q.includes('FROM "ScoutImport" r') && /phase = 'reconciling'/.test(q);
const isLock = (q: string) => q.includes('FOR NO KEY UPDATE');
const isMarker = (q: string) => q.startsWith('-- tx:');
const isWrite = (q: string) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q);
/** A write other than the §3.1 gate UPDATE (which a closed gate still issues, matching no row). */
const isNonGateWrite = (q: string) => isWrite(q) && !isGate(q);
const eventsNamed = (r: Result, name: string) =>
  r.events.filter((e: unknown[]) => e[1] === name).length;
const conflict = (code: string) =>
  expect.objectContaining({ status: 409, response: expect.objectContaining({ code }) });

live('S11-B settle re-drive — two hosts over one disposable PG (J12-J15)', () => {
  let h: Harness;
  let pg: PgHarness;

  beforeAll(() => {
    // Lazy: only a live run loads the harness (its import binds and validates the S11 lane).
    h = require('../../utils/g2-s11-harness');
    pg = require('../../utils/g2-s11-pg-harness');
  });
  const fresh = () => {
    h.resetData();
    h.catalog([{ id: CAT_ID, slug: CAT_SLUG }]);
  };
  beforeEach(fresh);
  afterAll(() => {
    if (h) h.resetData();
  });

  /* ---- journey steps (thin: every behaviour is the real service in the worker) ---- */

  /** Steps 1-2 and 4: setup on the phone (P1), pairing on the extension (P2), Start on P2. */
  const pairedAndStarted = async (coach: string, hosts: [Host, Host] = ['P1', 'P2']) => {
    const init = await h.pairInit(hosts[0], coach);
    expect(init.failure).toBeUndefined();
    const redeem = await h.pairRedeem(hosts[1], init.result.pairing_code);
    expect(redeem.failure).toBeUndefined();
    const intentId: string = init.result.import_intent_id;
    const started = await h.startRun(hosts[1], coach, intentId);
    expect(started.failure).toBeUndefined();
    return intentId;
  };
  /** Step 5: five staged rows over four families, batches alternating hosts. */
  const transfer = async (coach: string, intentId: string) => {
    const batches: [Host, string, { sourceId: string; payload: Record<string, unknown> }[]][] = [
      [
        'P1',
        h.TOKEN.clients,
        [
          { sourceId: 'p-1', payload: { name: 'Synthetic p-1' } },
          { sourceId: 'p-2', payload: { name: 'Synthetic p-2' } },
        ],
      ],
      ['P2', h.TOKEN.programs, [{ sourceId: 'blk-1', payload: PROGRAM }]],
      ['P1', h.TOKEN.workouts, [{ sourceId: 'rt-1', payload: WORKOUT }]],
      ['P2', h.TOKEN.client_history, [{ sourceId: 'h-1', payload: { title: 'note' } }]],
    ];
    for (const [host, token, rows] of batches) {
      const batch = await h.ingestBatch(host, coach, intentId, rows, token);
      expect(batch.failure).toBeUndefined();
      expect(batch.result).toEqual({ received: rows.length, deduped: 0 });
    }
    expect(h.stagedCount(coach, intentId)).toBe(5);
  };

  /**
   * The customer-visible verdict and its durable basis, id-free: intents and target ids differ
   * between two runs by construction, so `target_id`, `native_id` and `import_intent_id` are
   * stripped and native targets are counted. Everything else must be byte-equal between an
   * interrupted-then-re-driven run and an uninterrupted reference run.
   */
  const settledShape = (coach: string, intentId: string) => {
    const row = h.runRow(coach, intentId);
    return {
      terminal_status: row.terminal_status,
      state: row.state,
      reason_code: row.reason_code,
      phase: row.phase,
      execution_epoch: row.execution_epoch,
      fenced_at: row.fenced_at,
      completed: row.completed_at !== null,
      ledger_by_token: h.ledgerByToken(coach, intentId),
      ledger: h.ledgerRows(coach, intentId).map(({ target_id: _id, ...rest }) => rest),
      provenance: h
        .provenanceRows(coach)
        .map(({ native_id: _native, import_intent_id: _intent, ...rest }) => rest),
      persons: h.persons(coach).length,
      programs: h.programs(coach).length,
      plans: h.plans(coach).length,
      evidence: h.evidenceRows(coach),
      basis_rows: h.count(SETTLED_BASIS, `coach_id=${pg.quote(coach)}`),
      claims: h
        .completionRows()
        .filter((c: string[]) => c[0] === coach)
        .map((c: string[]) => c[2]),
    };
  };

  /** An uninterrupted run of the same transfer, claimed `terminal` on P1: the reference verdict. */
  const referenceShape = async (terminal = 'success') => {
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    const done = await h.completeRun('P1', COACH, intentId, terminal);
    expect(done.failure).toBeUndefined();
    expect(done.queries.filter(isTerminal)).toHaveLength(1);
    expect(done.pushes).toBe(1);
    const shape = settledShape(COACH, intentId);
    expect(shape.terminal_status).not.toBeNull();
    expect(shape.basis_rows).toBe(1);
    expect(shape.ledger.length).toBeGreaterThanOrEqual(5);
    fresh();
    return shape;
  };

  /**
   * The G1 loss, for real: `complete` on `host` runs the real claim and settle, pauses at the
   * `after-row` barrier once `pauseRow` gated transactions have COMMITTED (1 = the claim; 2 = the
   * claim plus the first reconstruction row) and is killed there. Asserts the persisted picture the
   * replay will find: open run in `reconciling`, the claim stored, no terminal, no basis.
   */
  const completeAndKill = async (
    host: Host,
    coach: string,
    intentId: string,
    pauseRow: number,
    terminal = 'success',
  ) => {
    const victim = pg.worker({
      ...h.REGISTRY,
      host,
      role: 'ext',
      action: 'complete',
      coach,
      intent: intentId,
      body: { terminal_status: terminal },
      pause: 'after-row',
      pauseRow,
    });
    expect(await victim.ready).toBe('after-row');
    victim.stop();
    await expect(victim.done).rejects.toThrow(/worker exited/);
    const row = h.runRow(coach, intentId);
    expect(row).toMatchObject({
      terminal_status: null,
      fenced_at: null,
      phase: 'reconciling',
      execution_epoch: 1,
    });
    expect(h.completionRows().filter((c: string[]) => c[0] === coach)).toEqual([
      [coach, intentId, terminal],
    ]);
    expect(h.count(SETTLED_BASIS)).toBe(0);
    return row;
  };

  /** The per-worker trace of a re-drive: refused claim → rollback → gate → ONE pending read → tail lock. */
  const expectRedriveTrace = (r: Result) => {
    const refused = r.queries.findIndex(isCompletionInsert);
    expect(refused).toBeGreaterThan(-1);
    expect(r.queries.slice(refused + 1).find(isMarker)).toBe('-- tx:rollback');
    const later = r.queries.slice(refused + 1);
    expect(later.filter(isGate).length).toBeGreaterThanOrEqual(1); // the eligibility gate (+ the pass)
    expect(later.filter(isPendingRead)).toHaveLength(1);
    expect(later.filter(isLock).length).toBeGreaterThanOrEqual(1);
    // The pending read runs after the eligibility gate and before any tail lock.
    const gateAt = later.findIndex(isGate);
    const readAt = later.findIndex(isPendingRead);
    const lockAt = later.findIndex(isLock);
    expect(gateAt).toBeLessThan(readAt);
    expect(readAt).toBeLessThan(lockAt);
  };
  /** A replay never pushes and never re-emits the first-claim analytics event. */
  const expectNoClaimSideEffects = (r: Result) => {
    expect(r.pushes).toBe(0);
    expect(r.pushCalls).toEqual([]);
    expect(eventsNamed(r, 'scout.ingest.completed')).toBe(0);
  };

  it('J12 (G1): P1 is killed after the claim and the first reconstruction row committed — the replayed claim on P2 re-drives the settle and the verdict equals the uninterrupted reference; a third claim is a no-op', async () => {
    const reference = await referenceShape();
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    const open = await completeAndKill('P1', COACH, intentId, 2);
    // The killed pass left a partial ledger: at least the first row, not the whole transfer.
    const partial = h.ledgerRows(COACH, intentId);
    expect(partial.length).toBeGreaterThanOrEqual(1);
    expect(partial.length).toBeLessThan(reference.ledger.length);

    // A status read on the other host sees the open run truthfully and writes nothing.
    const read = await h.statusOf('P2', COACH, intentId);
    expect(read.failure).toBeUndefined();
    expect(read.result).toMatchObject({
      status: 'running',
      phase: 'reconciling',
      claimed_status: 'success',
      execution_epoch: 1,
    });
    expect(read.queries.filter(isWrite)).toEqual([]);
    expect(h.runRow(COACH, intentId)).toEqual(open);

    // The replayed claim on P2: refused claim → eligibility → pass → ONE terminal, ONE basis.
    const replay = await h.completeRun('P2', COACH, intentId);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(intentId));
    expectRedriveTrace(replay);
    expectNoClaimSideEffects(replay);
    expect(replay.queries.filter(isTerminal)).toHaveLength(1);
    expect(replay.queries.filter(isBasisInsert)).toHaveLength(1);
    expect(eventsNamed(replay, 'scout.run.settled')).toBe(1);
    const row = h.runRow(COACH, intentId);
    expect(row.terminal_status).not.toBeNull();
    expect(row.state).toBe(row.terminal_status);
    expect(row.completed_at).not.toBeNull();
    expect(row.execution_epoch).toBe(1);
    expect(h.completionRows()).toEqual([[COACH, intentId, 'success']]);
    expect(settledShape(COACH, intentId)).toEqual(reference);
    // Both hosts read the same settled truth.
    const p1 = await h.statusOf('P1', COACH, intentId);
    const p2 = await h.statusOf('P2', COACH, intentId);
    expect(p1.failure).toBeUndefined();
    expect(p1.result).toMatchObject({ status: row.terminal_status, claimed_status: 'success' });
    expect(JSON.stringify(p2.result)).toBe(JSON.stringify(p1.result));

    // Idempotent: a third claim meets a closed gate — ack, no work, nothing changes.
    const shape = settledShape(COACH, intentId);
    const third = await h.completeRun('P1', COACH, intentId);
    expect(third.failure).toBeUndefined();
    expect(third.result).toEqual(ack(intentId));
    expect(third.queries.filter(isCompletionInsert)).toEqual([]);
    expect(third.queries.filter(isPendingRead)).toEqual([]);
    expect(third.queries.filter(isTerminal)).toEqual([]);
    expect(third.queries.filter(isBasisInsert)).toEqual([]);
    expect(third.queries.filter(isNonGateWrite)).toEqual([]);
    expectNoClaimSideEffects(third);
    expect(eventsNamed(third, 'scout.run.settled')).toBe(0);
    expect(h.runRow(COACH, intentId)).toEqual(row);
    expect(settledShape(COACH, intentId)).toEqual(shape);
    expect(h.count(SETTLED_BASIS)).toBe(1);
  });

  it('J12 edge: P1 is killed right after the claim commits (no reconstruction row yet) — the replay on P2 produces the identical reference verdict', async () => {
    const reference = await referenceShape();
    const intentId = await pairedAndStarted(COACH, ['P2', 'P1']);
    await transfer(COACH, intentId);
    await completeAndKill('P1', COACH, intentId, 1);
    expect(h.ledgerRows(COACH, intentId)).toEqual([]);
    const replay = await h.completeRun('P2', COACH, intentId);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(intentId));
    expectRedriveTrace(replay);
    expectNoClaimSideEffects(replay);
    expect(replay.queries.filter(isTerminal)).toHaveLength(1);
    expect(replay.queries.filter(isBasisInsert)).toHaveLength(1);
    expect(eventsNamed(replay, 'scout.run.settled')).toBe(1);
    expect(h.runRow(COACH, intentId).execution_epoch).toBe(1);
    expect(settledShape(COACH, intentId)).toEqual(reference);
  });

  it("J13: two replayed claims race on P1 and P2 — BOTH provably enter the re-drive branch (refused claim, eligibility gate, pass) and stand at the tail lock before either takes it; one terminal write, one basis row, one settled event; the loser's CAS miss is silent", async () => {
    const reference = await referenceShape();
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    await completeAndKill('P1', COACH, intentId, 2);

    // Each replay pauses at `before-lock`, the harness barrier in front of the settle tail's
    // `FOR NO KEY UPDATE` — the first such statement on the replay path. Neither holds the row
    // while the other is at its gate, so both must pass P2002, the eligibility read and the pass.
    const redrive = (host: Host) =>
      pg.worker({
        ...h.REGISTRY,
        host,
        role: 'ext',
        action: 'complete',
        coach: COACH,
        intent: intentId,
        body: { terminal_status: 'success' },
        pause: 'before-lock',
        txTimeout: 60000,
      });
    const a = redrive('P2');
    const b = redrive('P1');
    expect(await Promise.all([a.ready, b.ready])).toEqual(['before-lock', 'before-lock']);
    // Both stand in front of the tail lock: the run is still open and unsettled at this instant.
    expect(h.runRow(COACH, intentId)).toMatchObject({
      terminal_status: null,
      fenced_at: null,
      phase: 'reconciling',
    });
    expect(h.count(SETTLED_BASIS)).toBe(0);
    a.resume();
    b.resume();
    const [ar, br] = await Promise.all([a.done, b.done]);
    for (const r of [ar, br]) {
      expect(r.failure).toBeUndefined();
      expect(r.result).toEqual(ack(intentId));
      expectRedriveTrace(r);
      expectNoClaimSideEffects(r);
      expect(r.queries.filter(isTerminal).length).toBeLessThanOrEqual(1);
      expect(r.queries.filter(isBasisInsert).length).toBeLessThanOrEqual(1);
    }
    const row = h.runRow(COACH, intentId);
    expect(row.terminal_status).not.toBeNull();
    expect(row.execution_epoch).toBe(1);
    expect(h.count(SETTLED_BASIS)).toBe(1);
    expect([...ar.queries, ...br.queries].filter(isTerminal)).toHaveLength(1);
    expect([...ar.queries, ...br.queries].filter(isBasisInsert)).toHaveLength(1);
    expect(eventsNamed(ar, 'scout.run.settled') + eventsNamed(br, 'scout.run.settled')).toBe(1);
    expect(h.completionRows()).toEqual([[COACH, intentId, 'success']]);
    // Two concurrent passes: no duplicate ledger key, no duplicate native, the reference verdict.
    const ledger = h.ledgerRows(COACH, intentId);
    const keys = ledger.map((l) => `${l.entity_type}|${l.source_platform}|${l.source_id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(settledShape(COACH, intentId)).toEqual(reference);
  });

  it('J14: the re-drive preserves the claim — an interrupted `partial` claim replayed as `success` keeps the stored claim and produces the uninterrupted `partial` verdict', async () => {
    const reference = await referenceShape('partial');
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    await completeAndKill('P1', COACH, intentId, 2, 'partial');
    const replay = await h.completeRun('P2', COACH, intentId, 'success');
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(intentId));
    expectRedriveTrace(replay);
    expectNoClaimSideEffects(replay);
    expect(replay.queries.filter(isTerminal)).toHaveLength(1);
    // The only completion statement the replay issued is the refused INSERT: the claim stays.
    expect(replay.queries.filter((q) => /"ScoutImportCompletion"/.test(q) && isWrite(q))).toEqual(
      replay.queries.filter(isCompletionInsert),
    );
    expect(h.completionRows()).toEqual([[COACH, intentId, 'partial']]);
    const read = await h.statusOf('P1', COACH, intentId);
    expect(read.failure).toBeUndefined();
    expect(read.result.claimed_status).toBe('partial');
    expect(read.result.status).toBe(h.runRow(COACH, intentId).terminal_status);
    expect(settledShape(COACH, intentId)).toEqual(reference);
  });

  it("J15 (a): a replay after a clean settle is today's ack no-op — the gate closes before any claim INSERT; no pending read, no terminal, no basis, no push, no event; row and verdict unchanged", async () => {
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    const done = await h.completeRun('P1', COACH, intentId);
    expect(done.failure).toBeUndefined();
    expect(done.pushes).toBe(1);
    const row = h.runRow(COACH, intentId);
    const shape = settledShape(COACH, intentId);
    expect(row.terminal_status).not.toBeNull();
    const replay = await h.completeRun('P2', COACH, intentId);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(intentId));
    expect(replay.queries.filter(isCompletionInsert)).toEqual([]);
    expect(replay.queries.filter(isPendingRead)).toEqual([]);
    expect(replay.queries.filter(isTerminal)).toEqual([]);
    expect(replay.queries.filter(isBasisInsert)).toEqual([]);
    expect(replay.queries.filter(isNonGateWrite)).toEqual([]);
    expectNoClaimSideEffects(replay);
    expect(eventsNamed(replay, 'scout.run.settled')).toBe(0);
    expect(h.runRow(COACH, intentId)).toEqual(row);
    expect(settledShape(COACH, intentId)).toEqual(shape);
  });

  it("J15 (b): a fence after the loss closes the gate — the replay acks without a re-drive; the fence's terminal, epoch and the partial ledger stay exactly as the fence left them", async () => {
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    await completeAndKill('P1', COACH, intentId, 2);
    const fenced = await h.on('P2', 'phone', {
      action: 'fence',
      coach: COACH,
      intent: intentId,
      body: { reason: 'revoked' },
    });
    expect(fenced.failure).toBeUndefined();
    expect(fenced.result).toMatchObject({ execution_epoch: 2 });
    const row = h.runRow(COACH, intentId);
    expect(row).toMatchObject({ fence_reason: 'revoked', execution_epoch: 2 });
    expect(row.terminal_status).not.toBeNull();
    expect(h.count(SETTLED_BASIS)).toBe(0);
    const ledger = h.ledgerRows(COACH, intentId);
    const replay = await h.completeRun('P1', COACH, intentId);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(intentId));
    expect(replay.queries.filter(isCompletionInsert)).toEqual([]);
    expect(replay.queries.filter(isPendingRead)).toEqual([]);
    expect(replay.queries.filter(isTerminal)).toEqual([]);
    expect(replay.queries.filter(isBasisInsert)).toEqual([]);
    expect(replay.queries.filter(isNonGateWrite)).toEqual([]);
    expectNoClaimSideEffects(replay);
    expect(eventsNamed(replay, 'scout.run.settled')).toBe(0);
    expect(h.runRow(COACH, intentId)).toEqual(row);
    expect(h.ledgerRows(COACH, intentId)).toEqual(ledger);
    expect(h.count(SETTLED_BASIS)).toBe(0);
    expect(h.completionRows()).toEqual([[COACH, intentId, 'success']]);
  });

  it('J15 (c): before any claim a paired-but-never-started intent is still 409 run_not_started on either host, with no completion row', async () => {
    const intentId = h.intent(COACH);
    for (const host of ['P1', 'P2'] as Host[]) {
      const refused = await h.completeRun(host, COACH, intentId);
      expect(refused.failure).toEqual(conflict('run_not_started'));
      expect(refused.queries.filter(isCompletionInsert)).toEqual([]);
      expect(refused.queries.filter(isPendingRead)).toEqual([]);
      expectNoClaimSideEffects(refused);
    }
    expect(h.completionRows()).toEqual([]);
    expect(h.runCount()).toBe(0);
  });

  it("tenant scope: coach B's claim under A's stuck intent string never reaches A's gate, pending read or settle (J07 rule: it is B's legacy path); A's run, ledger and claim are byte-equal, and A's own replay then settles", async () => {
    const a = await pairedAndStarted(COACH);
    await transfer(COACH, a);
    const aRow = await completeAndKill('P1', COACH, a, 2);
    const aTargets = h.targetSnapshot(COACH, a);
    const aClaims = h.completionRows().filter((c: string[]) => c[0] === COACH);

    const foreign = await h.completeRun('P2', OTHER, a);
    expect(foreign.failure).toBeUndefined();
    expect(foreign.queries.filter(isGate)).toEqual([]);
    expect(foreign.queries.filter(isPendingRead)).toEqual([]);
    expect(foreign.queries.filter(isTerminal)).toEqual([]);
    expect(foreign.queries.filter(isBasisInsert)).toEqual([]);
    expect(foreign.queries.filter(isLock)).toEqual([]);
    expect(h.runRow(COACH, a)).toEqual(aRow);
    expect(h.targetSnapshot(COACH, a)).toEqual(aTargets);
    expect(h.completionRows().filter((c: string[]) => c[0] === COACH)).toEqual(aClaims);
    expect(h.count(SETTLED_BASIS)).toBe(0);
    // B's own legacy rows are B-keyed only: nothing of B lands under A's tenant.
    expect(h.ledgerRows(OTHER, a)).toEqual([]);
    expect(h.count('ScoutImport', `coach_id=${pg.quote(COACH)}`)).toBe(1);

    const replay = await h.completeRun('P1', COACH, a);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(a));
    expectRedriveTrace(replay);
    expectNoClaimSideEffects(replay);
    expect(replay.queries.filter(isTerminal)).toHaveLength(1);
    expect(h.runRow(COACH, a).terminal_status).not.toBeNull();
    expect(h.count(SETTLED_BASIS, `coach_id=${pg.quote(COACH)}`)).toBe(1);
    expect(h.count(SETTLED_BASIS)).toBe(1);
  });
});
