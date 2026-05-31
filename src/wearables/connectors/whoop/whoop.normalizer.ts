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
  WhoopCycle,
  WhoopRawPayload,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from './whoop.types';

/**
 * PR-HK-2.l — WHOOP v2 → canonical normalizer.
 *
 * Maps WHOOP-native records to {@link NormalizedSample}[] EXACTLY per
 * AGENT_2_CODING_PLAN §3.1 (anything unlisted is dropped — no speculative
 * ingestion, guard #42):
 *
 *   recovery.score.recovery_score         → RECOVERY_SCORE        (S&R)
 *   recovery.score.hrv_rmssd_milli         → HRV_MS                (S&R)
 *   recovery.score.resting_heart_rate      → RESTING_HEART_RATE_BPM(S&R)
 *   cycle.score.strain                     → STRAIN_SCORE          (S&R)
 *   sleep.score.stage_summary.total_in_bed_time_milli         → SLEEP_TOTAL_MIN  (S&R)
 *   sleep.score.stage_summary.total_rem_sleep_time_milli      → SLEEP_REM_MIN    (S&R)
 *   sleep.score.stage_summary.total_slow_wave_sleep_time_milli→ SLEEP_DEEP_MIN   (S&R)
 *   sleep.score.stage_summary.total_light_sleep_time_milli    → SLEEP_LIGHT_MIN  (S&R)
 *   sleep.score.stage_summary.total_awake_time_milli          → SLEEP_AWAKE_MIN  (S&R)
 *   sleep.score.sleep_efficiency_percentage                   → SLEEP_EFFICIENCY_PCT (S&R)
 *   workout                                → WORKOUT_DURATION_MIN, WORKOUT_DISTANCE_M (H&F)
 *
 * Invariants:
 *  - WHOOP sleep stage durations are MILLISECONDS — converted to minutes
 *    here (`milli / 60000`). Efficiency and recovery scores are passed
 *    through (already a percentage / 0–100 score).
 *  - All timestamps are interpreted as UTC ISO-8601 instants (`new Date(iso)`)
 *    and the canonical samples carry UTC `startAt`/`endAt`; `sourceTz` is set
 *    to `'UTC'` because the WHOOP record timestamps are already UTC.
 *  - The (user_id, metric, start_at, value)-derived dedup is implemented in
 *    the foundation ingestion lane via {@link computeDedupKey}
 *    (sha256(user_id|provider|metric|start_iso|end_iso)). The §-required
 *    "whoop:user_id:metric:start_at:value" key is exposed by
 *    {@link whoopDedupKey} for connector-level idempotency / logging and
 *    asserted in the spec.
 *  - PENDING_SCORE / UNSCORABLE records (null `score`) are skipped — no
 *    half-computed sample crosses the boundary.
 *  - Instantaneous scores (recovery/strain) use the record's window where
 *    available; recovery has no native window, so it uses `created_at` as a
 *    point-in-time instant (startAt == endAt).
 */

import { createHash } from 'crypto';

const PROVIDER: WearableProvider = WearableProvider.WHOOP;
const MS_PER_MIN = 60_000;

const SR: WearableMetricBucket = WearableMetricBucket.SLEEP_RECOVERY;
const HF: WearableMetricBucket = WearableMetricBucket.HEALTH_FITNESS;

/** Canonical unit strings (match WearableMetricDef.unit seeded in PR-HK-0). */
const UNIT = {
  score: 'score',
  ms: 'ms',
  bpm: 'bpm',
  min: 'min',
  pct: '%',
  m: 'm',
} as const;

/**
 * The §3.1 connector-level dedup key:
 *   sha256("whoop:" + user_id + ":" + metric + ":" + start_iso + ":" + value)
 *
 * Distinct from the foundation row dedup_key (which omits value and is the
 * DB uniqueness key). This connector key additionally folds in the value so a
 * corrected re-score (same window, new value) is recognised as a *different*
 * connector observation for logging/idempotency, per the WHOOP task spec.
 */
export function whoopDedupKey(input: {
  userId: number | string;
  metric: WearableMetricType;
  startAt: Date;
  value: number;
}): string {
  const canonical = [
    'whoop',
    String(input.userId),
    input.metric,
    input.startAt.toISOString(),
    String(input.value),
  ].join(':');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Normalize a batch of WHOOP raw records. `userId`/`connectionId` are the
 * subject-client + connection ids resolved by the connection layer; the
 * connector threads them in via the RawRecord caller. Because RawRecord
 * itself does not carry them, the connector wraps the records with the
 * needed context and calls {@link normalizeWhoop} with it.
 */
export function normalizeWhoop(
  raw: RawRecord[],
  ctx?: { userId: string; connectionId: string },
): NormalizedSample[] {
  const out: NormalizedSample[] = [];
  for (const r of raw) {
    if (r.provider !== PROVIDER) {
      // Defensive: a foreign record must never be normalized as WHOOP.
      continue;
    }
    const payload = r.payload as WhoopRawPayload | undefined;
    if (!payload || typeof payload !== 'object' || !('kind' in payload)) {
      continue;
    }
    // Per-record context: prefer the ids threaded onto the payload by the
    // connector; fall back to the batch-level ctx argument. Skip records with
    // no resolvable subject/connection (cannot build a valid sample).
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
      case 'recovery':
        pushRecovery(out, payload.data as WhoopRecovery, resolved, r.id);
        break;
      case 'cycle':
        pushCycle(out, payload.data as WhoopCycle, resolved, r.id);
        break;
      case 'sleep':
        pushSleep(out, payload.data as WhoopSleep, resolved, r.id);
        break;
      case 'workout':
        pushWorkout(out, payload.data as WhoopWorkout, resolved, r.id);
        break;
      default:
        break;
    }
  }
  return out;
}

function pushRecovery(
  out: NormalizedSample[],
  rec: WhoopRecovery,
  ctx: { userId: string; connectionId: string },
  sourceRecordId?: string,
): void {
  if (rec.score_state !== 'SCORED' || !rec.score) return;
  // Recovery is a point-in-time score with no native window; use created_at.
  const at = new Date(rec.created_at);
  if (Number.isNaN(at.getTime())) return;

  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: SR,
    startAt: at,
    endAt: at,
    sourceTz: 'UTC' as const,
    sourceRecordId: sourceRecordId ?? rec.id ?? null,
  };

  out.push({
    ...base,
    metric: WearableMetricType.RECOVERY_SCORE,
    value: rec.score.recovery_score,
    unit: UNIT.score,
  });
  out.push({
    ...base,
    metric: WearableMetricType.HRV_MS,
    value: rec.score.hrv_rmssd_milli,
    unit: UNIT.ms,
  });
  out.push({
    ...base,
    metric: WearableMetricType.RESTING_HEART_RATE_BPM,
    value: rec.score.resting_heart_rate,
    unit: UNIT.bpm,
  });
}

function pushCycle(
  out: NormalizedSample[],
  cyc: WhoopCycle,
  ctx: { userId: string; connectionId: string },
  sourceRecordId?: string,
): void {
  if (cyc.score_state !== 'SCORED' || !cyc.score) return;
  const start = new Date(cyc.start);
  if (Number.isNaN(start.getTime())) return;
  // Open (current) cycles omit `end`; for the strain sample use the start
  // instant as the end so the (start,end) window is well-formed.
  const end = cyc.end ? new Date(cyc.end) : start;
  if (Number.isNaN(end.getTime())) return;

  out.push({
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    metric: WearableMetricType.STRAIN_SCORE,
    bucket: SR,
    value: cyc.score.strain,
    unit: UNIT.score,
    startAt: start,
    endAt: end < start ? start : end,
    sourceTz: 'UTC',
    sourceRecordId: sourceRecordId ?? cyc.id ?? null,
  });
}

function pushSleep(
  out: NormalizedSample[],
  sl: WhoopSleep,
  ctx: { userId: string; connectionId: string },
  sourceRecordId?: string,
): void {
  if (sl.score_state !== 'SCORED' || !sl.score) return;
  // Naps are excluded from main sleep metrics (they are short, fragmentary,
  // and would corrupt nightly sleep aggregates).
  if (sl.nap) return;

  const start = new Date(sl.start);
  const end = new Date(sl.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;

  const stages = sl.score.stage_summary;
  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: SR,
    startAt: start,
    endAt: end < start ? start : end,
    sourceTz: 'UTC' as const,
    sourceRecordId: sourceRecordId ?? sl.id ?? null,
  };

  const minutes = (milli: number): number => milli / MS_PER_MIN;

  out.push({
    ...base,
    metric: WearableMetricType.SLEEP_TOTAL_MIN,
    value: minutes(stages.total_in_bed_time_milli),
    unit: UNIT.min,
  });
  out.push({
    ...base,
    metric: WearableMetricType.SLEEP_REM_MIN,
    value: minutes(stages.total_rem_sleep_time_milli),
    unit: UNIT.min,
  });
  out.push({
    ...base,
    metric: WearableMetricType.SLEEP_DEEP_MIN,
    value: minutes(stages.total_slow_wave_sleep_time_milli),
    unit: UNIT.min,
  });
  out.push({
    ...base,
    metric: WearableMetricType.SLEEP_LIGHT_MIN,
    value: minutes(stages.total_light_sleep_time_milli),
    unit: UNIT.min,
  });
  out.push({
    ...base,
    metric: WearableMetricType.SLEEP_AWAKE_MIN,
    value: minutes(stages.total_awake_time_milli),
    unit: UNIT.min,
  });
  out.push({
    ...base,
    metric: WearableMetricType.SLEEP_EFFICIENCY_PCT,
    value: sl.score.sleep_efficiency_percentage,
    unit: UNIT.pct,
  });
}

function pushWorkout(
  out: NormalizedSample[],
  wo: WhoopWorkout,
  ctx: { userId: string; connectionId: string },
  sourceRecordId?: string,
): void {
  const start = new Date(wo.start);
  const end = new Date(wo.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;

  const base = {
    userId: ctx.userId,
    connectionId: ctx.connectionId,
    provider: PROVIDER,
    bucket: HF,
    startAt: start,
    endAt: end < start ? start : end,
    sourceTz: 'UTC' as const,
    sourceRecordId: sourceRecordId ?? wo.id ?? null,
  };

  // WORKOUT_DURATION_MIN is always derivable from the window (end - start),
  // independent of score state.
  const durationMin = Math.max(0, (end.getTime() - start.getTime()) / MS_PER_MIN);
  out.push({
    ...base,
    metric: WearableMetricType.WORKOUT_DURATION_MIN,
    value: durationMin,
    unit: UNIT.min,
  });

  // Distance only exists on a SCORED workout with a distance_meter.
  if (
    wo.score_state === 'SCORED' &&
    wo.score &&
    typeof wo.score.distance_meter === 'number'
  ) {
    out.push({
      ...base,
      metric: WearableMetricType.WORKOUT_DISTANCE_M,
      value: wo.score.distance_meter,
      unit: UNIT.m,
    });
  }
}
