import { WearableMetricType, WearableProvider } from '@prisma/client';
import { computeDedupKey, DedupKeyInput } from './dedup.util';

/**
 * PR-HK-0 dedup contract tests. The fixed input → fixed output vectors below
 * are anchored in the PR description so the auditor can independently
 * reproduce them (UNIFIED_BUILD_PLAN §5: "dedup.util produces a known sha256
 * for a fixed test vector"). Any change to the hashing recipe MUST update
 * these literals and the PR description in lockstep.
 */
describe('computeDedupKey', () => {
  // Anchored vector #1 — a sleep span (start != end).
  const VECTOR_1: DedupKeyInput = {
    userId: 'user_abc123',
    provider: WearableProvider.OURA,
    metric: WearableMetricType.SLEEP_TOTAL_MIN,
    startAt: new Date('2026-05-31T22:00:00.000Z'),
    endAt: new Date('2026-06-01T06:30:00.000Z'),
  };
  const EXPECTED_1 =
    'e6b1d1e8abbb977bc16572405bc23a3b90b5e08d79e907a52f2938d849d5c84e';

  // Anchored vector #2 — an instantaneous reading (start == end).
  const VECTOR_2: DedupKeyInput = {
    userId: '11111111-2222-3333-4444-555555555555',
    provider: WearableProvider.WHOOP,
    metric: WearableMetricType.HRV_MS,
    startAt: new Date('2026-01-15T08:00:00.000Z'),
    endAt: new Date('2026-01-15T08:00:00.000Z'),
  };
  const EXPECTED_2 =
    'b82891f2f75168f9ecfe20f34e4c5035f3de1c83836c334ada6468a4b08eb65b';

  it('produces the anchored sha256 for fixed vector #1 (sleep span)', () => {
    expect(computeDedupKey(VECTOR_1)).toBe(EXPECTED_1);
  });

  it('produces the anchored sha256 for fixed vector #2 (instantaneous)', () => {
    expect(computeDedupKey(VECTOR_2)).toBe(EXPECTED_2);
  });

  it('returns a 64-char lowercase hex string', () => {
    const key = computeDedupKey(VECTOR_1);
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across repeated calls', () => {
    expect(computeDedupKey(VECTOR_1)).toBe(computeDedupKey(VECTOR_1));
  });

  it('normalizes equivalent instants to the same key regardless of input tz offset', () => {
    // 2026-05-31T22:00:00Z == 2026-06-01T00:00:00+02:00 — same physical
    // instant, so the key must be identical (tz is stored separately, not
    // part of identity).
    const utc = computeDedupKey(VECTOR_1);
    const offset = computeDedupKey({
      ...VECTOR_1,
      startAt: new Date('2026-06-01T00:00:00.000+02:00'),
      endAt: new Date('2026-06-01T08:30:00.000+02:00'),
    });
    expect(offset).toBe(utc);
  });

  it('changes the key when the provider changes (cross-provider rows stay distinct)', () => {
    const oura = computeDedupKey(VECTOR_1);
    const garmin = computeDedupKey({
      ...VECTOR_1,
      provider: WearableProvider.GARMIN,
    });
    expect(garmin).not.toBe(oura);
  });

  it('changes the key when the metric changes', () => {
    const total = computeDedupKey(VECTOR_1);
    const rem = computeDedupKey({
      ...VECTOR_1,
      metric: WearableMetricType.SLEEP_REM_MIN,
    });
    expect(rem).not.toBe(total);
  });

  it('changes the key when the user changes', () => {
    const a = computeDedupKey(VECTOR_1);
    const b = computeDedupKey({ ...VECTOR_1, userId: 'user_other' });
    expect(b).not.toBe(a);
  });

  it('changes the key when the window shifts by one millisecond', () => {
    const base = computeDedupKey(VECTOR_1);
    const shifted = computeDedupKey({
      ...VECTOR_1,
      endAt: new Date(VECTOR_1.endAt.getTime() + 1),
    });
    expect(shifted).not.toBe(base);
  });

  it('throws a RangeError on an invalid startAt (no silent garbage key)', () => {
    expect(() =>
      computeDedupKey({ ...VECTOR_1, startAt: new Date('not-a-date') }),
    ).toThrow(RangeError);
  });

  it('throws a RangeError on an invalid endAt', () => {
    expect(() =>
      computeDedupKey({ ...VECTOR_1, endAt: new Date(NaN) }),
    ).toThrow(RangeError);
  });
});
