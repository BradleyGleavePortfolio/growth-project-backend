/**
 * PR-HK-2.l — WHOOP API v2 provider-native types.
 *
 * These describe the *exact* shapes the connector receives from the WHOOP v2
 * API (`https://api.prod.whoop.com/developer/v2/...`) and the v2 webhook
 * delivery. They are intentionally scoped to the fields the normalizer maps
 * (AGENT_2_CODING_PLAN §3.1) plus the structural fields needed for paging,
 * dedup, and webhook verification — nothing speculative (50-Failures #42).
 *
 * WHOOP v2 distinctives baked in here:
 *  - record `id`s are **UUID strings** (v1 used integers). Every record type
 *    below carries a `id: string` UUID.
 *  - timestamps are ISO-8601 UTC strings (`created_at`, `updated_at`,
 *    `start`, `end`).
 *  - sleep stage durations are reported in **milliseconds**
 *    (`*_milli`) — the normalizer converts them to minutes.
 *  - the OAuth `offline` scope yields a refresh token that WHOOP **rotates**
 *    on every refresh.
 *
 * Source (verified May 2026): WHOOP API v2 docs
 *   https://developer.whoop.com/api/  (UUID ids, offline scope, v2 webhooks).
 */

import { z } from 'zod';

/**
 * Common scoring envelope on WHOOP v2 records. `score_state` is `SCORED`
 * once WHOOP has finished computing the record; `PENDING_SCORE` /
 * `UNSCORABLE` records have a null/absent `score` and the normalizer skips
 * them (no half-baked samples cross the ingestion boundary).
 */
export type WhoopScoreState = 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';

/** WHOOP recovery record (`GET /developer/v2/recovery`). */
export interface WhoopRecovery {
  /** UUID — provider-native record id (v2). */
  id: string;
  /** UUID of the cycle this recovery belongs to. */
  cycle_id?: string;
  /** UUID of the sleep this recovery is computed from. */
  sleep_id?: string;
  /** WHOOP user id (numeric in WHOOP, threaded into the dedup key as text). */
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: WhoopScoreState;
  score?: {
    /** 0–100 recovery percentage → RECOVERY_SCORE. */
    recovery_score: number;
    /** Resting HR in bpm → RESTING_HEART_RATE_BPM. */
    resting_heart_rate: number;
    /** HRV (RMSSD) in **milliseconds** → HRV_MS. */
    hrv_rmssd_milli: number;
    user_calibrating?: boolean;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  } | null;
}

/** WHOOP physiological cycle record (`GET /developer/v2/cycle`). */
export interface WhoopCycle {
  /** UUID — provider-native record id (v2). */
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  /** Cycle window start (ISO-8601 UTC). */
  start: string;
  /** Cycle window end (ISO-8601 UTC). Open (current) cycles omit this. */
  end?: string | null;
  timezone_offset?: string;
  score_state: WhoopScoreState;
  score?: {
    /** Day strain 0–21 → STRAIN_SCORE. */
    strain: number;
    kilojoule?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
  } | null;
}

/** WHOOP sleep record (`GET /developer/v2/activity/sleep`). */
export interface WhoopSleep {
  /** UUID — provider-native record id (v2). */
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  /** Sleep window start (ISO-8601 UTC). */
  start: string;
  /** Sleep window end (ISO-8601 UTC). */
  end: string;
  timezone_offset?: string;
  /** A nap is excluded from main-sleep metrics by the normalizer. */
  nap?: boolean;
  score_state: WhoopScoreState;
  score?: {
    stage_summary: {
      /** Total time in bed, **milliseconds** → SLEEP_TOTAL_MIN. */
      total_in_bed_time_milli: number;
      /** Awake time in bed, **milliseconds** → SLEEP_AWAKE_MIN. */
      total_awake_time_milli: number;
      total_no_data_time_milli?: number;
      /** Light sleep, **milliseconds** → SLEEP_LIGHT_MIN. */
      total_light_sleep_time_milli: number;
      /** Slow-wave (deep) sleep, **milliseconds** → SLEEP_DEEP_MIN. */
      total_slow_wave_sleep_time_milli: number;
      /** REM sleep, **milliseconds** → SLEEP_REM_MIN. */
      total_rem_sleep_time_milli: number;
      sleep_cycle_count?: number;
      disturbance_count?: number;
    };
    /** 0–100 efficiency percentage → SLEEP_EFFICIENCY_PCT. */
    sleep_efficiency_percentage: number;
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
  } | null;
}

/** WHOOP workout record (`GET /developer/v2/activity/workout`). */
export interface WhoopWorkout {
  /** UUID — provider-native record id (v2). */
  id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  /** Workout window start (ISO-8601 UTC) → duration + WORKOUT timestamps. */
  start: string;
  /** Workout window end (ISO-8601 UTC). */
  end: string;
  timezone_offset?: string;
  /** WHOOP v2 sport identifier (UUID). */
  sport_id?: string;
  score_state: WhoopScoreState;
  score?: {
    strain?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
    kilojoule?: number;
    /** Distance in meters → WORKOUT_DISTANCE_M. */
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
  } | null;
}

/** WHOOP user profile (`GET /developer/v2/user/profile/basic`). */
export interface WhoopProfile {
  /** WHOOP user id. */
  user_id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
}

/** WHOOP body measurement (`GET /developer/v2/user/measurement/body`). */
export interface WhoopBodyMeasurement {
  /**
   * UUID — WHOOP v2 assigns a measurement id. (v1 had none.) Optional
   * because the basic body-measurement endpoint may omit it.
   */
  id?: string;
  height_meter?: number;
  weight_kilogram?: number;
  max_heart_rate?: number;
}

/**
 * A WHOOP v2 paginated collection envelope. `records` holds the page;
 * `next_token` (when present and non-empty) is passed back as the
 * `nextToken` query param to fetch the following page.
 */
export interface WhoopPaginatedResponse<T> {
  records: T[];
  next_token?: string | null;
}

/**
 * The discriminator for which WHOOP collection a {@link WhoopRawPayload}
 * holds. Threaded onto the RawRecord payload so the normalizer can route a
 * record to the right mapper without re-sniffing its shape.
 */
export type WhoopRecordKind = 'recovery' | 'cycle' | 'sleep' | 'workout';

/**
 * The envelope the connector wraps every backfilled/webhook-fetched record
 * in before handing it to `normalize()`. `kind` selects the mapper; `data`
 * is the untouched provider record.
 */
export interface WhoopRawPayload {
  kind: WhoopRecordKind;
  data: WhoopRecovery | WhoopCycle | WhoopSleep | WhoopWorkout;
  /**
   * Subject-client + connection ids, threaded onto the payload by the
   * connector so `normalize(raw)` (which the {@link WearableConnector}
   * interface calls with NO extra context) can build {@link NormalizedSample}s
   * without re-resolving the connection. Set by `backfill()` /
   * webhook-fetch; the normalizer reads them and falls back to the optional
   * `ctx` argument when absent.
   */
  userId?: string;
  connectionId?: string;
}

/**
 * WHOOP v2 webhook event types we act on. WHOOP delivers a small JSON body
 * (NOT the full record) and signs it; the controller verifies the signature,
 * dedups on the event `id`, then (for data events) the connector fetches the
 * referenced record by id. `*.deleted` and the user de-authorization event
 * drive revocation / tombstoning.
 *
 * Source: WHOOP v2 webhook spec (UUID event ids; revoke stops delivery).
 */
export type WhoopWebhookType =
  | 'recovery.updated'
  | 'recovery.deleted'
  | 'cycle.updated'
  | 'cycle.deleted'
  | 'sleep.updated'
  | 'sleep.deleted'
  | 'workout.updated'
  | 'workout.deleted'
  | 'user.updated'
  | 'user.deauthorized';

/**
 * WHOOP v2 webhook payload. WHOOP posts a lean event referencing a record by
 * its UUID `id` plus the `user_id`; the webhook is signed with
 * `X-WHOOP-Signature` (base64 HMAC-SHA256 of `timestamp + rawBody`) and the
 * `X-WHOOP-Signature-Timestamp` header.
 */
export interface WhoopWebhookPayload {
  /** WHOOP user id the event pertains to. */
  user_id: number;
  /** UUID of the referenced record (v2). Also the dedup event id segment. */
  id: string;
  /** Event type, e.g. "recovery.updated" / "user.deauthorized". */
  type: WhoopWebhookType;
  /** WHOOP trace id for cross-system correlation (best-effort). */
  trace_id?: string;
}

/** All WHOOP v2 webhook event types we accept (drives the Zod enum below). */
export const WHOOP_WEBHOOK_TYPES = [
  'recovery.updated',
  'recovery.deleted',
  'cycle.updated',
  'cycle.deleted',
  'sleep.updated',
  'sleep.deleted',
  'workout.updated',
  'workout.deleted',
  'user.updated',
  'user.deauthorized',
] as const satisfies readonly WhoopWebhookType[];

/**
 * Runtime validation schema for an inbound (already HMAC-verified) WHOOP v2
 * webhook event. The controller parses the verified body through this BEFORE
 * any dedup / revocation / logging so a correctly-signed-but-malformed event
 * (bad UUID, unknown type, non-positive user_id, extra fields) is rejected
 * with a 400 rather than flowing into business logic (R1 Finding 2 — HIGH).
 *
 *  - `id`       — must be a UUID (the v2 event id + dedup key segment).
 *  - `type`     — must be one of the known WHOOP v2 event types.
 *  - `user_id`  — must be a positive integer (WHOOP account id).
 *  - `trace_id` — optional correlation id.
 *
 * `.strict()` rejects unknown keys so a drifted/forged payload cannot smuggle
 * extra fields past validation (50-Failures #42 — no speculative fields).
 */
export const WhoopWebhookEventSchema = z
  .object({
    id: z.guid(),
    type: z.enum(WHOOP_WEBHOOK_TYPES),
    user_id: z.number().int().positive(),
    trace_id: z.string().optional(),
  })
  .strict();

/** The validated, parsed webhook event (mirrors {@link WhoopWebhookPayload}). */
export type WhoopWebhookEvent = z.infer<typeof WhoopWebhookEventSchema>;

/** Lower-cased WHOOP webhook header names (Stripe-pattern raw-body HMAC). */
export const WHOOP_SIGNATURE_HEADER = 'x-whoop-signature';
export const WHOOP_SIGNATURE_TIMESTAMP_HEADER = 'x-whoop-signature-timestamp';
