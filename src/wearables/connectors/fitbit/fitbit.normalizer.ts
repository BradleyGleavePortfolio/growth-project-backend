import { WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
} from '../../normalization/normalizer.types';
import {
  FitbitBreathingRateEntry,
  FitbitCollection,
  FitbitHeartTimeSeries,
  FitbitSleepLog,
  FitbitSpo2Entry,
  FitbitStepsTimeSeries,
  FitbitWeightLog,
} from './fitbit.types';

/**
 * PR-HK-2.e — Fitbit → canonical normalizer (AGENT_2_CODING_PLAN §3.1).
 *
 * Pure, side-effect-free mapping from Fitbit Web API provider-native records to
 * {@link NormalizedSample}[]. The connector wraps each provider record in a
 * {@link RawRecord} whose `payload` is a {@link FitbitRawPayload} carrying the
 * subject `userId` + `connectionId` (the normalizer is stateless and the
 * canonical sample requires them) plus the source `collection` tag so the
 * normalizer can dispatch without re-sniffing the shape.
 *
 * §3.1 mapping (Fitbit row):
 *   activities/steps  → STEPS (H&F)
 *   activities/heart  → RESTING_HEART_RATE_BPM (H&F)
 *                       + HEART_RATE_BPM (H&F, day-average when present)
 *   sleep             → SLEEP_TOTAL_MIN, SLEEP_REM_MIN, SLEEP_DEEP_MIN,
 *                       SLEEP_LIGHT_MIN, SLEEP_AWAKE_MIN,
 *                       SLEEP_EFFICIENCY_PCT (S&R)
 *   body/weight       → BODY_WEIGHT_KG (H&F)
 *   br                → RESPIRATORY_RATE_BRPM (S&R)
 *   spo2              → SPO2_PCT (S&R)
 *
 * Units + buckets are taken verbatim from the seeded WearableMetricDef
 * (PR-HK-0 migration): steps in "steps" / HEALTH_FITNESS, HR in "bpm" /
 * HEALTH_FITNESS, sleep durations in "min" / SLEEP_RECOVERY, efficiency in "%"
 * / SLEEP_RECOVERY, weight in "kg" / HEALTH_FITNESS, breathing rate in "brpm"
 * / SLEEP_RECOVERY, SpO2 in "%" / SLEEP_RECOVERY.
 *
 * Defenses: anything unmapped or null is dropped (no speculative ingestion,
 * #42); a record with an unparseable timestamp is skipped rather than hashed
 * into a garbage dedup key (#8 fail-safe at the boundary — the ingestion lane
 * is the hard enforcement point). Fitbit serialises time-series values as
 * STRINGS; the normalizer coerces with strict finiteness checks and drops
 * non-numeric values rather than emit NaN.
 */

/** The wrapper the Fitbit connector puts in `RawRecord.payload`. */
export interface FitbitRawPayload<T = unknown> {
  collection: FitbitCollection;
  userId: string;
  connectionId: string;
  /** IANA tz the provider reported the record in, if known. */
  sourceTz?: string | null;
  /** The untouched Fitbit provider record. */
  record: T;
}

/** Canonical units (mirror WearableMetricDef seed). */
const UNIT = {
  STEPS: 'steps',
  BPM: 'bpm',
  MIN: 'min',
  PCT: '%',
  KG: 'kg',
  BRPM: 'brpm',
} as const;

/**
 * Resolve a daily record's observation window. Fitbit daily documents are keyed
 * by calendar `date` (`YYYY-MM-DD`); we anchor the canonical window to the UTC
 * span of that day [00:00:00Z, 23:59:59.999Z]. This is deterministic and
 * tz-stable for dedup (the IANA tz, when known, is stored separately on the
 * row; it is NOT part of the dedup identity).
 */
function dayWindow(day: string): { startAt: Date; endAt: Date } | null {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(`${day}T23:59:59.999Z`);
  return { startAt: start, endAt: end };
}

/** Parse an ISO-8601 instant to a Date, or null if invalid/absent. */
function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Coerce a Fitbit numeric value (which may arrive as a string in time series)
 * to a finite number, or null. NaN / Infinity / non-numeric → null so no
 * garbage sample is emitted (#8/#42).
 */
function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
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
  ctx: FitbitRawPayload,
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
    provider: WearableProvider.FITBIT,
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

function normalizeSteps(ctx: FitbitRawPayload): NormalizedSample[] {
  const rec = ctx.record as FitbitStepsTimeSeries;
  const series = rec['activities-steps'];
  if (!Array.isArray(series)) return [];
  const out: NormalizedSample[] = [];
  for (const entry of series) {
    if (!entry?.dateTime) continue;
    const window = dayWindow(entry.dateTime);
    if (!window) continue;
    const sample = build(ctx, null, {
      metric: 'STEPS',
      bucket: 'HEALTH_FITNESS',
      value: toFiniteNumber(entry.value),
      unit: UNIT.STEPS,
      ...window,
    });
    if (sample) out.push(sample);
  }
  return out;
}

function normalizeHeart(ctx: FitbitRawPayload): NormalizedSample[] {
  const rec = ctx.record as FitbitHeartTimeSeries;
  const series = rec['activities-heart'];
  if (!Array.isArray(series)) return [];
  const out: NormalizedSample[] = [];
  for (const entry of series) {
    if (!entry?.dateTime) continue;
    const window = dayWindow(entry.dateTime);
    if (!window) continue;
    const rhr = toFiniteNumber(entry.value?.restingHeartRate);
    const sample = build(ctx, null, {
      metric: 'RESTING_HEART_RATE_BPM',
      bucket: 'HEALTH_FITNESS',
      value: rhr,
      unit: UNIT.BPM,
      ...window,
    });
    if (sample) out.push(sample);
  }
  return out;
}

/**
 * Sum the per-stage minute totals into the canonical sleep metrics. Fitbit's
 * modern "stages" model exposes `{ deep, light, rem, wake }` minute summaries;
 * classic logs expose `{ asleep, restless, awake }`. We map:
 *   SLEEP_TOTAL_MIN  ← minutesAsleep (the authoritative asleep total)
 *   SLEEP_DEEP_MIN   ← levels.summary.deep.minutes
 *   SLEEP_LIGHT_MIN  ← levels.summary.light.minutes
 *   SLEEP_REM_MIN    ← levels.summary.rem.minutes
 *   SLEEP_AWAKE_MIN  ← minutesAwake (falls back to summary.wake/awake minutes)
 *   SLEEP_EFFICIENCY_PCT ← efficiency
 * Stage metrics that are absent (classic logs lack deep/rem) are dropped (#42).
 */
function normalizeSleepLog(
  ctx: FitbitRawPayload,
  log: FitbitSleepLog,
): NormalizedSample[] {
  // Prefer the explicit start/end window; else the calendar day-of-sleep.
  const start = parseInstant(log.startTime);
  const end = parseInstant(log.endTime);
  const window =
    start && end
      ? { startAt: start, endAt: end }
      : log.dateOfSleep
        ? dayWindow(log.dateOfSleep)
        : null;
  if (!window) return [];

  const id = log.logId != null ? String(log.logId) : null;
  const summary = log.levels?.summary ?? null;

  const awakeMinutes =
    toFiniteNumber(log.minutesAwake) ??
    toFiniteNumber(summary?.wake?.minutes) ??
    toFiniteNumber(summary?.awake?.minutes);

  const seeds: SampleSeed[] = [
    {
      metric: 'SLEEP_TOTAL_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(log.minutesAsleep),
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_REM_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(summary?.rem?.minutes),
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_DEEP_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(summary?.deep?.minutes),
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_LIGHT_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(summary?.light?.minutes),
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_AWAKE_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: awakeMinutes,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_EFFICIENCY_PCT',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(log.efficiency),
      unit: UNIT.PCT,
      ...window,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

function normalizeSleep(ctx: FitbitRawPayload): NormalizedSample[] {
  // The connector may wrap either the full `{ sleep: [...] }` response or a
  // single sleep log. Tolerate both so webhook (single-day fetch) and backfill
  // (multi-log) share one normalizer.
  const rec = ctx.record as { sleep?: FitbitSleepLog[] } | FitbitSleepLog;
  const logs: FitbitSleepLog[] = Array.isArray((rec as { sleep?: unknown }).sleep)
    ? ((rec as { sleep: FitbitSleepLog[] }).sleep)
    : [rec as FitbitSleepLog];
  const out: NormalizedSample[] = [];
  for (const log of logs) {
    if (!log || typeof log !== 'object') continue;
    out.push(...normalizeSleepLog(ctx, log));
  }
  return out;
}

function normalizeWeight(ctx: FitbitRawPayload): NormalizedSample[] {
  const rec = ctx.record as { weight?: FitbitWeightLog[] } | FitbitWeightLog;
  const logs: FitbitWeightLog[] = Array.isArray(
    (rec as { weight?: unknown }).weight,
  )
    ? ((rec as { weight: FitbitWeightLog[] }).weight)
    : [rec as FitbitWeightLog];
  const out: NormalizedSample[] = [];
  for (const log of logs) {
    if (!log || typeof log !== 'object' || !log.date) continue;
    // A weight reading is instantaneous; anchor at the log's date/time when a
    // time is present, else the UTC day start.
    const instant =
      log.time != null
        ? parseInstant(`${log.date}T${log.time}Z`)
        : parseInstant(`${log.date}T00:00:00Z`);
    if (!instant) continue;
    const sample = build(ctx, log.logId != null ? String(log.logId) : null, {
      metric: 'BODY_WEIGHT_KG',
      bucket: 'HEALTH_FITNESS',
      value: toFiniteNumber(log.weight),
      unit: UNIT.KG,
      startAt: instant,
      endAt: instant,
    });
    if (sample) out.push(sample);
  }
  return out;
}

function normalizeBreathingRate(ctx: FitbitRawPayload): NormalizedSample[] {
  const rec = ctx.record as { br?: FitbitBreathingRateEntry[] };
  const series = Array.isArray(rec?.br) ? rec.br : [];
  const out: NormalizedSample[] = [];
  for (const entry of series) {
    if (!entry?.dateTime) continue;
    const window = dayWindow(entry.dateTime);
    if (!window) continue;
    const sample = build(ctx, null, {
      metric: 'RESPIRATORY_RATE_BRPM',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(entry.value?.breathingRate),
      unit: UNIT.BRPM,
      ...window,
    });
    if (sample) out.push(sample);
  }
  return out;
}

function normalizeSpo2(ctx: FitbitRawPayload): NormalizedSample[] {
  const raw = ctx.record as FitbitSpo2Entry[] | FitbitSpo2Entry;
  const entries: FitbitSpo2Entry[] = Array.isArray(raw) ? raw : [raw];
  const out: NormalizedSample[] = [];
  for (const entry of entries) {
    if (!entry?.dateTime) continue;
    const window = dayWindow(entry.dateTime);
    if (!window) continue;
    const sample = build(ctx, null, {
      metric: 'SPO2_PCT',
      bucket: 'SLEEP_RECOVERY',
      value: toFiniteNumber(entry.value?.avg),
      unit: UNIT.PCT,
      ...window,
    });
    if (sample) out.push(sample);
  }
  return out;
}

/**
 * Normalize one wrapped Fitbit record. Unknown collections yield no rows (no
 * speculative ingestion, #42).
 */
export function normalizeFitbitRecord(
  payload: FitbitRawPayload,
): NormalizedSample[] {
  switch (payload.collection) {
    case 'activities/steps':
      return normalizeSteps(payload);
    case 'activities/heart':
      return normalizeHeart(payload);
    case 'sleep':
      return normalizeSleep(payload);
    case 'body/weight':
      return normalizeWeight(payload);
    case 'br':
      return normalizeBreathingRate(payload);
    case 'spo2':
      return normalizeSpo2(payload);
    default:
      return [];
  }
}

/**
 * Connector entry point: map a batch of {@link RawRecord}s (whose payloads are
 * {@link FitbitRawPayload}) to canonical samples. Records that are not Fitbit
 * payloads are skipped defensively.
 */
export function normalizeFitbit(raw: RawRecord[]): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    const payload = r.payload as FitbitRawPayload | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !payload.collection ||
      !payload.userId ||
      !payload.connectionId
    ) {
      continue;
    }
    out.push(...normalizeFitbitRecord(payload));
  }
  return out;
}
