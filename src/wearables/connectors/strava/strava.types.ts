/**
 * PR-HK-2.f — Strava API v3 provider-native types.
 *
 * These shapes describe ONLY the Strava-native fields this connector reads.
 * They are intentionally narrow: the connector + normalizer are the only code
 * that understands Strava idiosyncrasy, and everything maps to the canonical
 * {@link NormalizedSample} boundary before it crosses into the ingestion lane
 * (Agent 2 §3.2). Anything Strava returns that is not modeled here is dropped
 * (no speculative ingestion, 50-Failures #42).
 *
 * Source-of-truth API facts (verified against Strava developer docs):
 *  - Activities: `GET https://www.strava.com/api/v3/athlete/activities`
 *    (https://developers.strava.com/docs/reference/#api-Activities)
 *  - OAuth token: `POST https://www.strava.com/oauth/token`
 *    (https://developers.strava.com/docs/authentication/)
 *  - Webhooks: `https://developers.strava.com/docs/webhooks/`
 */

/**
 * A Strava "summary activity" as returned by the athlete activities list
 * endpoint. Only the fields the normalizer consumes are typed; the real
 * payload has many more we deliberately ignore.
 *
 * Field notes:
 *  - `moving_time` / `elapsed_time` are SECONDS. The normalizer divides
 *    `moving_time` by 60 → WORKOUT_DURATION_MIN.
 *  - `distance` is METRES (float) → WORKOUT_DISTANCE_M.
 *  - `calories` is kcal but is ONLY present on the *detailed* activity
 *    (GET /activities/{id}), not on the summary list — hence optional. The
 *    normalizer emits ACTIVE_ENERGY_KCAL only when present.
 *  - `average_heartrate` (bpm) is present only when the activity has HR data
 *    and `has_heartrate` is true → HEART_RATE_BPM.
 *  - `suffer_score` is Strava's "relative effort" / training-load proxy →
 *    TRAINING_LOAD. Optional (only on HR activities). The plan also references
 *    a generic "training_load" alias; we accept either, preferring
 *    `suffer_score` (the documented field name).
 *  - `start_date` is the UTC ISO-8601 instant ("2024-01-02T07:30:00Z");
 *    `start_date_local` is the athlete's local wall-clock (no offset). The
 *    normalizer keys timestamps off `start_date` (UTC) and threads the
 *    `timezone` string through for source_tz bucketing.
 */
export interface StravaActivity {
  /** Strava-native activity id (numeric). Threaded to sourceRecordId. */
  id: number;
  /** Activity type, e.g. "Run", "Ride". Not normalized; kept for context. */
  type?: string;
  /** Moving time in SECONDS. → WORKOUT_DURATION_MIN (÷60). */
  moving_time: number;
  /** Elapsed (wall-clock) time in SECONDS. Not normalized (moving is the KPI). */
  elapsed_time?: number;
  /** Distance in METRES (float). → WORKOUT_DISTANCE_M. */
  distance: number;
  /** Energy in kcal (detailed activity only). → ACTIVE_ENERGY_KCAL. */
  calories?: number;
  /** Whether the activity carries heart-rate data. */
  has_heartrate?: boolean;
  /** Average heart rate in bpm (HR activities only). → HEART_RATE_BPM. */
  average_heartrate?: number;
  /** Max heart rate in bpm. Not normalized (we ingest the average KPI). */
  max_heartrate?: number;
  /** Strava "relative effort" / suffer score. → TRAINING_LOAD. */
  suffer_score?: number;
  /**
   * Alias some Strava payload variants use for the effort score. The
   * normalizer prefers `suffer_score`; this is a defensive fallback only.
   */
  training_load?: number;
  /** UTC ISO-8601 start instant ("...Z"). The dedup/timestamp anchor. */
  start_date: string;
  /** Local wall-clock start (no offset). Not used for the UTC instant. */
  start_date_local?: string;
  /** IANA-ish tz string from Strava (e.g. "(GMT+00:00) Europe/London"). */
  timezone?: string;
}

/**
 * Strava webhook event payload (the POST body Strava sends to the callback
 * URL when an activity/athlete object changes). Strava webhooks DO NOT carry
 * the activity payload — only an `object_id` reference the connector must
 * fetch. (https://developers.strava.com/docs/webhooks/)
 *
 *  - `aspect_type`: "create" | "update" | "delete".
 *  - `object_type`: "activity" | "athlete".
 *  - `object_id`: the activity id (when object_type=activity) or athlete id.
 *  - `owner_id`: the athlete id who owns the object.
 *  - `subscription_id`: our push-subscription id — validated against config.
 *  - `event_time`: UNIX seconds the event occurred (dedup-key segment).
 *  - `updates`: changed fields (e.g. {title}); for athlete deauthorization
 *    Strava sends {"authorized":"false"}.
 */
export interface StravaWebhookEvent {
  aspect_type: 'create' | 'update' | 'delete';
  event_time: number;
  object_id: number;
  object_type: 'activity' | 'athlete';
  owner_id: number;
  subscription_id: number;
  updates?: Record<string, string>;
}

/**
 * Strava webhook subscription-verification GET query. Strava issues a GET to
 * the callback URL on subscription creation with these `hub.*` params; the
 * callback must echo `hub.challenge` iff `hub.verify_token` matches the
 * server-configured token. (Same hub.* handshake as Meta/PubSubHubbub.)
 */
export interface StravaWebhookVerifyQuery {
  'hub.mode'?: string;
  'hub.challenge'?: string;
  'hub.verify_token'?: string;
}

/**
 * Strava OAuth token response (`POST /oauth/token`). Strava ROTATES the
 * refresh token on every refresh — `refresh_token` in the response may differ
 * from the one sent, and the connector MUST persist the new one or the next
 * refresh will fail (50-Failures #1/#12 token handling).
 * `expires_at` is an absolute UNIX-seconds expiry; `expires_in` is its
 * relative complement.
 */
export interface StravaTokenResponse {
  token_type?: string;
  access_token: string;
  refresh_token: string;
  /** Absolute access-token expiry, UNIX seconds. */
  expires_at: number;
  /** Relative access-token lifetime, seconds. */
  expires_in?: number;
  /** Athlete summary on the initial code exchange (carries the athlete id). */
  athlete?: { id?: number };
}

/** Strava OAuth scopes this connector requests (H&F activity history). */
export const STRAVA_SCOPES = ['activity:read_all', 'profile:read_all'] as const;
