import { WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
} from '../../normalization/normalizer.types';
import { WahooWorkout, WahooWorkoutSummary } from './wahoo.types';

/**
 * PR-HK-2.h — Wahoo → canonical normalizer (AGENT_2_CODING_PLAN §3.1).
 *
 * Pure, side-effect-free mapping from Wahoo workout records to
 * {@link NormalizedSample}[]. Wahoo is a HEALTH & FITNESS-only provider:
 * every metric below lives in the `HEALTH_FITNESS` bucket.
 *
 * §3.1 mapping (Wahoo `workouts` row):
 *   workout.minutes                      → WORKOUT_DURATION_MIN ("min")
 *   workout_summary.distance_accum       → WORKOUT_DISTANCE_M   ("m")
 *   workout_summary.heart_rate_avg       → HEART_RATE_BPM       ("bpm")
 *
 * Defenses:
 *  - `workout_summary` numerics arrive as STRINGS; we `parseFloat` and emit a
 *    metric ONLY when the source field is present AND finite. We never
 *    fabricate a `0` for an absent field (#42 no speculative ingestion).
 *  - A record with an unparseable `starts` instant is skipped rather than
 *    hashed into a garbage window/dedup key (#8 fail-safe at the boundary).
 *  - Window: `starts` is the UTC start; `endAt = startAt + minutes*60_000`
 *    (== startAt when minutes is absent/zero). `time_zone` → `sourceTz`.
 *  - `sourceRecordId` = the Wahoo workout id as a string (backfill
 *    reconciliation).
 */

/** The wrapper the Wahoo connector puts in `RawRecord.payload`. */
export interface WahooRawPayload {
  userId: string;
  connectionId: string;
  /** IANA tz the provider reported the workout in, if known. */
  sourceTz?: string | null;
  /** The untouched Wahoo workout record. */
  workout: WahooWorkout;
}

/** Canonical units (mirror WearableMetricDef seed). */
const UNIT = {
  MIN: 'min',
  METERS: 'm',
  BPM: 'bpm',
} as const;

/** Parse an ISO-8601 instant to a Date, or null if invalid/absent. */
function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Coerce a Wahoo string (or number) numeric field to a finite number, or
 * null. Wahoo `workout_summary` numerics are strings (e.g. "24909.71"); an
 * empty string, null, or non-finite parse yields null so no metric is emitted.
 */
function parseNumeric(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

interface SampleSeed {
  metric: NormalizedSample['metric'];
  value: number | null;
  unit: string;
}

/** Build a NormalizedSample, dropping null/non-finite values (#42). */
function build(
  ctx: WahooRawPayload,
  sourceRecordId: string | null,
  window: { startAt: Date; endAt: Date },
  seed: SampleSeed,
): NormalizedSample | null {
  if (seed.value === null || seed.value === undefined) return null;
  if (typeof seed.value !== 'number' || !Number.isFinite(seed.value)) {
    return null;
  }
  return {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: WearableProvider.WAHOO,
    metric: seed.metric,
    // Wahoo is H&F-only — every mapped metric's primary bucket is HEALTH_FITNESS.
    bucket: 'HEALTH_FITNESS',
    value: seed.value,
    unit: seed.unit,
    startAt: window.startAt,
    endAt: window.endAt,
    sourceTz: ctx.sourceTz ?? null,
    sourceRecordId,
  };
}

/**
 * Normalize a single Wahoo workout (wrapped with its subject user/connection)
 * into canonical samples. Returns [] when the start instant is unparseable.
 */
export function normalizeWahooWorkout(
  ctx: WahooRawPayload,
): NormalizedSample[] {
  const workout = ctx.workout;
  if (!workout) return [];

  const startAt = parseInstant(workout.starts);
  if (!startAt) return [];

  const minutes = parseNumeric(workout.minutes);
  const endAt =
    minutes !== null && minutes > 0
      ? new Date(startAt.getTime() + minutes * 60_000)
      : startAt;
  const window = { startAt, endAt };

  const id = workout.id !== undefined ? String(workout.id) : null;
  const summary: WahooWorkoutSummary = workout.workout_summary ?? {};

  const seeds: SampleSeed[] = [
    { metric: 'WORKOUT_DURATION_MIN', value: minutes, unit: UNIT.MIN },
    {
      metric: 'WORKOUT_DISTANCE_M',
      value: parseNumeric(summary.distance_accum),
      unit: UNIT.METERS,
    },
    {
      metric: 'HEART_RATE_BPM',
      value: parseNumeric(summary.heart_rate_avg),
      unit: UNIT.BPM,
    },
  ];

  return seeds
    .map((s) => build(ctx, id, window, s))
    .filter((s): s is NormalizedSample => s !== null);
}

/**
 * Connector entry point: map a batch of {@link RawRecord}s (whose payloads are
 * {@link WahooRawPayload}) to canonical samples. Records that are not Wahoo
 * payloads (or carry no subject user/connection) are skipped defensively so
 * an orphaned sample can never reach the ingestion lane (#8/#36).
 */
export function normalizeWahoo(raw: RawRecord[]): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    const payload = r.payload as WahooRawPayload | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !payload.userId ||
      !payload.connectionId ||
      !payload.workout
    ) {
      continue;
    }
    out.push(...normalizeWahooWorkout(payload));
  }
  return out;
}
