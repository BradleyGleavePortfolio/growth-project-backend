import { WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
} from '../../normalization/normalizer.types';
import {
  PolarExercise,
  PolarNightlyRecharge,
  PolarResource,
  PolarSleep,
} from './polar.types';

/**
 * PR-HK-2.g — Polar → canonical normalizer (AGENT_2_CODING_PLAN §3.1).
 *
 * Pure, side-effect-free mapping from Polar AccessLink v3 provider-native
 * records to {@link NormalizedSample}[]. The connector wraps each provider
 * record in a {@link RawRecord} whose `payload` is a {@link PolarRawPayload}
 * carrying the subject `userId` + `connectionId` (the normalizer is stateless
 * and the canonical sample requires them) plus the source `resource` tag so
 * the normalizer can dispatch without re-sniffing the shape.
 *
 * §3.1 mapping (Polar row) — implemented EXACTLY as bound; anything not listed
 * is dropped (no speculative/derived metrics):
 *   exercises        → WORKOUT_DURATION_MIN, WORKOUT_DISTANCE_M,
 *                      HEART_RATE_BPM                              (HEALTH_FITNESS)
 *   sleep            → SLEEP_TOTAL_MIN, SLEEP_REM_MIN, SLEEP_DEEP_MIN,
 *                      SLEEP_LIGHT_MIN, SLEEP_AWAKE_MIN             (SLEEP_RECOVERY)
 *   nightly-recharge → RECOVERY_SCORE, HRV_MS                     (SLEEP_RECOVERY)
 *
 * Units + buckets are taken verbatim from the seeded WearableMetricDef
 * (PR-HK-0 migration): durations in "min", distance in "m", HR/HRV in
 * "bpm"/"ms", score in "score".
 *
 * Unit conversions:
 *  - Exercise `duration` is an ISO-8601 duration ("PT1H30M") → whole minutes.
 *  - Sleep stage durations are SECONDS → whole minutes.
 *
 * The §3.1 Polar binding limits sleep to minute-based stage metrics, so the
 * normalizer deliberately does NOT emit a derived SLEEP_EFFICIENCY_PCT sample.
 *
 * Defenses: anything unmapped or null is dropped (no speculative ingestion,
 * #42); a record with an unparseable date/window is skipped rather than
 * hashed into a garbage dedup key (#8 fail-safe at the boundary).
 */

/** The wrapper the Polar connector puts in `RawRecord.payload`. */
export interface PolarRawPayload<T = unknown> {
  resource: PolarResource;
  userId: string;
  connectionId: string;
  /** IANA tz the provider reported the record in, if known. */
  sourceTz?: string | null;
  /** The untouched Polar provider record. */
  record: T;
}

/** Canonical units (mirror WearableMetricDef seed). */
const UNIT = {
  MIN: 'min',
  METRE: 'm',
  BPM: 'bpm',
  MS: 'ms',
  SCORE: 'score',
} as const;

/** Seconds → whole minutes (Polar emits sleep stage durations in seconds). */
function secondsToMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/**
 * Parse an ISO-8601 duration string (e.g. "PT2H44M45S", "PT30M", "PT45S")
 * into whole minutes. Only the time component (H/M/S) is supported, which is
 * all Polar emits for a training session. Returns null on an absent or
 * unparseable value so no speculative duration sample is emitted (#42).
 */
export function parseIso8601DurationToMinutes(
  iso: string | null | undefined,
): number | null {
  if (!iso || typeof iso !== 'string') return null;
  // PT[nH][nM][nS] — fractional seconds tolerated (e.g. "PT44M45.5S").
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    iso.trim(),
  );
  if (!match) return null;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return null;
  const hours = h ? Number(h) : 0;
  const minutes = m ? Number(m) : 0;
  const seconds = s ? Number(s) : 0;
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Math.round(totalSeconds / 60);
}

/** Parse an ISO-8601 instant to a Date, or null if invalid/absent. */
function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a date-keyed record's observation window. Polar sleep/recharge
 * documents are keyed by calendar `date` (`YYYY-MM-DD`); we anchor the
 * canonical window to the UTC span of that day [00:00:00Z, 23:59:59.999Z]
 * unless an explicit start/end is present. This is deterministic and tz-stable
 * for dedup.
 */
function dayWindow(date: string): { startAt: Date; endAt: Date } | null {
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(`${date}T23:59:59.999Z`);
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
  ctx: PolarRawPayload,
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
    provider: WearableProvider.POLAR,
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
 * Resolve the observation window for an exercise. Prefers the explicit
 * `start-time` + `start-time-utc-offset` (Polar reports start in LOCAL time
 * with a separate UTC-offset in minutes), anchoring the end to start +
 * duration. Falls back to dropping the record if no valid start exists.
 */
function exerciseWindow(
  rec: PolarExercise,
  durationMinutes: number | null,
): { startAt: Date; endAt: Date } | null {
  const local = rec['start-time'];
  if (!local) return null;
  const offsetMin = rec['start-time-utc-offset'];
  // Compose an offset-aware ISO instant when an offset is supplied; otherwise
  // treat the local string as already-zoned (best effort, then validated).
  let startAt: Date | null;
  if (typeof offsetMin === 'number' && Number.isFinite(offsetMin)) {
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    startAt = parseInstant(`${local}${sign}${hh}:${mm}`);
  } else {
    startAt = parseInstant(local);
  }
  if (!startAt) return null;
  const endAt =
    durationMinutes != null
      ? new Date(startAt.getTime() + durationMinutes * 60_000)
      : startAt;
  return { startAt, endAt };
}

function normalizeExercise(ctx: PolarRawPayload): NormalizedSample[] {
  const rec = ctx.record as PolarExercise;
  const durationMinutes = parseIso8601DurationToMinutes(rec.duration);
  const window = exerciseWindow(rec, durationMinutes);
  if (!window) return [];
  const id = rec.id != null ? String(rec.id) : null;

  const seeds: SampleSeed[] = [
    {
      metric: 'WORKOUT_DURATION_MIN',
      bucket: 'HEALTH_FITNESS',
      value: durationMinutes,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'WORKOUT_DISTANCE_M',
      bucket: 'HEALTH_FITNESS',
      value: rec.distance ?? null,
      unit: UNIT.METRE,
      ...window,
    },
    {
      metric: 'HEART_RATE_BPM',
      bucket: 'HEALTH_FITNESS',
      value: rec['heart-rate']?.average ?? null,
      unit: UNIT.BPM,
      ...window,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

function sumStages(rec: PolarSleep): number | null {
  const parts = [rec.light_sleep, rec.deep_sleep, rec.rem_sleep];
  let sum = 0;
  let any = false;
  for (const p of parts) {
    if (typeof p === 'number' && Number.isFinite(p)) {
      sum += p;
      any = true;
    }
  }
  return any ? sum : null;
}

function normalizeSleep(ctx: PolarRawPayload): NormalizedSample[] {
  const rec = ctx.record as PolarSleep;
  const start = parseInstant(rec.sleep_start_time);
  const end = parseInstant(rec.sleep_end_time);
  const window =
    start && end ? { startAt: start, endAt: end } : dayWindow(rec.date);
  if (!window) return [];
  const id = rec.date ?? null;

  const asleepSeconds = sumStages(rec);

  const seeds: SampleSeed[] = [
    {
      metric: 'SLEEP_TOTAL_MIN',
      bucket: 'SLEEP_RECOVERY',
      value: asleepSeconds != null ? secondsToMinutes(asleepSeconds) : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_REM_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.rem_sleep != null ? secondsToMinutes(rec.rem_sleep) : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_DEEP_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.deep_sleep != null ? secondsToMinutes(rec.deep_sleep) : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_LIGHT_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.light_sleep != null ? secondsToMinutes(rec.light_sleep) : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_AWAKE_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        rec.total_interruption_duration != null
          ? secondsToMinutes(rec.total_interruption_duration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

function normalizeNightlyRecharge(ctx: PolarRawPayload): NormalizedSample[] {
  const rec = ctx.record as PolarNightlyRecharge;
  const window = dayWindow(rec.date);
  if (!window) return [];
  const id = rec.date ?? null;

  const seeds: SampleSeed[] = [
    {
      metric: 'RECOVERY_SCORE',
      bucket: 'SLEEP_RECOVERY',
      value: rec.nightly_recharge_status ?? null,
      unit: UNIT.SCORE,
      ...window,
    },
    {
      metric: 'HRV_MS',
      bucket: 'SLEEP_RECOVERY',
      value: rec.heart_rate_variability_avg ?? null,
      unit: UNIT.MS,
      ...window,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

/** Normalize one wrapped Polar record by its source resource. */
export function normalizePolarRecord(
  payload: PolarRawPayload,
): NormalizedSample[] {
  switch (payload.resource) {
    case 'exercises':
      return normalizeExercise(payload);
    case 'sleep':
      return normalizeSleep(payload);
    case 'nightly-recharge':
      return normalizeNightlyRecharge(payload);
    default:
      return [];
  }
}

/**
 * Connector entry point: map a batch of {@link RawRecord}s (whose payloads are
 * {@link PolarRawPayload}) to canonical samples. Records that are not Polar
 * payloads are skipped defensively.
 */
export function normalizePolar(raw: RawRecord[]): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    const payload = r.payload as PolarRawPayload | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !payload.resource ||
      !payload.userId ||
      !payload.connectionId
    ) {
      continue;
    }
    out.push(...normalizePolarRecord(payload));
  }
  return out;
}
