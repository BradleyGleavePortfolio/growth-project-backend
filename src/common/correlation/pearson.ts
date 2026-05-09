/**
 * Hand-rolled Pearson correlation coefficient. Kept here (vs.
 * importing simple-statistics) to avoid pulling a transitive
 * dependency into the backend bundle for one function.
 *
 * Returns null when the input is too small (n < 2) or when either
 * series has zero variance — in those cases r is undefined and the
 * caller should treat the pair as "no signal".
 */

export interface CorrelationResult {
  /** Pearson r in [-1, 1]. */
  r: number;
  /** Number of paired samples that contributed to r. */
  n: number;
  /** Mean of x. */
  meanX: number;
  /** Mean of y. */
  meanY: number;
}

export function pearson(xs: number[], ys: number[]): CorrelationResult | null {
  if (xs.length !== ys.length) {
    throw new Error('pearson: input arrays must have equal length');
  }
  const n = xs.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  const r = num / Math.sqrt(denX * denY);
  // Numerical hygiene — clamp to [-1, 1] in case of rounding drift.
  const clamped = Math.max(-1, Math.min(1, r));
  return { r: clamped, n, meanX, meanY };
}

/**
 * Group raw daily samples into ISO-week buckets and average each
 * bucket. Used by the insights engine to align cross-pillar series
 * onto the same coarse time axis before correlating.
 *
 * `samples` is an array of `{date, value}` where `date` is a JS Date
 * or an ISO string parseable by Date.
 */
export interface DailySample {
  date: string | Date;
  value: number;
}

export interface WeeklyBucket {
  weekKey: string; // ISO YYYY-Www
  value: number;
  sampleCount: number;
}

// Returns ISO 8601 week key (e.g. "2026-W19") for a given date.
export function isoWeekKey(input: Date): string {
  // Algorithm: target = current; shift to nearest Thursday; year is
  // target's year; week = floor((target - jan4) / 7) + 1.
  const d = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function bucketWeekly(samples: DailySample[]): WeeklyBucket[] {
  const acc = new Map<string, { sum: number; count: number }>();
  for (const s of samples) {
    const date = s.date instanceof Date ? s.date : new Date(s.date);
    if (Number.isNaN(date.getTime())) continue;
    const key = isoWeekKey(date);
    const cur = acc.get(key) ?? { sum: 0, count: 0 };
    cur.sum += s.value;
    cur.count += 1;
    acc.set(key, cur);
  }
  return Array.from(acc.entries())
    .map(([weekKey, { sum, count }]) => ({
      weekKey,
      value: sum / count,
      sampleCount: count,
    }))
    .sort((a, b) => (a.weekKey < b.weekKey ? -1 : 1));
}

// Align two weekly series by shared week keys. Returns parallel
// arrays of values for use by pearson(). Drops weeks present in
// only one series.
export function alignWeekly(
  a: WeeklyBucket[],
  b: WeeklyBucket[],
): { weeks: string[]; xs: number[]; ys: number[] } {
  const bMap = new Map(b.map((bb) => [bb.weekKey, bb.value]));
  const weeks: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const aa of a) {
    if (bMap.has(aa.weekKey)) {
      weeks.push(aa.weekKey);
      xs.push(aa.value);
      ys.push(bMap.get(aa.weekKey) as number);
    }
  }
  return { weeks, xs, ys };
}
