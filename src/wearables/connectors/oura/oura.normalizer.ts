import { WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
} from '../../normalization/normalizer.types';
import {
  OuraCollection,
  OuraDailyActivity,
  OuraDailyReadiness,
  OuraDailySleep,
  OuraHeartRate,
  OuraSleep,
  OuraSpO2,
} from './oura.types';

/**
 * PR-HK-2.k — Oura → canonical normalizer (AGENT_2_CODING_PLAN §3.1).
 *
 * Pure, side-effect-free mapping from Oura v2 provider-native records to
 * {@link NormalizedSample}[]. The connector wraps each provider record in a
 * {@link RawRecord} whose `payload` is an {@link OuraRawPayload} carrying the
 * subject `userId` + `connectionId` (the normalizer is stateless and the
 * canonical sample requires them) plus the source `collection` tag so the
 * normalizer can dispatch without re-sniffing the shape.
 *
 * §3.1 mapping (Oura row):
 *   daily_sleep  → SLEEP_TOTAL_MIN, SLEEP_REM_MIN, SLEEP_DEEP_MIN,
 *                  SLEEP_LIGHT_MIN, SLEEP_AWAKE_MIN, SLEEP_EFFICIENCY_PCT (S&R)
 *   daily_sleep.average_hrv      → HRV_MS (S&R)
 *   sleep (long-form period)     → SLEEP_TOTAL_MIN, SLEEP_REM_MIN,
 *                  SLEEP_DEEP_MIN, SLEEP_LIGHT_MIN, SLEEP_AWAKE_MIN,
 *                  SLEEP_EFFICIENCY_PCT (S&R) + HRV_MS (nightly mean from
 *                  `average_hrv`, else the mean of the `hrv.items` series)
 *                  — the live Oura `sleep` endpoint is where stage durations
 *                  and HRV actually live (R2 fix — Finding 2).
 *   daily_readiness.score        → READINESS_SCORE (S&R)
 *   daily_readiness.temperature_deviation → BODY_TEMP_DEVIATION_C (S&R)
 *   daily_activity.steps         → STEPS (H&F)
 *   heartrate.bpm                → HEART_RATE_BPM (H&F)
 *   daily_spo2.spo2_percentage   → SPO2_PCT (S&R)
 *
 * Units + buckets are taken verbatim from the seeded WearableMetricDef
 * (PR-HK-0 migration): durations in "min" / SLEEP_RECOVERY, scores in "score",
 * HRV in "ms", steps in "steps" / HEALTH_FITNESS, HR in "bpm" /
 * HEALTH_FITNESS, SpO2 in "%" / SLEEP_RECOVERY, temp deviation in "°C".
 *
 * Defenses: anything unmapped or null is dropped (no speculative ingestion,
 * #42); a record with an unparseable timestamp is skipped rather than hashed
 * into a garbage dedup key (#8 fail-safe at the boundary, the ingestion lane
 * is the hard enforcement point).
 */

/** The wrapper the Oura connector puts in `RawRecord.payload`. */
export interface OuraRawPayload<T = unknown> {
  collection: OuraCollection;
  userId: string;
  connectionId: string;
  /** IANA tz the provider reported the record in, if known. */
  sourceTz?: string | null;
  /** The untouched Oura provider record. */
  record: T;
}

/** Canonical units (mirror WearableMetricDef seed). */
const UNIT = {
  MIN: 'min',
  PCT: '%',
  MS: 'ms',
  STEPS: 'steps',
  BPM: 'bpm',
  SCORE: 'score',
  CELSIUS: '°C',
} as const;

/** Seconds → whole minutes (Oura emits sleep durations in seconds). */
function secondsToMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/** Parse an ISO-8601 instant to a Date, or null if invalid/absent. */
function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a daily record's observation window. Oura daily documents are keyed
 * by calendar `day` (`YYYY-MM-DD`); we anchor the canonical window to the UTC
 * span of that day [00:00:00Z, 23:59:59.999Z] unless the record carries an
 * explicit start/end. This is deterministic and tz-stable for dedup.
 */
function dayWindow(day: string): { startAt: Date; endAt: Date } | null {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(`${day}T23:59:59.999Z`);
  return { startAt: start, endAt: end };
}

interface SampleSeed {
  metric: NormalizedSample['metric'];
  bucket: NormalizedSample['bucket'];
  value: number | null | undefined;
  unit: string;
  startAt: Date;
  endAt: Date;
}

/** Build a NormalizedSample, dropping null/non-finite values. */
function build(
  ctx: OuraRawPayload,
  sourceRecordId: string | null,
  seed: SampleSeed,
): NormalizedSample | null {
  if (seed.value === null || seed.value === undefined) return null;
  if (typeof seed.value !== 'number' || !Number.isFinite(seed.value)) {
    return null;
  }
  return {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: WearableProvider.OURA,
    metric: seed.metric,
    bucket: seed.bucket,
    value: seed.value,
    unit: seed.unit,
    startAt: seed.startAt,
    endAt: seed.endAt,
    sourceTz: ctx.sourceTz ?? null,
    sourceRecordId,
  };
}

/**
 * Shared stage/efficiency mapping used by BOTH the daily `daily_sleep` score
 * document and the long-form `sleep` period document — their stage/efficiency
 * field names are identical (Oura v2). `hrvMs` is resolved per source: the
 * daily doc carries `average_hrv` directly; the long-form doc may carry it or
 * a 5-minute `hrv.items` series we average. Returns the seed list (HRV last so
 * golden ordering is stable).
 */
function sleepSeeds(
  rec: {
    total_sleep_duration?: number | null;
    rem_sleep_duration?: number | null;
    deep_sleep_duration?: number | null;
    light_sleep_duration?: number | null;
    awake_time?: number | null;
    efficiency?: number | null;
  },
  hrvMs: number | null,
  window: { startAt: Date; endAt: Date },
): SampleSeed[] {
  return [
    {
      metric: 'SLEEP_TOTAL_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.total_sleep_duration != null
          ? secondsToMinutes(rec.total_sleep_duration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_REM_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.rem_sleep_duration != null
          ? secondsToMinutes(rec.rem_sleep_duration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_DEEP_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.deep_sleep_duration != null
          ? secondsToMinutes(rec.deep_sleep_duration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_LIGHT_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.light_sleep_duration != null
          ? secondsToMinutes(rec.light_sleep_duration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_AWAKE_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: rec.awake_time != null ? secondsToMinutes(rec.awake_time) : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_EFFICIENCY_PCT',
      bucket: 'SLEEP_RECOVERY',
      value: rec.efficiency ?? null,
      unit: UNIT.PCT,
      ...window,
    },
    {
      metric: 'HRV_MS',
      bucket: 'SLEEP_RECOVERY',
      value: hrvMs,
      unit: UNIT.MS,
      ...window,
    },
  ];
}

/**
 * Mean of the finite numeric entries of an Oura HRV time series. `null`
 * entries are off-wrist gaps and are excluded. Returns null if the series is
 * absent/empty so no speculative HRV sample is emitted (#42). Rounded to the
 * nearest whole millisecond to match the canonical `ms` unit granularity.
 */
function averageSeries(items: Array<number | null> | null | undefined): number | null {
  if (!Array.isArray(items)) return null;
  let sum = 0;
  let n = 0;
  for (const v of items) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? Math.round(sum / n) : null;
}

function normalizeDailySleep(ctx: OuraRawPayload): NormalizedSample[] {
  const rec = ctx.record as OuraDailySleep;
  // Prefer the explicit bedtime window when present; else the calendar day.
  const start = parseInstant(rec.bedtime_start);
  const end = parseInstant(rec.bedtime_end);
  const window =
    start && end ? { startAt: start, endAt: end } : dayWindow(rec.day);
  if (!window) return [];
  const id = rec.id ?? null;

  const seeds: SampleSeed[] = sleepSeeds(rec, rec.average_hrv ?? null, window);

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

/**
 * Normalize a long-form `sleep` (sleep-period) document. Identical stage +
 * efficiency mapping to {@link normalizeDailySleep}, but HRV is resolved from
 * `average_hrv` when present, falling back to the mean of the 5-minute
 * `hrv.items` series (R2 fix — Finding 2). Window is the explicit bedtime span
 * when present, else the calendar day.
 */
function normalizeSleep(ctx: OuraRawPayload): NormalizedSample[] {
  const rec = ctx.record as OuraSleep;
  const start = parseInstant(rec.bedtime_start);
  const end = parseInstant(rec.bedtime_end);
  const window =
    start && end ? { startAt: start, endAt: end } : dayWindow(rec.day);
  if (!window) return [];
  const id = rec.id ?? null;

  const hrvMs =
    rec.average_hrv != null ? rec.average_hrv : averageSeries(rec.hrv?.items);

  const seeds: SampleSeed[] = sleepSeeds(rec, hrvMs, window);

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

function normalizeDailyReadiness(ctx: OuraRawPayload): NormalizedSample[] {
  const rec = ctx.record as OuraDailyReadiness;
  const window = dayWindow(rec.day);
  if (!window) return [];
  const id = rec.id ?? null;

  const seeds: SampleSeed[] = [
    {
      metric: 'READINESS_SCORE',
      bucket: 'SLEEP_RECOVERY',
      value: rec.score ?? null,
      unit: UNIT.SCORE,
      ...window,
    },
    {
      metric: 'BODY_TEMP_DEVIATION_C',
      bucket: 'SLEEP_RECOVERY',
      value: rec.temperature_deviation ?? null,
      unit: UNIT.CELSIUS,
      ...window,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

function normalizeDailyActivity(ctx: OuraRawPayload): NormalizedSample[] {
  const rec = ctx.record as OuraDailyActivity;
  const window = dayWindow(rec.day);
  if (!window) return [];

  const sample = build(ctx, rec.id ?? null, {
    metric: 'STEPS',
    bucket: 'HEALTH_FITNESS',
    value: rec.steps ?? null,
    unit: UNIT.STEPS,
    ...window,
  });
  return sample ? [sample] : [];
}

function normalizeHeartRate(ctx: OuraRawPayload): NormalizedSample[] {
  const rec = ctx.record as OuraHeartRate;
  const at = parseInstant(rec.timestamp);
  if (!at) return [];

  // Instantaneous reading: start == end.
  const sample = build(ctx, null, {
    metric: 'HEART_RATE_BPM',
    bucket: 'HEALTH_FITNESS',
    value: rec.bpm ?? null,
    unit: UNIT.BPM,
    startAt: at,
    endAt: at,
  });
  return sample ? [sample] : [];
}

function normalizeSpO2(ctx: OuraRawPayload): NormalizedSample[] {
  const rec = ctx.record as OuraSpO2;
  const window = dayWindow(rec.day);
  if (!window) return [];

  // Oura nests the value under { average }; tolerate a bare number too.
  let value: number | null = null;
  const raw = rec.spo2_percentage;
  if (typeof raw === 'number') {
    value = raw;
  } else if (raw && typeof raw === 'object') {
    value = raw.average ?? null;
  }

  const sample = build(ctx, rec.id ?? null, {
    metric: 'SPO2_PCT',
    bucket: 'SLEEP_RECOVERY',
    value,
    unit: UNIT.PCT,
    ...window,
  });
  return sample ? [sample] : [];
}

/**
 * Normalize one wrapped Oura record. The long-form `sleep` period document is
 * the real source of sleep-stage durations + HRV and IS mapped (R2 fix —
 * Finding 2). `workout`/`session` remain unmapped today — fetched for
 * completeness/future mapping but yielding no rows (no speculative ingestion,
 * #42).
 */
export function normalizeOuraRecord(
  payload: OuraRawPayload,
): NormalizedSample[] {
  switch (payload.collection) {
    case 'daily_sleep':
      return normalizeDailySleep(payload);
    case 'sleep':
      return normalizeSleep(payload);
    case 'daily_readiness':
      return normalizeDailyReadiness(payload);
    case 'daily_activity':
      return normalizeDailyActivity(payload);
    case 'heartrate':
      return normalizeHeartRate(payload);
    case 'daily_spo2':
      return normalizeSpO2(payload);
    case 'workout':
    case 'session':
      return [];
    default:
      return [];
  }
}

/**
 * Connector entry point: map a batch of {@link RawRecord}s (whose payloads are
 * {@link OuraRawPayload}) to canonical samples. Records that are not Oura
 * payloads are skipped defensively.
 */
export function normalizeOura(raw: RawRecord[]): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    const payload = r.payload as OuraRawPayload | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !payload.collection ||
      !payload.userId ||
      !payload.connectionId
    ) {
      continue;
    }
    out.push(...normalizeOuraRecord(payload));
  }
  return out;
}
