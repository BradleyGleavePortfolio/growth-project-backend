/**
 * PR-HK-2.e — Fitbit Web API provider-native response shapes.
 *
 * These interfaces describe the *provider-native* JSON the Fitbit Web API
 * (https://dev.fitbit.com/build/reference/web-api/) returns. They are
 * intentionally partial: a connector normalizer only depends on the fields it
 * maps into the canonical {@link NormalizedSample} taxonomy (AGENT_2_CODING_PLAN
 * §3.1), and Fitbit's "unknown fields ignored safely" posture (PR-HK-2 audit
 * checklist) means we never assert on fields we do not consume.
 *
 * Units: Fitbit step counts are integers; resting heart rate is bpm; sleep
 * stage minutes are MINUTES already (no seconds→min conversion needed, unlike
 * Oura); body weight is reported in the account's locale unit (kg or lb) so
 * the connector requests the metric (`Accept-Language: en_GB`) to force KG;
 * breathing rate is breaths/min; SpO2 is a percentage.
 */

/** Fitbit OAuth2 token endpoint response (`POST /oauth2/token`). */
export interface FitbitTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Access-token lifetime in seconds (Fitbit default 28800 = 8h). */
  expires_in?: number;
  token_type?: string;
  /** Space-delimited granted scopes (provider-native). */
  scope?: string;
  /** Fitbit encoded user id (maps to WearableConnection.external_account_id). */
  user_id?: string;
}

/**
 * `GET /1/user/-/activities/steps/date/<start>/<end>.json` — the time-series
 * envelope. `activities-steps` is an array of `{ dateTime, value }` where
 * `value` is the day's step count as a STRING (Fitbit serialises numeric
 * time-series values as strings).
 */
export interface FitbitStepsTimeSeries {
  'activities-steps'?: Array<{ dateTime: string; value: string }>;
}

/**
 * `GET /1/user/-/activities/heart/date/<start>/<end>.json` — the heart-rate
 * time series. Each `activities-heart` entry carries a `value.restingHeartRate`
 * (bpm) for the day when available.
 */
export interface FitbitHeartTimeSeries {
  'activities-heart'?: Array<{
    dateTime: string;
    value: {
      restingHeartRate?: number | null;
      /** HR zones present but not mapped to a canonical metric. */
      heartRateZones?: unknown;
    };
  }>;
}

/**
 * `GET /1/user/-/sleep/date/<start>/<end>.json` (Sleep API v1.2). `sleep` is
 * an array of sleep logs; each log carries `duration` (ms), `efficiency`
 * (percent), `startTime`/`endTime` (ISO local), `isMainSleep`, and a
 * `levels.summary` object with per-stage MINUTE totals. Fitbit's stage model is
 * `{ deep, light, rem, wake }`; classic logs use `{ asleep, restless, awake }`.
 */
export interface FitbitSleepStageSummaryEntry {
  /** Total minutes in this stage. */
  minutes?: number | null;
  count?: number | null;
}

export interface FitbitSleepLevelsSummary {
  deep?: FitbitSleepStageSummaryEntry | null;
  light?: FitbitSleepStageSummaryEntry | null;
  rem?: FitbitSleepStageSummaryEntry | null;
  wake?: FitbitSleepStageSummaryEntry | null;
  /** Classic (non-stages) device summary. */
  asleep?: FitbitSleepStageSummaryEntry | null;
  restless?: FitbitSleepStageSummaryEntry | null;
  awake?: FitbitSleepStageSummaryEntry | null;
}

export interface FitbitSleepLog {
  logId?: number | string | null;
  dateOfSleep?: string | null;
  /** ISO-8601 local start (no offset, Fitbit reports in the device tz). */
  startTime?: string | null;
  endTime?: string | null;
  /** Total sleep-period duration, MILLISECONDS. */
  duration?: number | null;
  /** Total minutes actually asleep. */
  minutesAsleep?: number | null;
  /** Total minutes awake during the period. */
  minutesAwake?: number | null;
  /** Sleep efficiency, PERCENT (0–100). */
  efficiency?: number | null;
  /** "stages" (modern) | "classic". */
  type?: string | null;
  isMainSleep?: boolean | null;
  levels?: { summary?: FitbitSleepLevelsSummary | null } | null;
}

export interface FitbitSleepResponse {
  sleep?: FitbitSleepLog[];
}

/**
 * `GET /1/user/-/body/log/weight/date/<start>/<end>.json`. `weight` is an
 * array of log entries; `weight` is in the requested unit (we force KG via
 * `Accept-Language: en_GB`), `date`/`time` localise the reading, `logId`
 * identifies the record.
 */
export interface FitbitWeightLog {
  logId?: number | string | null;
  date?: string | null;
  time?: string | null;
  /** Body weight in KG (forced via Accept-Language). */
  weight?: number | null;
  bmi?: number | null;
  /** Provider-native source ("API" | "Aria" | …). */
  source?: string | null;
}

export interface FitbitWeightResponse {
  weight?: FitbitWeightLog[];
}

/**
 * `GET /1/user/-/br/date/<start>/<end>.json` (Breathing Rate). `br` is an
 * array of daily summaries; `value.breathingRate` is breaths per minute.
 */
export interface FitbitBreathingRateEntry {
  dateTime?: string | null;
  value?: { breathingRate?: number | null } | null;
}

export interface FitbitBreathingRateResponse {
  br?: FitbitBreathingRateEntry[];
}

/**
 * `GET /1/user/-/spo2/date/<start>/<end>.json` (SpO2 summary). Returns an
 * array of daily `{ dateTime, value: { avg, min, max } }`; we map `avg`.
 */
export interface FitbitSpo2Entry {
  dateTime?: string | null;
  value?: { avg?: number | null; min?: number | null; max?: number | null } | null;
}

/** SpO2 summary is returned as an array; tolerate a single object too. */
export type FitbitSpo2Response = FitbitSpo2Entry[] | FitbitSpo2Entry;

/**
 * Fitbit subscription notification element. Fitbit POSTs a JSON ARRAY of these
 * to the configured subscriber endpoint when a user's data of a given
 * `collectionType` changes (https://dev.fitbit.com/build/reference/web-api/developer-guide/using-subscriptions/).
 * The notification carries NO data — only a reference to fetch.
 */
export interface FitbitNotification {
  /** "activities" | "heart" | "sleep" | "body" | "br" | "spo2" | "userRevokedAccess". */
  collectionType: string;
  /** Affected calendar day, `YYYY-MM-DD` (absent for userRevokedAccess). */
  date?: string;
  /** Fitbit encoded user id (maps to WearableConnection.external_account_id). */
  ownerId: string;
  /** "user". */
  ownerType: string;
  /** The subscription id WE assigned at subscribe time. */
  subscriptionId: string;
}

/** Fitbit collection keys the connector knows how to fetch + normalize. */
export type FitbitCollection =
  | 'activities/steps'
  | 'activities/heart'
  | 'sleep'
  | 'body/weight'
  | 'br'
  | 'spo2';

/** Scopes requested at connect time (AGENT_2_CODING_PLAN §3 Fitbit row). */
export const FITBIT_SCOPES = [
  'activity',
  'heartrate',
  'sleep',
  'weight',
  'respiratory_rate',
  'oxygen_saturation',
] as const;
