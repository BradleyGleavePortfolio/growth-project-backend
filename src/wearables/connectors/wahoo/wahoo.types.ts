/**
 * PR-HK-2.h — Wahoo Cloud API provider-native response shapes.
 *
 * These interfaces describe the *provider-native* JSON the Wahoo Cloud API
 * returns (https://cloud-api.wahooligan.com). They are intentionally partial:
 * the normalizer only depends on the fields it maps into the canonical
 * {@link NormalizedSample} taxonomy (AGENT_2_CODING_PLAN §3.1), and Wahoo's
 * "unknown fields ignored safely" posture means we never assert on fields we
 * do not consume.
 *
 * IMPORTANT — Wahoo `workout_summary` numeric fields are delivered as STRINGS
 * (e.g. `distance_accum: "24909.71"`, `heart_rate_avg: "100.00"`). The
 * normalizer `parseFloat`s them and drops anything non-finite (#42 no
 * speculative ingestion). `workout.minutes` is a JSON number.
 */

/** Scopes requested at connect time (Wahoo §3 provider row). */
export const WAHOO_SCOPES = [
  'user_read',
  'workouts_read',
  // `offline_data` is required to RECEIVE webhooks AND to obtain a refresh
  // token (offline access) — without it Wahoo will not push workout events.
  'offline_data',
] as const;

/** Wahoo OAuth2 token endpoint response (`POST /oauth/token`). */
export interface WahooTokenResponse {
  access_token: string;
  /**
   * Rotated refresh token. Wahoo ROTATES refresh tokens (like Strava): the
   * previous access + refresh tokens are revoked once the new access token is
   * used, so the returned value MUST be persisted (50-Failures #1/#12).
   */
  refresh_token?: string;
  /** Access-token lifetime in seconds (Wahoo issues 2h tokens). */
  expires_in?: number;
  token_type?: string;
  /** Space-delimited granted scopes (provider-native). */
  scope?: string;
  /**
   * Wahoo embeds the owning user id on the token response under `user`. Used
   * as the external account id for connection resolution on webhooks.
   */
  user?: { id?: number | string } | null;
}

/**
 * `workout_summary` sub-object on a Wahoo workout. Numeric fields are STRINGS.
 * Partial — only the mapped fields are typed.
 */
export interface WahooWorkoutSummary {
  id?: number | string;
  /** Total distance, METERS, as a string e.g. "24909.71". */
  distance_accum?: string | null;
  /** Average heart rate, BPM, as a string e.g. "124.23". */
  heart_rate_avg?: string | null;
  /** Active duration accumulator, SECONDS, as a string. */
  duration_active_accum?: string | null;
  /** Total duration accumulator, SECONDS, as a string. */
  duration_total_accum?: string | null;
  /** Total calories, as a string. */
  calories_accum?: string | null;
  /** Average speed, as a string. */
  speed_avg?: string | null;
  /** IANA timezone the workout was recorded in, e.g. "America/Denver". */
  time_zone?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Wahoo workout object (`GET /v1/workouts`, `GET /v1/workouts/:id`). Partial.
 */
export interface WahooWorkout {
  id: number | string;
  /** ISO-8601 UTC start instant, e.g. "2026-05-30T13:00:00.000Z". */
  starts: string;
  /** Workout duration in MINUTES (JSON number). */
  minutes?: number | null;
  name?: string | null;
  workout_token?: string | null;
  workout_type_id?: number | null;
  /** Nested summary (may be null if the workout has no summary yet). */
  workout_summary?: WahooWorkoutSummary | null;
  created_at?: string;
  updated_at?: string;
}

/** Wahoo paged list envelope for `GET /v1/workouts`. */
export interface WahooWorkoutsListResponse {
  workouts: WahooWorkout[];
  /** Total result count (Wahoo paginates with `page` + `per_page`). */
  total?: number;
  page?: number;
  per_page?: number;
  order?: string;
  sort?: string;
}

/**
 * Wahoo webhook payload (`POST` JSON, `Content-Type: application/json`).
 *
 * Wahoo's documented authenticity control is the `webhook_token` field ("any
 * request that doesn't include this token should be ignored"). The binding
 * task brief ALSO mandates an HMAC-SHA256 signature; the connector verifies
 * BOTH (see {@link WahooConnector.verifyWebhook}).
 *
 * The summary embeds the changed `workout` so the controller can normalize
 * without a second round-trip to the API.
 */
export interface WahooWebhookEvent {
  /** Provider event type, e.g. "workout_summary". */
  event_type: string;
  /** Wahoo-issued shared token echoed on every delivery. */
  webhook_token?: string;
  /** The owning Wahoo user. */
  user?: { id?: number | string } | null;
  /** The summary that changed, including the nested workout object. */
  workout_summary?: (WahooWorkoutSummary & {
    id?: number | string;
    workout?: WahooWorkout | null;
  }) | null;
}
