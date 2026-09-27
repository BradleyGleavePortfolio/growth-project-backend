/**
 * S11-A1 real-PG journey core (docs/decisions/2026-09-26-s11-journey.md D-S11-8 row S11-A1; §3
 * J01-J08). Steps 1, 2, 4, 5 and 7-11 of the journey on LANDED code, service level only.
 *
 * Two worker processes are two server hosts (D-S11-6): P1 and P2 label which process a step runs
 * in, and every step forks a NEW OS process (test/utils/g2-s11-worker.cjs) with its own
 * ScoutService and so its own in-process progress cache. "phone" and "ext" label which client role
 * a step stands for; they are NOT authenticated principals (B2, D-S11-1): the coach id is supplied.
 * The route/guard authentication of each role stays with the accepted route and auth specs.
 *
 * Lane: the S11-only disposable PG17 lane (test/utils/g2-s11-db.ts, G2_S11_*, port double-entered
 * by the operator). Without G2_S11_DATABASE_URL this file is inert (describe.skip) and loads no
 * harness, so the default no-DB suite stays green; with it, the harness import fails closed on any
 * other lane. Run it alone and in band (it resets the lane's rows before every case):
 *   jest --runInBand test/scout/s11/journey-core.pg.spec.ts
 */

type Harness = typeof import('../../utils/g2-s11-harness');
type PgHarness = typeof import('../../utils/g2-s11-pg-harness');
type Result = import('../../utils/g2-s11-pg-harness').Result;
type Host = import('../../utils/g2-s11-harness').Host;

jest.setTimeout(300000);

const live = process.env.G2_S11_DATABASE_URL ? describe : describe.skip;

const COACH = 's11-coach-a';
const OTHER = 's11-coach-b';
const CAT_ID = '11111111-1111-4111-8111-111111111111';
const CAT_SLUG = 'synthetic-bench-press';
const PROGRAM = { title: 'Base Block', weeks: 4, days: 3, notes: 'synthetic' };
const WORKOUT = {
  title: 'Push Day',
  kind: 'lift',
  minutes: 45,
  exercises: [{ id: 'e1', exercise: CAT_ID, sets: 3, reps: 8, kg: 100 }],
};
/** A syntactically valid UUID nobody owns: the no-existence-oracle comparison target. */
const NOBODY = '00000000-0000-4000-8000-000000000000';
const ack = (intent_id: string) => ({ acknowledged: true, intent_id });
const isGate = (q: string) => /SET last_observed_at\s*=/.test(q);
const isTerminal = (q: string) => q.includes('SET terminal_status = ');
const eventsNamed = (r: Result, name: string) =>
  r.events.filter((e: unknown[]) => e[1] === name).length;
const conflict = (code: string, extra: Record<string, unknown> = {}) =>
  expect.objectContaining({ status: 409, response: expect.objectContaining({ code, ...extra }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

live('S11-A1 journey core — two hosts over one disposable PG (J01-J08)', () => {
  let h: Harness;
  let pg: PgHarness;
  /** Every worker result of J01-J07, keyed by the intent it acted on (J08 reads these). */
  const seen: { intent: string; action: string; host: Host; r: Result; coach?: string }[] = [];
  const track = async (
    intent: string,
    action: string,
    host: Host,
    p: Promise<Result>,
    coach?: string,
  ) => {
    const r = await p;
    seen.push({ intent, action, host, r, coach });
    return r;
  };
  /** Persisted client-directed side-effect table counts at the start of the file (fix 3). */
  let outboundBaseline: Record<string, number> = {};

  /* ---- tracked steps (thin: every behaviour is the real service in the worker) ---- */
  const pairInit = (host: Host, coach: string) =>
    track('setup', 'pair-init', host, h.pairInit(host, coach));
  const pairRedeem = (host: Host, code: string) =>
    track('setup', 'pair-redeem', host, h.pairRedeem(host, code));
  const pairCurrent = (host: Host, coach: string) =>
    track('setup', 'pair-current', host, h.pairCurrent(host, coach));
  const pairSession = (host: Host, coach: string, i: string) =>
    track(i, 'pair-session', host, h.pairSession(host, coach, i));
  const start = (host: Host, coach: string, i: string) =>
    track(i, 'start', host, h.startRun(host, coach, i));
  const cancel = (host: Host, coach: string, i: string) =>
    track(i, 'cancel', host, h.cancelRun(host, coach, i));
  const ingest = (
    host: Host,
    coach: string,
    i: string,
    entities: { sourceId: string; payload: Record<string, unknown> }[],
    token: string,
  ) => track(i, 'ingest', host, h.ingestBatch(host, coach, i, entities, token));
  const complete = (host: Host, coach: string, i: string) =>
    track(i, 'complete', host, h.completeRun(host, coach, i), coach);
  const status = (host: Host, coach: string, i: string) =>
    track(i, 'status', host, h.statusOf(host, coach, i));
  const progress = (host: Host, coach: string, i: string, body: Record<string, unknown>) =>
    track(i, 'progress', host, h.progressOf(host, coach, i, body));
  const roster = (host: Host, coach: string, i: string) =>
    track(i, 'roster', host, h.rosterOf(host, coach, i));
  const entities = (host: Host, coach: string, i: string, family = 'workouts') =>
    track(i, 'entities', host, h.entitiesOf(host, coach, i, family));

  /** Steps 1-2 and 4: setup on the phone (P1), pairing on the extension (P2), Start on P2. */
  const pairedAndStarted = async (coach: string, hosts: [Host, Host] = ['P1', 'P2']) => {
    const init = await pairInit(hosts[0], coach);
    expect(init.failure).toBeUndefined();
    const redeem = await pairRedeem(hosts[1], init.result.pairing_code);
    expect(redeem.failure).toBeUndefined();
    const intentId: string = init.result.import_intent_id;
    const started = await start(hosts[1], coach, intentId);
    expect(started.failure).toBeUndefined();
    return intentId;
  };
  /** Step 5: batches alternate hosts; each is a real gated ingest. */
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
      const batch = await ingest(host, coach, intentId, rows, token);
      expect(batch.failure).toBeUndefined();
      expect(batch.result).toEqual({ received: rows.length, deduped: 0 });
    }
    expect(h.stagedCount(coach, intentId)).toBe(5);
  };
  /** The DB truth of `last_observed_at`, formatted as the status projection's ISO string. */
  const observedIso = (coach: string, intentId: string) =>
    pg.sql(`SELECT COALESCE(to_char(last_observed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'null')
      FROM "ScoutImport" WHERE coach_id=${pg.quote(coach)} AND intent_id=${pg.quote(intentId)}`);
  /** The truth fields a status read must carry current (J03/J04): never the mirror. */
  const truth = (s: Record<string, any>) => ({
    status: s.status,
    phase: s.phase,
    last_observed_at: s.last_observed_at,
    execution_epoch: s.execution_epoch,
    reason_code: s.reason_code,
    completed_at: s.completed_at,
    entity_counts: s.entity_counts,
  });

  beforeAll(() => {
    // Lazy: only a live run loads the harness (its import binds and validates the S11 lane).
    h = require('../../utils/g2-s11-harness');
    pg = require('../../utils/g2-s11-pg-harness');
    outboundBaseline = h.outboundTableCounts();
  });
  beforeEach(() => {
    h.resetData();
    h.catalog([{ id: CAT_ID, slug: CAT_SLUG }]);
  });
  afterAll(() => {
    if (h) h.resetData();
  });

  it('J01: init on P1 (phone), redeem on P2 (ext), current on P1 is paired, Start on P2 creates one run; replayed Start on P1 is identical', async () => {
    const init = await pairInit('P1', COACH);
    expect(init.failure).toBeUndefined();
    expect(init.result.pairing_code).toEqual(expect.any(String));
    expect(init.result.import_intent_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.mints).toBe(0);
    const intentId: string = init.result.import_intent_id;
    expect(h.intentRow(intentId)).toMatchObject({
      coach_id: COACH,
      chosen_platform: h.SETUP_LABEL,
      paired_at: null,
      superseded_at: null,
    });
    const pending = await pairCurrent('P1', COACH);
    expect(pending.result).toMatchObject({ status: 'pending', import_intent_id: intentId });

    const redeem = await pairRedeem('P2', init.result.pairing_code);
    expect(redeem.failure).toBeUndefined();
    expect(redeem.result).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      chosen_platform: h.SETUP_LABEL,
      import_intent_id: intentId,
    });
    expect(redeem.mints).toBe(1);
    expect(h.pairCodeRows(COACH)).toEqual([
      { coach_id: COACH, import_intent_id: intentId, used: true, failed_attempts: 0 },
    ]);
    // The code is single use on every host: a replay on P1 is 410 already_used, no second mint.
    const replay = await pairRedeem('P1', init.result.pairing_code);
    expect(replay.failure).toMatchObject({
      status: 410,
      response: expect.objectContaining({ code: 'already_used' }),
    });
    expect(replay.mints).toBe(0);

    const paired = await pairCurrent('P1', COACH);
    expect(paired.failure).toBeUndefined();
    expect(paired.result).toMatchObject({ status: 'paired', import_intent_id: intentId });
    const session = await pairSession('P2', COACH, intentId);
    expect(session.result).toEqual(paired.result);
    expect(h.intentRow(intentId).paired_at).not.toBeNull();

    expect(h.runCount()).toBe(0);
    const first = await start('P2', COACH, intentId);
    expect(first.failure).toBeUndefined();
    expect(first.result).toMatchObject({
      intent_id: intentId,
      mode: 'server',
      phase: 'discovering',
      execution_epoch: 1,
    });
    expect(h.runCount()).toBe(1);
    const row = h.runRow(COACH, intentId);
    expect(row).toMatchObject({ mode: 'server', import_intent_id: intentId, execution_epoch: 1 });
    const again = await start('P1', COACH, intentId);
    expect(again.failure).toBeUndefined();
    expect(again.result).toEqual(first.result);
    expect(h.runCount()).toBe(1);
    expect(h.runRow(COACH, intentId)).toEqual(row);
  });

  it('J02 (+ steps 9-11): batches alternate P1/P2, claim on P1, one terminal write; P2 status equals P1 byte for byte; the native review reads agree across hosts', async () => {
    const intentId = await pairedAndStarted(COACH);
    await transfer(COACH, intentId);
    const openP1 = await status('P1', COACH, intentId);
    const openP2 = await status('P2', COACH, intentId);
    expect(openP1.failure).toBeUndefined();
    expect(openP1.result).toMatchObject({ status: 'running', phase: 'transferring' });
    expect(JSON.stringify(openP2.result)).toBe(JSON.stringify(openP1.result));

    const done = await complete('P1', COACH, intentId);
    expect(done.failure).toBeUndefined();
    expect(done.result).toEqual(ack(intentId));
    expect(done.queries.filter(isTerminal)).toHaveLength(1);
    expect(done.pushes).toBe(1);
    const row = h.runRow(COACH, intentId);
    expect(row.terminal_status).not.toBeNull();
    expect(row.state).toBe(row.terminal_status);
    expect(row.completed_at).not.toBeNull();
    expect(h.completionRows()).toEqual([[COACH, intentId, 'success']]);
    expect(eventsNamed(done, 'scout.run.settled')).toBe(1);

    // The replayed claim on the other host acks, writes no terminal and pushes nothing.
    const replay = await complete('P2', COACH, intentId);
    expect(replay.failure).toBeUndefined();
    expect(replay.result).toEqual(ack(intentId));
    expect(replay.queries.filter(isTerminal)).toEqual([]);
    expect(replay.pushes).toBe(0);
    expect(h.runRow(COACH, intentId)).toEqual(row);
    expect(h.completionRows()).toEqual([[COACH, intentId, 'success']]);

    const settledP2 = await status('P2', COACH, intentId);
    const settledP1 = await status('P1', COACH, intentId);
    expect(settledP1.failure).toBeUndefined();
    expect(settledP1.result.status).toBe(row.terminal_status);
    expect(settledP1.result.claimed_status).toBe('success');
    expect(JSON.stringify(settledP2.result)).toBe(JSON.stringify(settledP1.result));
    // The read wrote nothing on either host.
    expect(h.runRow(COACH, intentId)).toEqual(row);

    // Step 11 (native review): the post-settle reads answer the same on both hosts.
    const rosterP1 = await roster('P1', COACH, intentId);
    const rosterP2 = await roster('P2', COACH, intentId);
    expect(rosterP1.failure).toBeUndefined();
    expect(rosterP1.result.intent_id).toBe(intentId);
    expect(JSON.stringify(rosterP2.result)).toBe(JSON.stringify(rosterP1.result));
    const workoutsP2 = await entities('P2', COACH, intentId, 'workouts');
    const workoutsP1 = await entities('P1', COACH, intentId, 'workouts');
    expect(workoutsP1.failure).toBeUndefined();
    expect(workoutsP1.result).toMatchObject({ intent_id: intentId, family: 'workouts' });
    expect(JSON.stringify(workoutsP2.result)).toBe(JSON.stringify(workoutsP1.result));
    expect(h.programs(COACH)).toHaveLength(1);
  });

  it('J03 (G2): a snapshot posted to P1 and read on P2 before P1 flushes — truth fields current, mirror absent (never zeroed); after the flush the mirror holds the posted counts', async () => {
    const intentId = await pairedAndStarted(COACH);
    const batch = await ingest(
      'P1',
      COACH,
      intentId,
      [{ sourceId: 'p-1', payload: { name: 'Synthetic p-1' } }],
      h.TOKEN.clients,
    );
    expect(batch.failure).toBeUndefined();
    const posted = [{ entity_type: h.TOKEN.clients, count_committed: 1, total_estimated: 7 }];
    const held = h.progressHeld('P1', COACH, intentId, { flush: true, progress: posted });
    expect(await held.ready).toBe('cached');
    // P1 has passed the gate (committed) and holds the snapshot in ITS memory only.
    expect(h.snapshotRows()).toEqual([]);
    const observed = observedIso(COACH, intentId);
    expect(observed).not.toBe('null');

    const read = await status('P2', COACH, intentId);
    expect(read.failure).toBeUndefined();
    expect(truth(read.result)).toEqual({
      status: 'running',
      phase: 'transferring',
      last_observed_at: observed,
      execution_epoch: 1,
      reason_code: null,
      completed_at: null,
      entity_counts: [{ entity_type: h.TOKEN.clients, committed: 1 }],
    });
    // The mirror is absent — P2 could not flush P1's cache — and nothing reads as 0.
    expect(h.snapshotRows()).toEqual([]);
    expect(JSON.stringify(read.result)).not.toContain('"committed":0');

    held.resume();
    const flushed = await held.done;
    seen.push({ intent: intentId, action: 'progress', host: 'P1', r: flushed });
    expect(flushed.failure).toBeUndefined();
    expect(flushed.result).toEqual({ recorded: true, flushed: true });
    expect(flushed.queries.filter(isGate)).toHaveLength(1);
    expect(h.snapshotRows()).toEqual([
      {
        coach_id: COACH,
        intent_id: intentId,
        device_id: 'device-ext',
        snapshot: { intent_id: intentId, progress: posted },
        last_error: null,
      },
    ]);
    // The mirror never feeds a truth field: the next read on P2 carries the same truth.
    const after = await status('P2', COACH, intentId);
    expect(truth(after.result)).toEqual(truth(read.result));
  });

  it('J04: P1 is killed with its snapshot pending — status on P2 still returns the truth fields; nothing becomes 0 or terminal', async () => {
    const intentId = await pairedAndStarted(COACH);
    for (const [host, id] of [
      ['P1', 'p-1'],
      ['P2', 'p-2'],
    ] as [Host, string][]) {
      const batch = await ingest(
        host,
        COACH,
        intentId,
        [{ sourceId: id, payload: { name: `Synthetic ${id}` } }],
        h.TOKEN.clients,
      );
      expect(batch.failure).toBeUndefined();
    }
    const before = await status('P2', COACH, intentId);
    const held = h.progressHeld('P1', COACH, intentId, {
      flush: true,
      progress: [{ entity_type: h.TOKEN.clients, count_committed: 2, total_estimated: 9 }],
    });
    expect(await held.ready).toBe('cached');
    const observed = observedIso(COACH, intentId);
    held.stop();
    await expect(held.done).rejects.toThrow(/worker exited/);
    // The pending snapshot died with P1's memory; the committed truth did not.
    expect(h.snapshotRows()).toEqual([]);
    const read = await status('P2', COACH, intentId);
    expect(read.failure).toBeUndefined();
    expect(truth(read.result)).toEqual({
      ...truth(before.result),
      last_observed_at: observed,
    });
    expect(read.result.entity_counts).toEqual([{ entity_type: h.TOKEN.clients, committed: 2 }]);
    expect(read.result.status).toBe('running');
    expect(h.runRow(COACH, intentId)).toMatchObject({
      terminal_status: null,
      fenced_at: null,
      execution_epoch: 1,
      phase: 'transferring',
    });
    expect(h.stagedCount(COACH, intentId)).toBe(2);
  });

  it('J05: cancel (phone) on P2 while ext ingests on P1 — batch-then-fence, or refused run_fenced; terminal cancelled once; no deadlock', async () => {
    // Order 1: the batch holds the gate first; the cancel waits on the row lock, then fences.
    const first = await pairedAndStarted(COACH);
    const batch = pg.worker({
      ...h.REGISTRY,
      action: 'ingest',
      coach: COACH,
      intent: first,
      pause: 'gated',
      txTimeout: 30000,
      host: 'P1',
      role: 'ext',
      body: {
        entity_type: h.TOKEN.clients,
        entities: [
          { sourceId: 'p-1', payload: { name: 'Synthetic p-1' } },
          { sourceId: 'p-2', payload: { name: 'Synthetic p-2' } },
        ],
      },
    });
    expect(await batch.ready).toBe('gated');
    const fence = pg.worker({
      action: 'cancel',
      coach: COACH,
      intent: first,
      host: 'P2',
      role: 'phone',
    });
    await pg.blocked(fence.name);
    expect(h.stagedCount(COACH, first)).toBe(0);
    batch.resume();
    const [ingested, cancelled] = await Promise.all([batch.done, fence.done]);
    seen.push({ intent: first, action: 'ingest', host: 'P1', r: ingested });
    seen.push({ intent: first, action: 'cancel', host: 'P2', r: cancelled });
    expect(ingested.failure).toBeUndefined();
    expect(ingested.result).toEqual({ received: 2, deduped: 0 });
    expect(cancelled.failure).toBeUndefined();
    expect(cancelled.result).toEqual({ intent_id: first, status: 'cancelled', execution_epoch: 2 });
    expect(h.stagedCount(COACH, first)).toBe(2);
    expect(h.runRow(COACH, first)).toMatchObject({
      terminal_status: 'cancelled',
      fence_reason: 'cancelled',
      reason_code: 'cancelled_by_coach',
      execution_epoch: 2,
    });
    expect(
      eventsNamed(ingested, 'scout.run.fenced') + eventsNamed(cancelled, 'scout.run.fenced'),
    ).toBe(1);

    // Order 2: the fence holds the row lock first; the batch waits, then is refused run_fenced.
    h.resetData();
    h.catalog([{ id: CAT_ID, slug: CAT_SLUG }]);
    const second = await pairedAndStarted(COACH, ['P2', 'P1']);
    const lock = pg.worker({
      action: 'cancel',
      coach: COACH,
      intent: second,
      pause: 'locked',
      txTimeout: 30000,
      host: 'P2',
      role: 'phone',
    });
    expect(await lock.ready).toBe('locked');
    const late = pg.worker({
      ...h.REGISTRY,
      action: 'ingest',
      coach: COACH,
      intent: second,
      host: 'P1',
      role: 'ext',
      body: {
        entity_type: h.TOKEN.clients,
        entities: [{ sourceId: 'p-3', payload: { name: 'Synthetic p-3' } }],
      },
    });
    await pg.blocked(late.name);
    lock.resume();
    const [fenced, refused] = await Promise.all([lock.done, late.done]);
    seen.push({ intent: second, action: 'cancel', host: 'P2', r: fenced });
    seen.push({ intent: second, action: 'ingest', host: 'P1', r: refused });
    expect(fenced.failure).toBeUndefined();
    expect(fenced.result).toEqual({ intent_id: second, status: 'cancelled', execution_epoch: 2 });
    expect(refused.failure).toEqual(conflict('run_fenced', { fence_reason: 'cancelled' }));
    expect(h.stagedCount(COACH, second)).toBe(0);
    expect(h.runRow(COACH, second)).toMatchObject({
      terminal_status: 'cancelled',
      reason_code: 'cancelled_by_coach',
      execution_epoch: 2,
    });
    expect(eventsNamed(fenced, 'scout.run.fenced') + eventsNamed(refused, 'scout.run.fenced')).toBe(
      1,
    );
    // No deadlock and no unexpected failure on any of the four processes.
    for (const r of [ingested, cancelled, fenced, refused]) {
      expect(r.failure?.status ?? 0).not.toBe(500);
      expect(String(r.failure?.code ?? '')).not.toBe('40P01');
    }
    // cancel stays idempotent from the other host.
    const again = await cancel('P1', COACH, second);
    expect(again.result).toEqual(fenced.result);
  });

  it('J06: a short deadline elapses with no host touching the run; the first status read on either host fences timed_out once; the concurrent read on the other host sees the same terminal', async () => {
    const init = await pairInit('P1', COACH);
    await pairRedeem('P2', init.result.pairing_code);
    const intentId: string = init.result.import_intent_id;
    const started = await track(
      intentId,
      'start',
      'P1',
      h.on('P1', 'phone', { action: 'start', coach: COACH, intent: intentId, deadlineMs: 1 }),
    );
    expect(started.failure).toBeUndefined();
    await sleep(50);
    expect(h.runRow(COACH, intentId)).toMatchObject({ terminal_status: null, fenced_at: null });
    const [readP1, readP2] = await Promise.all([
      status('P1', COACH, intentId),
      status('P2', COACH, intentId),
    ]);
    expect(readP1.failure).toBeUndefined();
    expect(readP2.failure).toBeUndefined();
    expect(readP1.result.status).toBe('timed_out');
    expect(JSON.stringify(readP2.result)).toBe(JSON.stringify(readP1.result));
    expect(eventsNamed(readP1, 'scout.run.fenced') + eventsNamed(readP2, 'scout.run.fenced')).toBe(
      1,
    );
    const row = h.runRow(COACH, intentId);
    expect(row).toMatchObject({
      terminal_status: 'timed_out',
      state: 'timed_out',
      fence_reason: 'timed_out',
      execution_epoch: 2,
    });
    const later = await status('P2', COACH, intentId);
    expect(JSON.stringify(later.result)).toBe(JSON.stringify(readP1.result));
    expect(eventsNamed(later, 'scout.run.fenced')).toBe(0);
    expect(h.runRow(COACH, intentId)).toEqual(row);
  });

  it("J07: coach B interleaves on P1/P2 — cross-coach 404 operations are uniform, B's /progress is 204 with no foreign write; A's run and rows are exactly unchanged", async () => {
    const a = await pairedAndStarted(COACH, ['P1', 'P2']);
    const aBatch = await ingest(
      'P1',
      COACH,
      a,
      [{ sourceId: 'p-1', payload: { name: 'Synthetic p-1' } }],
      h.TOKEN.clients,
    );
    expect(aBatch.failure).toBeUndefined();
    const aProgress = await progress('P2', COACH, a, { flush: true });
    expect(aProgress.failure).toBeUndefined();
    const b = await pairedAndStarted(OTHER, ['P2', 'P1']);
    const bBatch = await ingest(
      'P2',
      OTHER,
      b,
      [{ sourceId: 'q-1', payload: { name: 'Synthetic q-1' } }],
      h.TOKEN.clients,
    );
    expect(bBatch.failure).toBeUndefined();

    const aRow = h.runRow(COACH, a);
    const aIntent = h.intentRow(a);
    const aCodes = h.pairCodeRows(COACH);
    const aSnapshots = h.snapshotRows().filter((s) => s.coach_id === COACH);
    const aStaged = h.stagedCount(COACH, a);
    // S11-A1 fix 2: A's rows by CONTENT, not only by count — staged rows, every native/evidence
    // target class plus provenance and ledger (targetSnapshot), and A's completion rows.
    const aStagedRows = h.stagedRows(COACH, a);
    const aTargets = h.targetSnapshot(COACH, a);
    const completionsOf = (coach: string) =>
      h.completionRows().filter((row: string[]) => row[0] === coach);
    const aCompletions = completionsOf(COACH);
    const runs = h.runCount();
    expect(aSnapshots).toHaveLength(1);
    expect(aStagedRows.map((r) => [r.coach_id, r.intent_id, r.source_id])).toEqual([
      [COACH, a, 'p-1'],
    ]);
    expect(aCompletions).toEqual([]);

    // B's status on A's intent: 404 BEFORE B holds evidence of its own under that string.
    const cross: [string, (i: string, host: Host) => Promise<Result>][] = [
      ['status', (i, host) => status(host, OTHER, i)],
      ['start', (i, host) => start(host, OTHER, i)],
      ['cancel', (i, host) => cancel(host, OTHER, i)],
      ['pair-session', (i, host) => pairSession(host, OTHER, i)],
      ['roster', (i, host) => roster(host, OTHER, i)],
      ['entities', (i, host) => entities(host, OTHER, i)],
    ];
    let flip = false;
    for (const [action, call] of cross) {
      flip = !flip;
      const host: Host = flip ? 'P1' : 'P2';
      const foreign = await call(a, host);
      const unknown = await call(NOBODY, host === 'P1' ? 'P2' : 'P1');
      expect([action, foreign.failure?.status]).toEqual([action, 404]);
      // Uniform: A's real intent is indistinguishable from an intent nobody owns.
      expect([action, foreign.failure]).toEqual([action, unknown.failure]);
      expect(foreign.queries.filter(isGate)).toEqual([]);
      expect(JSON.stringify(foreign.failure)).not.toContain(a);
    }

    // B's /progress on A's intent: the 204 path (no failure), no gate, nothing A-keyed.
    const bOnA = await progress('P1', OTHER, a, { flush: true });
    expect(bOnA.failure).toBeUndefined();
    expect(bOnA.result).toEqual({ recorded: true, flushed: true });
    expect(bOnA.queries.filter(isGate)).toEqual([]);
    // B's own run keeps moving on the other host meanwhile.
    const bDone = await complete('P2', OTHER, b);
    expect(bDone.failure).toBeUndefined();
    expect(bDone.result).toEqual(ack(b));

    // A is exactly unchanged: run row (phase, last_observed_at, epoch, terminal), setup, codes,
    // staged rows and A-keyed mirror rows; the run count moved by nothing.
    expect(h.runRow(COACH, a)).toEqual(aRow);
    expect(h.intentRow(a)).toEqual(aIntent);
    expect(h.pairCodeRows(COACH)).toEqual(aCodes);
    expect(h.stagedCount(COACH, a)).toBe(aStaged);
    expect(h.stagedRows(COACH, a)).toEqual(aStagedRows);
    expect(h.targetSnapshot(COACH, a)).toEqual(aTargets);
    expect(completionsOf(COACH)).toEqual(aCompletions);
    expect(h.snapshotRows().filter((s) => s.coach_id === COACH)).toEqual(aSnapshots);
    expect(h.runCount()).toBe(runs);
    // B's rows are isolated too: B's staged rows are exactly B's own batch under B's intent; nothing
    // of either coach is staged under the other's intent; B's settle wrote B-owned rows only (no
    // B ledger/provenance row names A's intent), and B holds exactly its own completion row.
    expect(h.stagedRows(OTHER, b).map((r) => [r.coach_id, r.intent_id, r.source_id])).toEqual([
      [OTHER, b, 'q-1'],
    ]);
    expect(h.stagedRows(OTHER, a)).toEqual([]);
    expect(h.stagedRows(COACH, b)).toEqual([]);
    const bTargets = h.targetSnapshot(OTHER, b);
    for (const row of bTargets.provenance) expect(row.import_intent_id).not.toBe(a);
    expect(bTargets.ledger.map((r) => r.source_id)).toEqual(['q-1']);
    expect(h.targetSnapshot(OTHER, a).ledger).toEqual([]);
    expect(h.ledgerRows(COACH, b)).toEqual([]);
    expect(completionsOf(OTHER)).toEqual([[OTHER, b, 'success']]);
    // Any mirror row B's post produced is B-owned (accepted, D-S11-7(5)), never A-keyed.
    for (const s of h.snapshotRows().filter((s) => s.intent_id === a)) {
      expect([COACH, OTHER]).toContain(s.coach_id);
      if (s.coach_id === OTHER) expect(s.device_id).toBe('device-ext');
    }
    // After B's own evidence, B's status for that string may answer B's legacy mirror: it carries
    // no A field (no server clock, no phase, no A counts). A legacy row projects the documented
    // constant execution_epoch = 1 (scout.dto.ts S7-L note), never a server run's epoch.
    const bLater = await status('P2', OTHER, a);
    if (bLater.failure === undefined) {
      expect(bLater.result.mode).toBe('legacy');
      expect(bLater.result.phase ?? null).toBeNull();
      expect(bLater.result.accepted_start_at ?? null).toBeNull();
      expect(bLater.result.deadline_at ?? null).toBeNull();
      expect(bLater.result.last_observed_at ?? null).toBeNull();
      expect(bLater.result.entity_counts).toEqual([]);
      expect(bLater.result.execution_epoch).toBe(1);
      expect(JSON.stringify(bLater.result)).not.toContain(
        String(aRow.accepted_start_at).slice(0, 19),
      );
    } else {
      expect(bLater.failure.status).toBe(404);
    }
    // A still sees exactly its own run on both hosts.
    const aP1 = await status('P1', COACH, a);
    const aP2 = await status('P2', COACH, a);
    expect(aP1.result).toMatchObject({ status: 'running', execution_epoch: 1 });
    expect(JSON.stringify(aP2.result)).toBe(JSON.stringify(aP1.result));
  });

  it('J08: across J01-J07 no call reached a client-directed channel; at most one coach import.complete push per run, asserted on the call', () => {
    // Guard against an empty or partial collection (the cases above run first in this file).
    const actions = new Set(seen.map((s) => s.action));
    for (const action of [
      'pair-init',
      'pair-redeem',
      'start',
      'ingest',
      'complete',
      'status',
      'progress',
      'cancel',
      'roster',
    ])
      expect([action, actions.has(action)]).toEqual([action, true]);
    const hosts = new Set(seen.map((s) => s.host));
    expect([...hosts].sort()).toEqual(['P1', 'P2']);
    for (const { action, r } of seen) {
      // Non-vacuity: every process replaced the real notification service's methods and the
      // HTTP(S)/fetch transports with recording, throwing stand-ins before its action ran.
      expect([action, r.outboundSpied.some((m) => m.startsWith('NotificationsService.'))]).toEqual([
        action,
        true,
      ]);
      for (const t of ['http.request', 'http.get', 'https.request', 'https.get'])
        expect([action, t, r.outboundSpied.includes(t)]).toEqual([action, t, true]);
      // OBSERVED outbound calls (notification / email / messaging / drip / nudge / digest method,
      // or any HTTP(S)/fetch transport): none, on every host, for every action.
      expect([action, r.outbound]).toEqual([action, []]);
      // Supplementary: no such module was even loaded lazily by the action.
      for (const [k, n] of Object.entries(r.sideEffectLoads))
        expect([action, k, n]).toEqual([action, k, 0]);
      if (action !== 'complete') expect([action, r.pushCalls]).toEqual([action, []]);
    }
    // The single permitted push, asserted ON THE CALL: recipient is the run's coach, kind
    // import.complete; at most one per run across both hosts (replays push nothing).
    const perRun = new Map<string, number>();
    let coachPushes = 0;
    for (const { intent, action, r, coach } of seen) {
      perRun.set(intent, (perRun.get(intent) ?? 0) + r.pushCalls.length);
      expect(r.pushes).toBe(r.pushCalls.length);
      if (action === 'complete') {
        for (const call of r.pushCalls) {
          expect(call).toEqual({ userId: coach, kind: 'import.complete' });
          coachPushes += 1;
        }
      }
    }
    for (const [intent, n] of perRun) expect([intent, n <= 1]).toEqual([intent, true]);
    expect(coachPushes).toBeGreaterThanOrEqual(2); // J02 (coach A) and J07 (coach B) settle
    // No client-directed side effect was persisted by any path (message, notification, email,
    // nudge or drip rows) across the whole file.
    expect(h.outboundTableCounts()).toEqual(outboundBaseline);
    // Pairing minted exactly once per successful redeem.
    for (const { action, r } of seen)
      if (action === 'pair-redeem') expect(r.mints).toBe(r.failure === undefined ? 1 : 0);
  });
});
