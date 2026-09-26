/**
 * S11-C real-PG readiness proof (docs/decisions/2026-09-26-s11-journey.md D-S11-5, D-S11-8 row
 * S11-C; §3 J17). Spec cases only on the ONE S11 harness (D-S11-6): it imports
 * test/utils/g2-s11-harness.ts and test/utils/g2-s11-pg-harness.ts and forks nothing.
 *
 * Every setup read, Start, cancel and status read is the real service in a NEW worker process
 * (P1/P2 label the process; "phone"/"ext" label the client role and are NOT authenticated
 * principals, D-S11-1). The S10-B declaration rows are SQL-level fixtures: the worker has no
 * `declare` action until S11-A2 (D-S11-6), and the readiness read only counts rows. They satisfy
 * every landed S10-B CHECK and the one-challenge trigger. They are removed by the harness reset
 * through the ScoutImport cascade, never by a top-level DELETE.
 *
 * Lane: without G2_S11_DATABASE_URL this file is inert (describe.skip) and loads no harness; with
 * it, the harness import fails closed on any other lane. Run alone and in band:
 *   jest --runInBand test/scout/s11/readiness.pg.spec.ts
 */

// Module scope: without this the file is a global script and its top-level names collide with
// test/scout/s11/journey-core.pg.spec.ts under `tsc --noEmit` (TS2300/TS2451).
export {};

type Harness = typeof import('../../utils/g2-s11-harness');
type PgHarness = typeof import('../../utils/g2-s11-pg-harness');
type Result = import('../../utils/g2-s11-pg-harness').Result;

jest.setTimeout(300000);

const live = process.env.G2_S11_DATABASE_URL ? describe : describe.skip;

const COACH = 's11-coach-a';
const OTHER = 's11-coach-b';
const ALPHA = 's11-decl-alpha';
const BETA = 's11-decl-beta';
const DIGEST_1 = '1'.repeat(64);
const DIGEST_2 = '2'.repeat(64);
const CHALLENGE_HEX = 'ab'.repeat(32);
const DECLARED_AT = '2026-09-26 00:00:00';
const WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i;
const notFound = expect.objectContaining({ status: 404 });

live('S11-C readiness on the setup reads — two hosts over one disposable PG (J17)', () => {
  let h: Harness;
  let pg: PgHarness;

  beforeAll(() => {
    // Lazy: the harness binds the lane at import time, so the inert path never loads it.
    h = require('../../utils/g2-s11-harness');
    pg = require('../../utils/g2-s11-pg-harness');
  });
  beforeEach(() => h.resetData());
  afterAll(() => h?.resetData());

  const ok = (r: Result) => {
    expect(r.failure).toBeUndefined();
    return r.result;
  };
  /** Steps 1-2: setup on the phone (P1), pairing on the extension (P2). */
  const paired = async (coach: string): Promise<string> => {
    const init = ok(await h.pairInit('P1', coach));
    ok(await h.pairRedeem('P2', init.pairing_code));
    return init.import_intent_id;
  };
  /** S10-B declaration rows (fixture): one challenge and declared_at per run, per the trigger. */
  const declare = (coach: string, intentId: string, rows: [string, string][]) => {
    for (const [platform, digest] of rows)
      pg.sql(`INSERT INTO "ScoutRunDeclaration"
        (coach_id,intent_id,source_platform,account_scope_id_digest,challenge,declared_at)
        VALUES (${pg.quote(coach)},${pg.quote(intentId)},${pg.quote(platform)},${pg.quote(digest)},
          decode(${pg.quote(CHALLENGE_HEX)},'hex'),${pg.quote(DECLARED_AT)}::timestamp)`);
  };
  const readOnly = (r: Result) => expect(r.queries.filter((q) => WRITE.test(q))).toEqual([]);

  it('R1 paired, no Start: run none, not declared, platform count null (never 0)', async () => {
    const intentId = await paired(COACH);
    const session = await h.pairSession('P2', COACH, intentId);
    expect(ok(session)).toEqual({
      status: 'paired',
      import_intent_id: intentId,
      chosen_platform: h.SETUP_LABEL,
      readiness: { run: 'none', source_declared: false, declared_platforms: null },
    });
    const current = await h.pairCurrent('P1', COACH);
    expect(ok(current)).toEqual(session.result);
    readOnly(session);
    readOnly(current);
    expect(h.runCount()).toBe(0);
  });

  it('R2 Start on P2, read on P1: open, not declared, 0 platforms; writes nothing', async () => {
    const intentId = await paired(COACH);
    ok(await h.startRun('P2', COACH, intentId));
    const before = h.runRow(COACH, intentId);
    const r = await h.pairSession('P1', COACH, intentId);
    expect(ok(r).readiness).toEqual({
      run: 'open',
      source_declared: false,
      declared_platforms: 0,
    });
    readOnly(r);
    expect(h.runRow(COACH, intentId)).toEqual(before);
  });

  it('R3 declarations: distinct platform count only; no names, digests or challenge', async () => {
    const intentId = await paired(COACH);
    ok(await h.startRun('P1', COACH, intentId));
    declare(COACH, intentId, [
      [ALPHA, DIGEST_1],
      [ALPHA, DIGEST_2],
      [BETA, DIGEST_1],
    ]);
    for (const host of ['P1', 'P2'] as const) {
      const r = await h.pairSession(host, COACH, intentId);
      expect(ok(r).readiness).toEqual({
        run: 'open',
        source_declared: true,
        declared_platforms: 2,
      });
      const body = JSON.stringify(r.result);
      for (const secret of [ALPHA, BETA, DIGEST_1, DIGEST_2, CHALLENGE_HEX]) {
        expect(body).not.toContain(secret);
      }
      readOnly(r);
    }
    expect(pg.sql(`SELECT count(*) FROM "ScoutRunDeclaration"`)).toBe('3');
  });

  it('R4 past deadline: the read never fences; status fences; then terminal', async () => {
    const intentId = await paired(COACH);
    ok(await h.startRun('P2', COACH, intentId));
    h.expire(COACH, intentId);
    const r = await h.pairSession('P1', COACH, intentId);
    expect(ok(r).readiness.run).toBe('open');
    readOnly(r);
    const row = h.runRow(COACH, intentId);
    expect(row.fenced_at).toBeNull();
    expect(row.terminal_status).toBeNull();
    ok(await h.statusOf('P2', COACH, intentId));
    expect(h.runRow(COACH, intentId).terminal_status).toBe('timed_out');
    const after = await h.pairCurrent('P1', COACH);
    expect(ok(after).readiness).toEqual({
      run: 'terminal',
      source_declared: false,
      declared_platforms: 0,
    });
    expect(JSON.stringify(after.result)).not.toContain('timed_out');
  });

  it('R5 cancel on P2: terminal on P1, declaration count kept, no terminal detail', async () => {
    const intentId = await paired(COACH);
    ok(await h.startRun('P1', COACH, intentId));
    declare(COACH, intentId, [[ALPHA, DIGEST_1]]);
    ok(await h.cancelRun('P2', COACH, intentId));
    const r = await h.pairSession('P1', COACH, intentId);
    expect(ok(r).readiness).toEqual({
      run: 'terminal',
      source_declared: true,
      declared_platforms: 1,
    });
    expect(JSON.stringify(r.result)).not.toContain('cancelled');
  });

  it("R6 tenant: B gets 404 on A's setup and only its OWN readiness; A unchanged", async () => {
    const intentA = await paired(COACH);
    ok(await h.startRun('P1', COACH, intentA));
    declare(COACH, intentA, [[ALPHA, DIGEST_1]]);
    const intentB = await paired(OTHER);
    const aBefore = { run: h.runRow(COACH, intentA), setup: h.intentRow(intentA) };

    const foreign = await h.pairSession('P2', OTHER, intentA);
    expect(foreign.failure).toEqual(notFound);
    readOnly(foreign);

    const own = await h.pairCurrent('P1', OTHER);
    expect(ok(own)).toEqual({
      status: 'paired',
      import_intent_id: intentB,
      chosen_platform: h.SETUP_LABEL,
      readiness: { run: 'none', source_declared: false, declared_platforms: null },
    });
    expect(JSON.stringify(own.result)).not.toContain(intentA);
    readOnly(own);

    expect({ run: h.runRow(COACH, intentA), setup: h.intentRow(intentA) }).toEqual(aBefore);
    expect(ok(await h.pairSession('P2', COACH, intentA)).readiness).toEqual({
      run: 'open',
      source_declared: true,
      declared_platforms: 1,
    });
  });
});
