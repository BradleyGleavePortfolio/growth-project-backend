import { createHash } from 'crypto';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
} from '../../normalization/normalizer.types';
import {
  GarminActivity,
  GarminBodyComp,
  GarminDaily,
  GarminHrv,
  GarminRawPayload,
  GarminSleep,
} from './garmin.types';

/**
 * PR-HK-2.d — Garmin Health API → canonical normalizer.
 *
 * Maps Garmin-native summaries to {@link NormalizedSample}[] EXACTLY per
 * AGENT_2_CODING_PLAN §3.1 (anything unlisted is dropped — no speculative
 * ingestion, guard #42):
 *
 *   dailies.steps                → STEPS                (H&F)
 *   dailies.activeKilocalories   → ACTIVE_ENERGY_KCAL   (H&F)
 *   sleeps.remSleepInSeconds              → SLEEP_REM_MIN        (S&R)
 *   sleeps.deepSleepDurationInSeconds     → SLEEP_DEEP_MIN       (S&R)
 *   sleeps.lightSleepDurationInSeconds    → SLEEP_LIGHT_MIN      (S&R)
 *   sleeps.awakeDurationInSeconds         → SLEEP_AWAKE_MIN      (S&R)
 *   (sum of stages)                       → SLEEP_TOTAL_MIN      (S&R)
 *   (asleep / total in-bed)               → SLEEP_EFFICIENCY_PCT (S&R)
 *   sleeps.endingBodyBattery|bodyBatteryChange → BODY_BATTERY    (S&R)
 *   hrv.lastNightAvg             → HRV_MS               (S&R)
 *   activities.durationInSeconds → WORKOUT_DURATION_MIN (H&F)
 *   activities.distanceInMeters  → WORKOUT_DISTANCE_M   (H&F)
 *   activities.activityTrainingLoad → TRAINING_LOAD     (H&F)
 *   bodyComps.weightInGrams      → BODY_WEIGHT_KG       (H&F)
 *   bodyComps.bodyFatInPercent   → BODY_FAT_PCT         (H&F)
 *
 * Invariants:
 *  - Garmin durations are SECONDS — converted to minutes here (`sec / 60`).
 *  - Garmin weight is GRAMS — converted to kilograms (`g / 1000`).
 *  - Timestamps are epoch SECONDS; `startTimeInSeconds * 1000` builds the UTC
 *    instant. `startTimeOffsetInSeconds` is rendered into an IANA-ish UTC
 *    offset string on `sourceTz` (e.g. "UTC+01:00") so day-bucketing across
 *    DST/travel is correct without losing the provider's reported local frame.
 *  - The (user_id, metric, start_at, end_at)-derived DB dedup is implemented
 *    in the foundation ingestion lane via `computeDedupKey`. The §-style
 *    connector-level key is exposed by {@link garminDedupKey} for
 *    connector-level idempotency / logging and asserted in the spec.
 *  - Records with no resolvable subject/connection ctx, no parseable window,
 *    or a missing metric value are skipped — no half-baked sample crosses the
 *    ingestion boundary.
 */

const PROVIDER: WearableProvider = WearableProvider.GARMIN;
const SEC_PER_MIN = 60;
const GRAMS_PER_KG = 1000;

const SR: WearableMetricBucket = WearableMetricBucket.SLEEP_RECOVERY;
const HF: WearableMetricBucket = WearableMetricBucket.HEALTH_FITNESS;

/** Canonical unit strings (match WearableMetricDef.unit seeded in PR-HK-0). */
const UNIT = {
  steps: 'steps',
  kcal: 'kcal',
  min: 'min',
  pct: '%',
  ms: 'ms',
  m: 'm',
  kg: 'kg',
  score: 'score',
} as const;

/**
 * The §3.1 connector-level dedup key:
 *   sha256("garmin:" + user_id + ":" + metric + ":" + start_iso + ":" + value)
 *
 * Distinct from the foundation row dedup_key (which omits value and is the DB
 * uniqueness key). This connector key folds in the value so a corrected
 * re-push (same window, new value) is recognised as a *different* connector
 * observation for logging/idempotency.
 */
export function garminDedupKey(input: {
  userId: number | string;
  metric: WearableMetricType;
  startAt: Date;
  value: number;
}): string {
  const canonical = [
    'garmin',
    String(input.userId),
    input.metric,
    input.startAt.toISOString(),
    String(input.value),
  ].join(':');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Render a Garmin UTC offset (seconds) into a stable `UTC±HH:MM` source-tz
 * string. Garmin reports an offset, not an IANA zone; we preserve the offset
 * so downstream day-bucketing can apply it deterministically (no zone DB
 * lookup, no DST guessing).
 */
export function offsetToSourceTz(offsetSeconds?: number): string {
  if (offsetSeconds == null || !Number.isFinite(offsetSeconds)) {
    return 'UTC';
  }
  const sign = offsetSeconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const hh = Math.floor(abs / 3600)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor((abs % 3600) / 60)
    .toString()
    .padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** Build the UTC [start,end] window from a Garmin summary's epoch seconds. */
function resolveWindow(
  startSec?: number,
  durationSec?: number,
): { start: Date; end: Date } | null {
  if (startSec == null || !Number.isFinite(startSec)) {
    return null;
  }
  const start = new Date(startSec * 1000);
  if (Number.isNaN(start.getTime())) {
    return null;
  }
  const dur = durationSec != null && durationSec > 0 ? durationSec : 0;
  const end = new Date((startSec + dur) * 1000);
  return { start, end: end < start ? start : end };
}

/**
 * Normalize a batch of Garmin raw records. `userId`/`connectionId` are the
 * subject-client + connection ids resolved by the connection/webhook layer;
 * the connector threads them onto each payload. The batch-level `ctx` is a
 * fallback when a record omits them.
 */
export function normalizeGarmin(
  raw: RawRecord[],
  ctx?: { userId: string; connectionId: string },
): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    if (r.provider !== PROVIDER) {
      // Defensive: a foreign record must never be normalized as Garmin.
      continue;
    }
    const payload = r.payload as GarminRawPayload | undefined;
    if (!payload || typeof payload !== 'object' || !('kind' in payload)) {
      continue;
    }
    const recCtx = {
      userId: payload.userId ?? ctx?.userId,
      connectionId: payload.connectionId ?? ctx?.connectionId,
    };
    if (!recCtx.userId || !recCtx.connectionId) {
      continue;
    }
    const resolved = {
      userId: recCtx.userId,
      connectionId: recCtx.connectionId,
    };
    switch (payload.kind) {
      case 'dailies':
        pushDaily(out, payload.data as GarminDaily, resolved, r.id);
        break;
      case 'sleeps':
        pushSleep(out, payload.data as GarminSleep, resolved, r.id);
        break;
      case 'hrv':
        pushHrv(out, payload.data as GarminHrv, resolved, r.id);
        break;
      case 'activities':
        pushActivity(out, payload.data as GarminActivity, resolved, r.id);
        break;
      case 'bodyComps':
        pushBodyComp(out, payload.data as GarminBodyComp, resolved, r.id);
        break;
      default:
        break;
    }
  }
  return out;
}

type Ctx = { userId: string; connectionId: string };

function pushDaily(
  out: NormalizedSample[],
  d: GarminDaily,
  ctx: Ctx,
  sourceRecordId?: string,
): void {
  const win = resolveWindow(d.startTimeInSeconds, d.durationInSeconds);
  if (!win) return;
  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: HF,
    startAt: win.start,
    endAt: win.end,
    sourceTz: offsetToSourceTz(d.startTimeOffsetInSeconds),
    sourceRecordId: sourceRecordId ?? d.summaryId ?? null,
  };
  if (typeof d.steps === 'number') {
    out.push({
      ...base,
      metric: WearableMetricType.STEPS,
      value: d.steps,
      unit: UNIT.steps,
    });
  }
  if (typeof d.activeKilocalories === 'number') {
    out.push({
      ...base,
      metric: WearableMetricType.ACTIVE_ENERGY_KCAL,
      value: d.activeKilocalories,
      unit: UNIT.kcal,
    });
  }
}

function pushSleep(
  out: NormalizedSample[],
  s: GarminSleep,
  ctx: Ctx,
  sourceRecordId?: string,
): void {
  // Only ingest enhanced (auto-detected) sleep with stage data — manual /
  // unconfirmed sleep entries lack reliable stage breakdowns.
  if (s.validation && !s.validation.startsWith('ENHANCED')) return;
  const win = resolveWindow(s.startTimeInSeconds, s.durationInSeconds);
  if (!win) return;
  const tz = offsetToSourceTz(s.startTimeOffsetInSeconds);
  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: SR,
    startAt: win.start,
    endAt: win.end,
    sourceTz: tz,
    sourceRecordId: sourceRecordId ?? s.summaryId ?? null,
  };
  const min = (sec?: number): number | null =>
    typeof sec === 'number' && Number.isFinite(sec) ? sec / SEC_PER_MIN : null;

  const rem = min(s.remSleepInSeconds);
  const deep = min(s.deepSleepDurationInSeconds);
  const light = min(s.lightSleepDurationInSeconds);
  const awake = min(s.awakeDurationInSeconds);

  if (rem != null) {
    out.push({ ...base, metric: WearableMetricType.SLEEP_REM_MIN, value: rem, unit: UNIT.min });
  }
  if (deep != null) {
    out.push({ ...base, metric: WearableMetricType.SLEEP_DEEP_MIN, value: deep, unit: UNIT.min });
  }
  if (light != null) {
    out.push({ ...base, metric: WearableMetricType.SLEEP_LIGHT_MIN, value: light, unit: UNIT.min });
  }
  if (awake != null) {
    out.push({ ...base, metric: WearableMetricType.SLEEP_AWAKE_MIN, value: awake, unit: UNIT.min });
  }

  // SLEEP_TOTAL_MIN = sum of all reported stages (Garmin does not send a
  // single "total sleep" field; we derive it from the stage durations).
  const stages = [rem, deep, light, awake].filter(
    (v): v is number => v != null,
  );
  if (stages.length > 0) {
    const totalMin = stages.reduce((a, b) => a + b, 0);
    out.push({
      ...base,
      metric: WearableMetricType.SLEEP_TOTAL_MIN,
      value: totalMin,
      unit: UNIT.min,
    });
    // SLEEP_EFFICIENCY_PCT = asleep / time-in-bed, where time-in-bed =
    // asleep + awake. Only emitted when an awake figure is present so the
    // denominator is meaningful; clamped to [0,100].
    const asleep = (rem ?? 0) + (deep ?? 0) + (light ?? 0);
    if (awake != null && asleep + awake > 0) {
      const eff = Math.min(100, Math.max(0, (asleep / (asleep + awake)) * 100));
      out.push({
        ...base,
        metric: WearableMetricType.SLEEP_EFFICIENCY_PCT,
        value: eff,
        unit: UNIT.pct,
      });
    }
  }

  // BODY_BATTERY — prefer the ending body battery; fall back to the change.
  const battery =
    typeof s.endingBodyBattery === 'number'
      ? s.endingBodyBattery
      : typeof s.bodyBatteryChange === 'number'
        ? s.bodyBatteryChange
        : null;
  if (battery != null) {
    out.push({
      ...base,
      metric: WearableMetricType.BODY_BATTERY,
      value: battery,
      unit: UNIT.score,
    });
  }
}

function pushHrv(
  out: NormalizedSample[],
  h: GarminHrv,
  ctx: Ctx,
  sourceRecordId?: string,
): void {
  if (typeof h.lastNightAvg !== 'number' || !Number.isFinite(h.lastNightAvg)) {
    return;
  }
  const win = resolveWindow(h.startTimeInSeconds, h.durationInSeconds);
  if (!win) return;
  out.push({
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    metric: WearableMetricType.HRV_MS,
    bucket: SR,
    value: h.lastNightAvg,
    unit: UNIT.ms,
    startAt: win.start,
    endAt: win.end,
    sourceTz: offsetToSourceTz(h.startTimeOffsetInSeconds),
    sourceRecordId: sourceRecordId ?? h.summaryId ?? null,
  });
}

function pushActivity(
  out: NormalizedSample[],
  a: GarminActivity,
  ctx: Ctx,
  sourceRecordId?: string,
): void {
  const win = resolveWindow(a.startTimeInSeconds, a.durationInSeconds);
  if (!win) return;
  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: HF,
    startAt: win.start,
    endAt: win.end,
    sourceTz: offsetToSourceTz(a.startTimeOffsetInSeconds),
    sourceRecordId: sourceRecordId ?? a.summaryId ?? null,
  };
  // WORKOUT_DURATION_MIN — from the activity duration (seconds → minutes).
  if (typeof a.durationInSeconds === 'number' && a.durationInSeconds >= 0) {
    out.push({
      ...base,
      metric: WearableMetricType.WORKOUT_DURATION_MIN,
      value: a.durationInSeconds / SEC_PER_MIN,
      unit: UNIT.min,
    });
  }
  if (
    typeof a.distanceInMeters === 'number' &&
    Number.isFinite(a.distanceInMeters)
  ) {
    out.push({
      ...base,
      metric: WearableMetricType.WORKOUT_DISTANCE_M,
      value: a.distanceInMeters,
      unit: UNIT.m,
    });
  }
  if (
    typeof a.activityTrainingLoad === 'number' &&
    Number.isFinite(a.activityTrainingLoad)
  ) {
    out.push({
      ...base,
      metric: WearableMetricType.TRAINING_LOAD,
      value: a.activityTrainingLoad,
      unit: UNIT.score,
    });
  }
}

function pushBodyComp(
  out: NormalizedSample[],
  b: GarminBodyComp,
  ctx: Ctx,
  sourceRecordId?: string,
): void {
  // Body comp is a point-in-time measurement; use the start instant as the
  // window (start == end) when no duration is reported.
  const win = resolveWindow(b.startTimeInSeconds, b.durationInSeconds);
  if (!win) return;
  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: HF,
    startAt: win.start,
    endAt: win.end,
    sourceTz: offsetToSourceTz(b.startTimeOffsetInSeconds),
    sourceRecordId: sourceRecordId ?? b.summaryId ?? null,
  };
  if (typeof b.weightInGrams === 'number' && b.weightInGrams > 0) {
    out.push({
      ...base,
      metric: WearableMetricType.BODY_WEIGHT_KG,
      value: b.weightInGrams / GRAMS_PER_KG,
      unit: UNIT.kg,
    });
  }
  if (
    typeof b.bodyFatInPercent === 'number' &&
    Number.isFinite(b.bodyFatInPercent)
  ) {
    out.push({
      ...base,
      metric: WearableMetricType.BODY_FAT_PCT,
      value: b.bodyFatInPercent,
      unit: UNIT.pct,
    });
  }
}
