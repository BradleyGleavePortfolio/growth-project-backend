/**
 * PR-HK-2.g — Polar AccessLink API v3 provider-native response shapes.
 *
 * These interfaces describe the *provider-native* JSON the Polar AccessLink
 * v3 API returns (https://www.polar.com/accesslink-api/). They are
 * intentionally partial: a connector normalizer only depends on the fields it
 * maps into the canonical {@link NormalizedSample} taxonomy
 * (AGENT_2_CODING_PLAN §3.1), and unknown fields are ignored safely
 * (PR-HK-2 audit checklist).
 *
 * Unit notes (verified against the AccessLink v3 docs, May 2026):
 *  - Exercise `duration` is an ISO-8601 duration string (e.g. "PT2H44M45S").
 *  - Exercise `distance` is METRES; `heart-rate.average` is BPM.
 *  - Sleep stage fields (`light_sleep`, `deep_sleep`, `rem_sleep`,
 *    `total_interruption_duration`) are SECONDS.
 *  - Nightly Recharge `heart_rate_variability_avg` is MILLISECONDS;
 *    `nightly_recharge_status` is an integer status on a 1–6 scale.
 *
 * Polar exercise field names use HYPHENS (`start-time`, `heart-rate`); the
 * sleep + nightly-recharge resources use UNDERSCORES. The type definitions
 * mirror the wire shape exactly so the normalizer reads the documented keys.
 */

/** Polar OAuth2 token endpoint response (`POST /v2/oauth2/token`). */
export interface PolarTokenResponse {
  access_token: string;
  /**
   * Polar AccessLink access tokens are long-lived and the token endpoint does
   * NOT return a refresh token (the access token itself is the durable
   * credential). Modelled optional so the connector can fall back to the
   * access token when no refresh token is present.
   */
  refresh_token?: string;
  /** Access-token lifetime in seconds (Polar returns a large value). */
  expires_in?: number;
  token_type: string;
  /** Polar-native numeric user id granted with the token. */
  x_user_id?: number;
}

/** Polar `heart-rate` statistics sub-object on an exercise. */
export interface PolarHeartRate {
  /** Average heart rate over the training session, BPM. */
  average?: number | null;
  /** Maximum heart rate over the training session, BPM. */
  maximum?: number | null;
}

/**
 * `GET /v3/exercises/{id}` — a single training session. Durations are
 * ISO-8601 strings; distance is METRES; `heart-rate.average` is BPM.
 */
export interface PolarExercise {
  /** Provider-native training-session id. */
  id: number | string;
  /** Start time in LOCAL time (no offset), e.g. "2008-10-13T10:40:02". */
  'start-time'?: string | null;
  /** Offset from UTC in MINUTES at session start. */
  'start-time-utc-offset'?: number | null;
  /** ISO-8601 duration string, e.g. "PT2H44M45S". */
  duration?: string | null;
  /** Distance travelled, METRES. */
  distance?: number | null;
  /** Heart-rate statistics. */
  'heart-rate'?: PolarHeartRate | null;
  /** Expended calories, KILOCALORIES (not currently mapped). */
  calories?: number | null;
  /** Sport label (not currently mapped). */
  sport?: string | null;
}

/**
 * `GET /v3/users/sleep/{date}` — a single night's sleep result. Stage
 * durations are SECONDS. Polar exposes no `efficiency` field, and the
 * AGENT_2_CODING_PLAN §3.1 Polar binding limits sleep to minute-based stage
 * metrics, so no derived efficiency metric is emitted.
 */
export interface PolarSleep {
  /** Result date of the sleep, `YYYY-MM-DD`. */
  date: string;
  /** ISO-8601 datetime the sleep window began (offset preserved). */
  sleep_start_time?: string | null;
  /** ISO-8601 datetime the sleep window ended (offset preserved). */
  sleep_end_time?: string | null;
  /** Light sleep (N1+N2), SECONDS. */
  light_sleep?: number | null;
  /** Deep sleep (N3), SECONDS. */
  deep_sleep?: number | null;
  /** REM sleep, SECONDS. */
  rem_sleep?: number | null;
  /** Unrecognised sleep stage, SECONDS (not mapped). */
  unrecognized_sleep_stage?: number | null;
  /** Total time awake between falling asleep and waking, SECONDS. */
  total_interruption_duration?: number | null;
  /** Sleep score (1–100) — not mapped to a canonical metric directly. */
  sleep_score?: number | null;
}

/**
 * `GET /v3/users/nightly-recharge/{date}` — a single night's recovery result.
 * `heart_rate_variability_avg` is MILLISECONDS; `nightly_recharge_status` is
 * an integer status (1–6).
 */
export interface PolarNightlyRecharge {
  /** Result date of the Nightly Recharge, `YYYY-MM-DD`. */
  date: string;
  /** Average HRV over the 4-hour recharge window, MILLISECONDS. */
  heart_rate_variability_avg?: number | null;
  /** Average heart rate over the recharge window, BPM (not mapped). */
  heart_rate_avg?: number | null;
  /** Nightly Recharge status on a 1–6 scale → RECOVERY_SCORE. */
  nightly_recharge_status?: number | null;
}

/**
 * The exhaustive set of Polar AccessLink webhook event types this connector
 * supports. Any payload whose `event` is not in this set is provider drift and
 * MUST be rejected at the validation boundary (fail-closed) rather than
 * silently acknowledged. `PING` is a liveness check; the remaining three map
 * 1:1 to the §3.1-bound resources (`exercises`, `sleep`, `nightly-recharge`).
 */
export const POLAR_WEBHOOK_EVENTS = [
  'PING',
  'EXERCISE',
  'SLEEP',
  'NIGHTLY_RECHARGE',
] as const;

/** A supported Polar webhook event type (see {@link POLAR_WEBHOOK_EVENTS}). */
export type PolarWebhookEventType = (typeof POLAR_WEBHOOK_EVENTS)[number];

/**
 * Polar webhook event POST payload. Polar pushes one event per changed
 * entity and includes the absolute `url` to fetch the changed resource, so
 * the connector never reconstructs an endpoint by hand.
 *
 * A `PING` event (subscription liveness check) carries only `event` +
 * `timestamp` and is acknowledged without any fetch.
 */
export interface PolarWebhookEvent {
  /** One of the supported {@link POLAR_WEBHOOK_EVENTS}. */
  event: PolarWebhookEventType;
  /** Polar-native numeric user id (maps to external_account_id as a string). */
  user_id?: number;
  /** Entity id for resource events that carry one (e.g. EXERCISE). */
  entity_id?: string;
  /** Result date for date-keyed resources (SLEEP, nightly recharge, …). */
  date?: string;
  /** ISO-8601 instant the change occurred. */
  timestamp: string;
  /** Absolute URL of the changed resource to fetch. */
  url?: string;
}

/** Polar resource keys the connector knows how to fetch + normalize. */
export type PolarResource = 'exercises' | 'sleep' | 'nightly-recharge';
