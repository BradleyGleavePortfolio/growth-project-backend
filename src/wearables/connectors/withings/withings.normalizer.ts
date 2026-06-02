import { WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
} from '../../normalization/normalizer.types';
import {
  WithingsCollection,
  WithingsMeasureGroup,
  WithingsSleepSummarySeries,
} from './withings.types';

/**
 * PR-HK-2.i — Withings → canonical normalizer (AGENT_2_CODING_PLAN §3.1).
 *
 * Pure, side-effect-free mapping from Withings provider-native records to
 * {@link NormalizedSample}[]. The connector wraps each provider record in a
 * {@link RawRecord} whose `payload` is a {@link WithingsRawPayload} carrying the
 * subject `userId` + `connectionId` (the normalizer is stateless and the
 * canonical sample requires them) plus the source `collection` tag so the
 * normalizer dispatches without re-sniffing the shape.
 *
 * §3.1 mapping (Withings row):
 *   measure type 1  → BODY_WEIGHT_KG      (H&F, kg)
 *   measure type 6  → BODY_FAT_PCT        (H&F, %)
 *   measure type 9  → BLOOD_PRESSURE_DIA  (H&F, mmHg)
 *   measure type 10 → BLOOD_PRESSURE_SYS  (H&F, mmHg)
 *   sleep total_sleep_time   → SLEEP_TOTAL_MIN       (S&R, min)
 *   sleep remsleepduration   → SLEEP_REM_MIN         (S&R, min)
 *   sleep deepsleepduration  → SLEEP_DEEP_MIN        (S&R, min)
 *   sleep lightsleepduration → SLEEP_LIGHT_MIN       (S&R, min)
 *   sleep wakeupduration     → SLEEP_AWAKE_MIN       (S&R, min)
 *   sleep sleep_efficiency   → SLEEP_EFFICIENCY_PCT  (S&R, %; 0–1 ratio → percent)
 *   sleep rr_average         → RESPIRATORY_RATE_BRPM (S&R, br/min)
 *
 * Units + buckets are taken verbatim from the seeded WearableMetricDef
 * (PR-HK-0 migration `20260531000000_wearables_foundation`): weight `kg`, fat
 * `%`, blood pressure `mmHg` (all HEALTH_FITNESS); sleep durations `min`,
 * efficiency `%`, respiratory rate `br/min` (all SLEEP_RECOVERY).
 *
 * Withings encoding quirks handled here:
 *  - A measure's real value is `value * 10^unit` (the `unit` field is a base-10
 *    decimal EXPONENT, not a unit string) — `decodeMeasure` applies it.
 *  - Sleep durations arrive in SECONDS → converted to whole minutes.
 *  - `sleep_efficiency` is a 0–1 ratio → multiplied by 100 to match the seeded
 *    `%` unit.
 *
 * Defenses: anything unmapped or null is dropped (no speculative ingestion,
 * #42); a record with an unparseable/zero window is skipped rather than hashed
 * into a garbage dedup key (#8 fail-safe at the boundary).
 */

/** The wrapper the Withings connector puts in `RawRecord.payload`. */
export interface WithingsRawPayload<T = unknown> {
  collection: WithingsCollection;
  userId: string;
  connectionId: string;
  /** IANA tz the provider reported the record in, if known. */
  sourceTz?: string | null;
  /** The untouched Withings provider record (measure group or sleep series). */
  record: T;
}

/** Canonical units (mirror WearableMetricDef seed — PR-HK-0). */
const UNIT = {
  MIN: 'min',
  PCT: '%',
  KG: 'kg',
  MMHG: 'mmHg',
  BRPM: 'br/min',
} as const;

/** Withings measure `type` → canonical metric (H&F). §3.1. */
const MEASURE_TYPE_WEIGHT = 1;
const MEASURE_TYPE_FAT_RATIO = 6;
const MEASURE_TYPE_DIASTOLIC = 9;
const MEASURE_TYPE_SYSTOLIC = 10;

/** Seconds → whole minutes (Withings emits sleep durations in seconds). */
function secondsToMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/** UNIX epoch SECONDS → Date, or null if absent / non-finite / non-positive. */
function epochSecondsToDate(epoch: number | null | undefined): Date | null {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) {
    return null;
  }
  return new Date(epoch * 1000);
}

/** Decode a Withings measure to its real value: `value * 10^unit`. */
function decodeMeasure(value: number, unit: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (typeof unit !== 'number' || !Number.isFinite(unit)) return null;
  return value * Math.pow(10, unit);
}

interface SampleSeed {
  metric: NormalizedSample['metric'];
  bucket: NormalizedSample['bucket'];
  value: number | null | undefined;
  unit: string;
  startAt: Date;
  endAt: Date;
}

/** Build a NormalizedSample, dropping null/non-finite values (#42). */
function build(
  ctx: WithingsRawPayload,
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
    provider: WearableProvider.WITHINGS,
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
 * Normalize one Withings measure GROUP. A group is taken at a single instant
 * (`date`, epoch seconds) and bundles 1..n physical measures; we emit one
 * canonical sample per mapped measure type, all anchored to that instant
 * (start == end). Blood-pressure systolic/diastolic arrive as separate measures
 * inside the SAME group, so a BP reading yields two distinct samples (distinct
 * metrics → distinct dedup keys). Unmapped measure types are dropped (#42).
 */
function normalizeMeasure(ctx: WithingsRawPayload): NormalizedSample[] {
  const rec = ctx.record as WithingsMeasureGroup;
  const at = epochSecondsToDate(rec?.date);
  if (!at) return [];
  // Skip user-objective groups (category 2) — only real measures (category 1
  // or absent) are observations worth ingesting.
  if (rec.category === 2) return [];
  const id = rec.grpid != null ? String(rec.grpid) : null;
  if (!Array.isArray(rec.measures)) return [];

  const out: NormalizedSample[] = [];
  for (const m of rec.measures) {
    const real = decodeMeasure(m?.value, m?.unit);
    if (real === null) continue;
    let seed: SampleSeed | null = null;
    switch (m.type) {
      case MEASURE_TYPE_WEIGHT:
        seed = {
          metric: 'BODY_WEIGHT_KG',
          bucket: 'HEALTH_FITNESS',
          value: real,
          unit: UNIT.KG,
          startAt: at,
          endAt: at,
        };
        break;
      case MEASURE_TYPE_FAT_RATIO:
        seed = {
          metric: 'BODY_FAT_PCT',
          bucket: 'HEALTH_FITNESS',
          value: real,
          unit: UNIT.PCT,
          startAt: at,
          endAt: at,
        };
        break;
      case MEASURE_TYPE_DIASTOLIC:
        seed = {
          metric: 'BLOOD_PRESSURE_DIA',
          bucket: 'HEALTH_FITNESS',
          value: real,
          unit: UNIT.MMHG,
          startAt: at,
          endAt: at,
        };
        break;
      case MEASURE_TYPE_SYSTOLIC:
        seed = {
          metric: 'BLOOD_PRESSURE_SYS',
          bucket: 'HEALTH_FITNESS',
          value: real,
          unit: UNIT.MMHG,
          startAt: at,
          endAt: at,
        };
        break;
      default:
        seed = null;
    }
    if (!seed) continue;
    const sample = build(ctx, id, seed);
    if (sample) out.push(sample);
  }
  return out;
}

/**
 * Normalize one Withings sleep SUMMARY series (one per night). Durations are
 * SECONDS → minutes; `sleep_efficiency` is a 0–1 ratio → percent; `rr_average`
 * is breaths/min. The observation window is the night's `[startdate, enddate]`
 * span (epoch seconds). HRV-equivalent ordering keeps respiratory rate last so
 * the golden sample ordering is stable.
 */
function normalizeSleep(ctx: WithingsRawPayload): NormalizedSample[] {
  const rec = ctx.record as WithingsSleepSummarySeries;
  const startAt = epochSecondsToDate(rec?.startdate);
  const endAt = epochSecondsToDate(rec?.enddate);
  if (!startAt || !endAt) return [];
  if (startAt.getTime() > endAt.getTime()) return [];
  const id = rec.id != null ? String(rec.id) : null;
  const data = rec.data ?? {};
  const window = { startAt, endAt };

  const seeds: SampleSeed[] = [
    {
      metric: 'SLEEP_TOTAL_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        data.total_sleep_time != null
          ? secondsToMinutes(data.total_sleep_time)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_REM_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        data.remsleepduration != null
          ? secondsToMinutes(data.remsleepduration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_DEEP_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        data.deepsleepduration != null
          ? secondsToMinutes(data.deepsleepduration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_LIGHT_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        data.lightsleepduration != null
          ? secondsToMinutes(data.lightsleepduration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_AWAKE_MIN',
      bucket: 'SLEEP_RECOVERY',
      value:
        data.wakeupduration != null
          ? secondsToMinutes(data.wakeupduration)
          : null,
      unit: UNIT.MIN,
      ...window,
    },
    {
      metric: 'SLEEP_EFFICIENCY_PCT',
      bucket: 'SLEEP_RECOVERY',
      // Withings reports efficiency as a 0–1 ratio; the seeded unit is percent.
      value:
        data.sleep_efficiency != null
          ? Math.round(data.sleep_efficiency * 100)
          : null,
      unit: UNIT.PCT,
      ...window,
    },
    {
      metric: 'RESPIRATORY_RATE_BRPM',
      bucket: 'SLEEP_RECOVERY',
      value: data.rr_average ?? null,
      unit: UNIT.BRPM,
      ...window,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, s))
    .filter((s): s is NormalizedSample => s !== null);
}

/**
 * Normalize one wrapped Withings record by its source collection tag.
 */
export function normalizeWithingsRecord(
  payload: WithingsRawPayload,
): NormalizedSample[] {
  switch (payload.collection) {
    case 'measure':
      return normalizeMeasure(payload);
    case 'sleep':
      return normalizeSleep(payload);
    default:
      return [];
  }
}

/**
 * Connector entry point: map a batch of {@link RawRecord}s (whose payloads are
 * {@link WithingsRawPayload}) to canonical samples. Records that are not
 * Withings payloads are skipped defensively.
 */
export function normalizeWithings(raw: RawRecord[]): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    const payload = r.payload as WithingsRawPayload | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !payload.collection ||
      !payload.userId ||
      !payload.connectionId
    ) {
      continue;
    }
    out.push(...normalizeWithingsRecord(payload));
  }
  return out;
}
