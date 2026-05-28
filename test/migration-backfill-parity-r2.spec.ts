/**
 * R2 NEW-P3-1 — migration backfill parity test.
 *
 * The round-2 migration at
 * `prisma/migrations/20260528120000_stream1_round1_fixes/migration.sql`
 * backfills `CoachAIBudget.total_pack_actual_cents` from
 * `floor(pack_paid_cents / value_multiplier) + tie-aware adjustment`
 * using explicit NUMERIC half-to-even rounding (option B in the
 * audit's suggested fix). This spec pins the SQL algorithm against
 * the JS runtime banker's rounding in
 * `src/ai-credits/bankers-round.util.ts` so:
 *
 *   1. The migration's INTENT is captured in code that runs in CI.
 *      Anyone editing the SQL has to mirror the change here OR
 *      explain why parity broke.
 *   2. We sweep across the production input range and assert the
 *      JS port of the SQL formula returns the same value as
 *      bankersRoundPaidToActual — including the exact-tie cases
 *      the prior `ROUND(numeric)` implementation diverged on.
 *
 * This is a JS-level drift-detection test, NOT a Postgres
 * integration test. A genuine Postgres-rig test would run the
 * migration against a populated table and assert the column matches
 * the JS util. That's tracked in the Postgres-rig backlog alongside
 * the other `it.skip` integration tests.
 */

import { bankersRoundPaidToActual, bankersRound } from '../src/ai-credits/bankers-round.util';

/**
 * Direct JS port of the SQL backfill expression in
 * `20260528120000_stream1_round1_fixes/migration.sql:68-100`.
 *
 * Algorithm (verbatim from the SQL comment):
 *   q     = paid / mult           (treat as exact real for the test;
 *                                  the SQL uses NUMERIC which IS exact)
 *   floor = floor(q)
 *   diff  = q - floor
 *   if diff > 0.5: floor + 1
 *   if diff < 0.5: floor
 *   if diff = 0.5: floor if floor is even, else floor + 1
 *
 * We intentionally mirror the SQL CASE structure literally rather
 * than re-deriving from the JS util — the whole point is to verify
 * the algorithm in the SQL is equivalent.
 */
function sqlBackfillPort(paidCents: number, multiplier: number): number {
  const q = paidCents / multiplier;
  const floorQ = Math.floor(q);
  const diff = q - floorQ;
  // Use the same epsilon the JS util uses to absorb IEEE-754 drift
  // on values that *should* be exactly 0.5 but read back as
  // 0.49999999999.... The SQL implementation runs on NUMERIC which
  // is exact, so the SQL does NOT need this epsilon — but to compare
  // JS-port vs JS-util we need it here, since both go through
  // IEEE-754 division.
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return floorQ + 1;
  if (diff < 0.5 - EPS) return floorQ;
  // Tie: half-to-even
  return floorQ % 2 === 0 ? floorQ : floorQ + 1;
}

describe('R2 NEW-P3-1 — migration backfill SQL algorithm matches bankers-round.util', () => {
  it('locked tier examples ($10, $25, $99 / 3.125) match bankersRoundPaidToActual', () => {
    for (const paid of [1000, 2500, 9900]) {
      expect(sqlBackfillPort(paid, 3.125)).toBe(bankersRoundPaidToActual(paid, 3.125));
    }
  });

  it('full custom-pack sweep [1000, 50_000] @ multiplier=3.125 matches the JS util', () => {
    for (let p = 1000; p <= 50_000; p++) {
      expect(sqlBackfillPort(p, 3.125)).toBe(bankersRoundPaidToActual(p, 3.125));
    }
  });

  it('exact-tie inputs (where the old ROUND(numeric) would have diverged) match the JS util', () => {
    // Cherry-pick values where p/multiplier lands exactly on a .5
    // boundary. With multiplier = 3.125 = 25/8, p/3.125 is exactly a
    // half when p = 8k + 4 for some integer k AND the .5 lies on the
    // tie path. Easier to just enumerate the .5 boundaries directly.
    // p such that 2 * p / 3.125 is an odd integer
    //   <=> 2p = 3.125 * (2k+1) for some k >= 0
    //   <=> p  = (3.125 / 2) * (2k+1) = 1.5625 * (2k+1)
    // So p must be 1.5625, 4.6875, 7.8125, ... — none are integers.
    // For multiplier = 3.125 specifically, no integer p produces an
    // exact .5 tie. We exercise the tie path with a different
    // multiplier to confirm the algorithm is correct.
    //
    // multiplier = 2.0: every odd p yields a .5 tie.
    //   p=1 -> 0.5 -> floor=0 (even) -> 0
    //   p=3 -> 1.5 -> floor=1 (odd)  -> 2
    //   p=5 -> 2.5 -> floor=2 (even) -> 2
    //   p=7 -> 3.5 -> floor=3 (odd)  -> 4
    for (const p of [1, 3, 5, 7, 9, 11, 13]) {
      expect(sqlBackfillPort(p, 2.0)).toBe(bankersRoundPaidToActual(p, 2.0));
    }
    // Spot-checks: the manual hand-computed expected values prove
    // the algorithm IS half-to-even (not half-away-from-zero, which
    // would have given 1, 2, 3, 4 instead).
    expect(sqlBackfillPort(1, 2.0)).toBe(0);
    expect(sqlBackfillPort(3, 2.0)).toBe(2);
    expect(sqlBackfillPort(5, 2.0)).toBe(2);
    expect(sqlBackfillPort(7, 2.0)).toBe(4);
    expect(bankersRound(0.5)).toBe(0); // sanity: JS util agrees
  });

  it('non-tie boundary inputs match the JS util across a wide sweep', () => {
    // Random multipliers in the safe production-like range.
    const multipliers = [1.5, 2.0, 2.5, 3.125, 4.0, 5.0, 7.7];
    for (const m of multipliers) {
      for (let p = 0; p <= 5_000; p += 7) {
        expect(sqlBackfillPort(p, m)).toBe(bankersRoundPaidToActual(p, m));
      }
    }
  });
});
