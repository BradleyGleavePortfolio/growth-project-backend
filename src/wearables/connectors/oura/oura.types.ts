/**
 * PR-HK-2.k — Oura Cloud API v2 provider-native response shapes.
 *
 * These interfaces describe the *provider-native* JSON the Oura v2 API
 * returns (https://cloud.ouraring.com/v2/docs). They are intentionally
 * partial: a connector normalizer only depends on the fields it maps into
 * the canonical {@link NormalizedSample} taxonomy (Agent 2 §3.1), and Oura's
 * "unknown fields ignored safely" posture (PR-HK-2 audit checklist) means we
 * never assert on fields we do not consume. Every numeric duration Oura emits
 * is in **seconds**; the normalizer converts to the canonical minute unit.
 *
 * NOTE on `daily_sleep`: in the live Oura v2 API the per-stage durations and
 * HRV live on the long-form `sleep` (sleep-period) documents, while
 * `daily_sleep` carries the daily *score* + contributors. AGENT_2_CODING_PLAN
 * §3.1 maps the sleep stage/HRV metrics under the logical `daily_sleep`
 * source key, so this connector models a merged "daily sleep" record shape
 * (`OuraDailySleep`) that carries both the score-level fields and the
 * stage/HRV duration fields, populated by the connector from the `sleep`
 * endpoint. This keeps the normalizer mapping identical to the documented
 * §3.1 contract without leaking Oura's two-endpoint split downstream.
 */

/** Oura paged list envelope: `{ data: T[], next_token: string | null }`. */
export interface OuraListResponse<T> {
  data: T[];
  next_token?: string | null;
}

/** Oura OAuth2 token endpoint response (`POST /oauth/token`). */
export interface OuraTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Access-token lifetime in seconds. */
  expires_in: number;
  token_type: string;
  /** Space-delimited granted scopes (provider-native). */
  scope?: string;
}

/**
 * `GET /v2/usercollection/daily_sleep` (merged with `sleep` stage fields —
 * see file header). Durations are SECONDS; `efficiency` is a percentage;
 * `average_hrv` is milliseconds.
 */
export interface OuraDailySleep {
  id: string;
  /** Calendar day the sleep is attributed to, `YYYY-MM-DD`. */
  day: string;
  /** ISO-8601 instant the daily document was generated. */
  timestamp?: string;
  /** Daily sleep score (0–100). Not mapped to a canonical metric directly. */
  score?: number | null;
  /** Total time asleep, SECONDS. */
  total_sleep_duration?: number | null;
  /** REM sleep, SECONDS. */
  rem_sleep_duration?: number | null;
  /** Deep (slow-wave) sleep, SECONDS. */
  deep_sleep_duration?: number | null;
  /** Light sleep, SECONDS. */
  light_sleep_duration?: number | null;
  /** Time awake during the sleep window, SECONDS. */
  awake_time?: number | null;
  /** Sleep efficiency, PERCENT (0–100). */
  efficiency?: number | null;
  /** Average heart-rate variability over the night, MILLISECONDS. */
  average_hrv?: number | null;
  /** ISO-8601 instant the sleep window began (UTC offset preserved). */
  bedtime_start?: string | null;
  /** ISO-8601 instant the sleep window ended. */
  bedtime_end?: string | null;
}

/** `GET /v2/usercollection/daily_readiness`. */
export interface OuraDailyReadiness {
  id: string;
  day: string;
  timestamp?: string;
  /** Readiness score (0–100). */
  score?: number | null;
  /** Body-temperature deviation from baseline, DEGREES CELSIUS. */
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
}

/** `GET /v2/usercollection/daily_activity`. */
export interface OuraDailyActivity {
  id: string;
  day: string;
  timestamp?: string;
  /** Daily step count. */
  steps?: number | null;
  /** Active energy, KILOCALORIES (not currently mapped). */
  active_calories?: number | null;
  score?: number | null;
}

/**
 * `GET /v2/usercollection/heartrate` — instantaneous HR samples. `timestamp`
 * is an ISO-8601 instant; `bpm` is beats per minute.
 */
export interface OuraHeartRate {
  /** ISO-8601 instant of the reading. */
  timestamp: string;
  /** Beats per minute. */
  bpm: number;
  /** Provider-native source label (e.g. "awake", "rest", "sleep"). */
  source?: string;
}

/** `GET /v2/usercollection/workout`. */
export interface OuraWorkout {
  id: string;
  day: string;
  /** Activity label (e.g. "running"). */
  activity?: string;
  /** ISO-8601 workout start instant. */
  start_datetime?: string | null;
  /** ISO-8601 workout end instant. */
  end_datetime?: string | null;
  /** Distance, METRES. */
  distance?: number | null;
  /** Active calories, KILOCALORIES. */
  calories?: number | null;
}

/** `GET /v2/usercollection/session` (guided/recovery sessions). */
export interface OuraSession {
  id: string;
  day: string;
  type?: string;
  start_datetime?: string | null;
  end_datetime?: string | null;
}

/**
 * `GET /v2/usercollection/daily_spo2`. `spo2_percentage` is an object with an
 * `average` field in the live API; we model both the object and a flat number
 * so the normalizer is tolerant of either shape.
 */
export interface OuraSpO2 {
  id: string;
  day: string;
  /**
   * Average SpO2 as a percentage. Oura returns this nested under
   * `{ average: number }`; older/flat payloads may carry a bare number.
   */
  spo2_percentage?: { average?: number | null } | number | null;
  breathing_disturbance_index?: number | null;
}

/**
 * Oura webhook *event* POST payload
 * (`POST <callback_url>`). One event references one changed object; the
 * connector fetches the referenced record(s) and ingests them.
 */
export interface OuraWebhookEvent {
  /** "create" | "update" | "delete". */
  event_type: string;
  /** The Oura data collection the object belongs to (e.g. "sleep"). */
  data_type: string;
  /** Provider-native id of the changed object. */
  object_id: string;
  /** ISO-8601 instant the change occurred. */
  event_time: string;
  /** Oura user id (maps to WearableConnection.external_account_id). */
  user_id: string;
}

/**
 * Headers Oura attaches to a webhook delivery, used for HMAC verification.
 * `x-oura-signature` is the UPPERCASE hex HMAC-SHA256 of
 * (`x-oura-timestamp` + the raw JSON body) keyed by the app `client_secret`.
 */
export interface OuraWebhookHeaders {
  'x-oura-signature'?: string;
  'x-oura-timestamp'?: string;
}

/** Oura collection keys the connector knows how to fetch + normalize. */
export type OuraCollection =
  | 'daily_sleep'
  | 'daily_readiness'
  | 'daily_activity'
  | 'heartrate'
  | 'sleep'
  | 'workout'
  | 'session'
  | 'daily_spo2';
