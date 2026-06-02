/**
 * PR-HK-2.d — Garmin Health API provider-native types.
 *
 * These describe the *exact* shapes the connector receives from the Garmin
 * Health API push ("ping/push") notifications and backfill responses. They
 * are scoped to the fields the normalizer maps (AGENT_2_CODING_PLAN §3.1)
 * plus the structural fields needed for paging, dedup, idempotency, and
 * webhook handling — nothing speculative (50-Failures #42).
 *
 * Garmin distinctives baked in here:
 *  - Auth is the Garmin **partner** OAuth model. The legacy Health API used
 *    OAuth1.0a; the modern Health API uses OAuth2 (PKCE). The push-notification
 *    delivery is a Garmin-signed partner callback ("partner_signed") — Garmin
 *    POSTs the *actual summary payload* (NOT a lean reference like WHOOP) to a
 *    pre-registered HTTPS callback URL. The callback URL is registered with a
 *    partner-configured push verification token; there is NO per-event HMAC
 *    signature header in the Garmin Health push spec, so the controller defends
 *    the POST fail-closed via a configured push token + optional IP allow-list
 *    (the Strava-style model, since both lack per-event HMAC).
 *  - Timestamps are **epoch seconds** (`startTimeInSeconds`,
 *    `startTimeOffsetInSeconds`, `calendarDate`). The normalizer converts to UTC
 *    `Date`s and threads the offset into `sourceTz` so DST/travel cannot
 *    off-by-one the day bucket.
 *  - Durations are **seconds** (`durationInSeconds`, `deepSleepDurationInSeconds`,
 *    …); the normalizer converts to minutes. Distance is **meters**.
 *  - Each summary carries a `summaryId` (provider-native record id, dedup +
 *    event-id segment) and a `userAccessToken` / `userId` (the Garmin user
 *    access token / Garmin user id — PII, never logged).
 *
 * Source (verified May 2026): Garmin Health API — Summary Push Service,
 *   https://developer.garmin.com/gc-developer-program/health-api/  (dailies,
 *   sleeps, hrv, activities, bodyComps summaries; epoch-second timestamps;
 *   partner push callbacks).
 */

import { z } from 'zod';

/** The Garmin summary collections this connector ingests (§3.1 Garmin row). */
export type GarminSummaryKind =
  | 'dailies'
  | 'sleeps'
  | 'hrv'
  | 'activities'
  | 'bodyComps';

/** All summary kinds, drives the Zod webhook envelope keys. */
export const GARMIN_SUMMARY_KINDS = [
  'dailies',
  'sleeps',
  'hrv',
  'activities',
  'bodyComps',
] as const satisfies readonly GarminSummaryKind[];

/**
 * Fields common to every Garmin summary record. `summaryId` is the
 * provider-native record id (dedup + idempotency segment); `userId` is the
 * Garmin user id (the connection's `external_account_id`); `userAccessToken`
 * is the OAuth user access token Garmin echoes on the push (PII — never
 * logged). `startTimeInSeconds` + `startTimeOffsetInSeconds` give the local
 * window start; `durationInSeconds` the span.
 */
export interface GarminSummaryBase {
  /** Provider-native summary id (dedup + event-id segment). */
  summaryId: string;
  /** Garmin user id — the connection external_account_id (PII). */
  userId: string;
  /** Garmin OAuth user access token echoed on the push (PII — never logged). */
  userAccessToken?: string;
  /** Window start, epoch SECONDS (UTC). */
  startTimeInSeconds?: number;
  /** Local-time offset from UTC, seconds (threaded into sourceTz). */
  startTimeOffsetInSeconds?: number;
  /** Window duration, seconds. */
  durationInSeconds?: number;
  /** Calendar date (YYYY-MM-DD) for day-bucketed summaries (dailies). */
  calendarDate?: string;
}

/**
 * Garmin Daily Summary (`dailies`). H&F. Maps `steps` → STEPS and
 * `activeKilocalories` → ACTIVE_ENERGY_KCAL.
 */
export interface GarminDaily extends GarminSummaryBase {
  /** Step count for the day → STEPS. */
  steps?: number;
  /** Active calories (kcal) for the day → ACTIVE_ENERGY_KCAL. */
  activeKilocalories?: number;
}

/**
 * Garmin Sleep Summary (`sleeps`). S&R. Stage durations are SECONDS; total is
 * the sum of the stage durations Garmin reports. `bodyBattery*` feeds
 * BODY_BATTERY.
 */
export interface GarminSleep extends GarminSummaryBase {
  /** Deep sleep, seconds → SLEEP_DEEP_MIN. */
  deepSleepDurationInSeconds?: number;
  /** Light sleep, seconds → SLEEP_LIGHT_MIN. */
  lightSleepDurationInSeconds?: number;
  /** REM sleep, seconds → SLEEP_REM_MIN. */
  remSleepInSeconds?: number;
  /** Awake time, seconds → SLEEP_AWAKE_MIN. */
  awakeDurationInSeconds?: number;
  /**
   * Validation flag. Garmin marks auto-detected vs manually-confirmed sleep;
   * only `ENHANCED_CONFIRMED` / `ENHANCED_TENTATIVE` carry stage data worth
   * ingesting. `MANUAL` / unset is skipped by the normalizer.
   */
  validation?: string;
  /**
   * Overnight Body Battery change. Garmin reports the dynamic min/max across
   * the sleep; we surface the most-recent value (`bodyBatteryChange` when
   * present, else `endingBodyBattery`) → BODY_BATTERY.
   */
  endingBodyBattery?: number;
  bodyBatteryChange?: number;
}

/**
 * Garmin HRV Summary (`hrv`). S&R. `lastNightAvg` is the overnight average
 * HRV in **milliseconds** → HRV_MS.
 */
export interface GarminHrv extends GarminSummaryBase {
  /** Overnight average HRV (ms) → HRV_MS. */
  lastNightAvg?: number;
  /** Highest 5-min HRV value overnight (ms); not ingested, kept for context. */
  lastNight5MinHigh?: number;
}

/**
 * Garmin Activity Summary (`activities`). H&F. `durationInSeconds` →
 * WORKOUT_DURATION_MIN, `distanceInMeters` → WORKOUT_DISTANCE_M, and Garmin's
 * `activityTrainingLoad` → TRAINING_LOAD.
 */
export interface GarminActivity extends GarminSummaryBase {
  /** Activity type label (e.g. "RUNNING"); kept for context, not ingested. */
  activityType?: string;
  /** Distance in meters → WORKOUT_DISTANCE_M. */
  distanceInMeters?: number;
  /** Garmin training-load score for the activity → TRAINING_LOAD. */
  activityTrainingLoad?: number;
}

/**
 * Garmin Body Composition Summary (`bodyComps`). H&F. `weightInGrams` →
 * BODY_WEIGHT_KG (converted), `bodyFatInPercent` → BODY_FAT_PCT.
 */
export interface GarminBodyComp extends GarminSummaryBase {
  /** Body mass in GRAMS → BODY_WEIGHT_KG (÷ 1000). */
  weightInGrams?: number;
  /** Body fat percentage → BODY_FAT_PCT. */
  bodyFatInPercent?: number;
}

/** Union of all Garmin summary record shapes. */
export type GarminSummary =
  | GarminDaily
  | GarminSleep
  | GarminHrv
  | GarminActivity
  | GarminBodyComp;

/**
 * The envelope the connector wraps every backfilled/pushed record in before
 * handing it to `normalize()`. `kind` selects the mapper; `data` is the
 * untouched Garmin record. `userId`/`connectionId` are the SUBJECT-client +
 * connection ids (threaded by the connector / webhook controller so
 * `normalize(raw)` can build samples without re-resolving the connection).
 */
export interface GarminRawPayload {
  kind: GarminSummaryKind;
  data: GarminSummary;
  /** Subject-client User.id (threaded by connector/controller). */
  userId?: string;
  /** Connection id (threaded by connector/controller). */
  connectionId?: string;
}

/**
 * Garmin OAuth token endpoint response (Health API OAuth2/PKCE flow). The
 * connector also supports the legacy OAuth1.0a partner flow, but the canonical
 * {@link TokenSet} mapping reads the OAuth2 fields.
 */
export interface GarminTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  /** Garmin user id (echoed on some token responses). */
  user_id?: string;
}

// ── Webhook (push) validation ───────────────────────────────────────────────

/**
 * Garmin push summary records arrive as arrays keyed by collection. We
 * validate each record with a permissive-but-strict-on-known-keys schema:
 * the record MUST carry a `summaryId` + `userId`; numeric Garmin fields are
 * optional numbers. `.passthrough()` is deliberately NOT used at the RECORD
 * level — Garmin evolves summary fields, but the ENVELOPE is `.strict()` so a
 * drifted top-level key (a forged extra collection) is rejected.
 *
 * NOTE on `.strict()` (Wave-2 audit pattern #4): the foundational guard is on
 * the ENVELOPE — only the five known summary collections may appear. Record
 * objects allow unknown keys (Garmin adds fields over time) but unknown
 * TOP-LEVEL collections are rejected so a malformed/forged push cannot smuggle
 * an unexpected collection past validation.
 */
const GarminSummaryRecordSchema = z
  .object({
    summaryId: z.string().min(1),
    userId: z.string().min(1),
    userAccessToken: z.string().optional(),
    startTimeInSeconds: z.number().int().optional(),
    startTimeOffsetInSeconds: z.number().int().optional(),
    durationInSeconds: z.number().int().nonnegative().optional(),
    calendarDate: z.string().optional(),
  })
  .passthrough();

/**
 * The Garmin push envelope. Garmin POSTs `{ "<kind>": [ {…record…}, … ] }`,
 * possibly with several collections in one push. EVERY top-level key must be
 * one of the five known summary kinds (`.strict()` rejects unknown keys —
 * audit pattern #4) and each maps to an array of summary records.
 */
export const GarminWebhookEnvelopeSchema = z
  .object({
    dailies: z.array(GarminSummaryRecordSchema).optional(),
    sleeps: z.array(GarminSummaryRecordSchema).optional(),
    hrv: z.array(GarminSummaryRecordSchema).optional(),
    activities: z.array(GarminSummaryRecordSchema).optional(),
    bodyComps: z.array(GarminSummaryRecordSchema).optional(),
  })
  .strict();

/** The validated push envelope. */
export type GarminWebhookEnvelope = z.infer<typeof GarminWebhookEnvelopeSchema>;

/**
 * Garmin de-registration ("user permission revoked") notification. Garmin
 * delivers deregistrations to a separate callback as
 * `{ "deregistrations": [ { userId, userAccessToken } ] }`. We model it so the
 * controller can flip the connection to `status='disconnected'`.
 */
export const GarminDeregistrationSchema = z
  .object({
    deregistrations: z
      .array(
        z
          .object({
            userId: z.string().min(1),
            userAccessToken: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .strict();

export type GarminDeregistration = z.infer<typeof GarminDeregistrationSchema>;

/**
 * Lower-cased Garmin push header carrying the partner-configured verification
 * token. Garmin allows partners to set a static header on push delivery so the
 * receiver can fail-closed reject pushes that do not carry the expected token
 * (the connector's primary POST defense, since Garmin Health push has no
 * per-event HMAC).
 */
export const GARMIN_PUSH_TOKEN_HEADER = 'x-garmin-push-token';
