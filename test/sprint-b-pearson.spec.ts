import { alignWeekly, bucketWeekly, isoWeekKey, pearson } from '../src/common/correlation/pearson';

describe('pearson', () => {
  it('returns null for n < 2', () => {
    expect(pearson([1], [2])).toBeNull();
  });

  it('returns null for zero variance', () => {
    expect(pearson([1, 1, 1], [2, 3, 4])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it('returns r=1 for a perfect positive linear relationship', () => {
    const r = pearson([1, 2, 3, 4], [2, 4, 6, 8]);
    expect(r).not.toBeNull();
    expect(r!.r).toBeCloseTo(1, 6);
    expect(r!.n).toBe(4);
  });

  it('returns r=-1 for a perfect negative linear relationship', () => {
    const r = pearson([1, 2, 3, 4], [8, 6, 4, 2]);
    expect(r!.r).toBeCloseTo(-1, 6);
  });

  it('returns r near 0 for uncorrelated series', () => {
    const r = pearson([1, 2, 3, 4, 5], [3, 1, 4, 1, 5]);
    expect(Math.abs(r!.r)).toBeLessThan(0.5);
  });

  it('throws on length mismatch', () => {
    expect(() => pearson([1, 2], [1])).toThrow();
  });

  it('clamps numerical drift to [-1, 1]', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const ys = xs.map((x) => x);
    const r = pearson(xs, ys);
    expect(r!.r).toBeLessThanOrEqual(1);
    expect(r!.r).toBeGreaterThanOrEqual(-1);
  });
});

describe('isoWeekKey', () => {
  it('formats YYYY-Www', () => {
    expect(isoWeekKey(new Date('2026-01-05'))).toMatch(/^2026-W\d{2}$/);
  });
  it('returns the ISO week number for a known date', () => {
    // 2026-05-04 is Monday of W19 (ISO).
    expect(isoWeekKey(new Date('2026-05-04T12:00:00Z'))).toBe('2026-W19');
  });
});

describe('bucketWeekly', () => {
  it('averages multiple samples within a week', () => {
    const buckets = bucketWeekly([
      { date: '2026-05-04T08:00:00Z', value: 30 },
      { date: '2026-05-05T08:00:00Z', value: 60 },
      { date: '2026-05-06T08:00:00Z', value: 90 },
    ]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].value).toBe(60);
    expect(buckets[0].sampleCount).toBe(3);
  });

  it('separates weeks', () => {
    const buckets = bucketWeekly([
      { date: '2026-05-04T08:00:00Z', value: 1 },
      { date: '2026-05-12T08:00:00Z', value: 2 },
    ]);
    expect(buckets).toHaveLength(2);
  });

  it('drops invalid dates without throwing', () => {
    const buckets = bucketWeekly([
      { date: 'not-a-date', value: 1 },
      { date: '2026-05-04T08:00:00Z', value: 5 },
    ]);
    expect(buckets).toHaveLength(1);
  });

  it('averages by default (matches historical behaviour)', () => {
    const buckets = bucketWeekly([
      { date: '2026-05-04T08:00:00Z', value: 30 },
      { date: '2026-05-05T08:00:00Z', value: 60 },
    ]);
    expect(buckets[0].value).toBe(45);
  });

  it('sums when mode is "sum" — required for cardio-minutes-per-week', () => {
    // Five 30-minute cardio sessions in one week is 150 minutes, not 30.
    const buckets = bucketWeekly(
      [
        { date: '2026-05-04T08:00:00Z', value: 30 },
        { date: '2026-05-04T18:00:00Z', value: 30 },
        { date: '2026-05-05T08:00:00Z', value: 30 },
        { date: '2026-05-06T08:00:00Z', value: 30 },
        { date: '2026-05-07T08:00:00Z', value: 30 },
      ],
      'sum',
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].value).toBe(150);
    expect(buckets[0].sampleCount).toBe(5);
  });

  it('sums strength-session counts to a usable per-week series', () => {
    // 4 weeks at [3, 4, 2, 5] sessions/week. Each session contributes
    // value 1; without "sum" mode the mean would always be 1 and the
    // series would have zero variance, so pearson() would return null.
    const samples = [
      // week 1 — 3 sessions
      { date: '2026-04-13T08:00:00Z', value: 1 },
      { date: '2026-04-15T08:00:00Z', value: 1 },
      { date: '2026-04-17T08:00:00Z', value: 1 },
      // week 2 — 4 sessions
      { date: '2026-04-20T08:00:00Z', value: 1 },
      { date: '2026-04-22T08:00:00Z', value: 1 },
      { date: '2026-04-24T08:00:00Z', value: 1 },
      { date: '2026-04-26T08:00:00Z', value: 1 },
      // week 3 — 2 sessions
      { date: '2026-04-27T08:00:00Z', value: 1 },
      { date: '2026-04-30T08:00:00Z', value: 1 },
      // week 4 — 5 sessions
      { date: '2026-05-04T08:00:00Z', value: 1 },
      { date: '2026-05-05T08:00:00Z', value: 1 },
      { date: '2026-05-06T08:00:00Z', value: 1 },
      { date: '2026-05-07T08:00:00Z', value: 1 },
      { date: '2026-05-08T08:00:00Z', value: 1 },
    ];
    const buckets = bucketWeekly(samples, 'sum');
    expect(buckets.map((b) => b.value)).toEqual([3, 4, 2, 5]);
  });
});

describe('alignWeekly', () => {
  it('intersects two weekly series on shared keys', () => {
    const a = [
      { weekKey: '2026-W18', value: 1, sampleCount: 1 },
      { weekKey: '2026-W19', value: 2, sampleCount: 1 },
      { weekKey: '2026-W20', value: 3, sampleCount: 1 },
    ];
    const b = [
      { weekKey: '2026-W19', value: 10, sampleCount: 1 },
      { weekKey: '2026-W20', value: 20, sampleCount: 1 },
      { weekKey: '2026-W21', value: 30, sampleCount: 1 },
    ];
    const out = alignWeekly(a, b);
    expect(out.weeks).toEqual(['2026-W19', '2026-W20']);
    expect(out.xs).toEqual([2, 3]);
    expect(out.ys).toEqual([10, 20]);
  });

  it('returns empty arrays when no weeks overlap', () => {
    const out = alignWeekly(
      [{ weekKey: '2026-W18', value: 1, sampleCount: 1 }],
      [{ weekKey: '2026-W19', value: 1, sampleCount: 1 }],
    );
    expect(out.weeks).toEqual([]);
  });
});
