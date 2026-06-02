/**
 * PR-HK-2.i — Withings API provider-native response shapes.
 *
 * These interfaces describe the *provider-native* JSON the Withings public API
 * returns (https://developer.withings.com/api-reference). They are intentionally
 * partial: the normalizer only depends on the fields it maps into the canonical
 * {@link NormalizedSample} taxonomy (AGENT_2_CODING_PLAN §3.1). Unknown fields
 * are ignored safely (PR-HK-2 audit checklist) — we never assert on fields we do
 * not consume.
 *
 * Withings wraps EVERY response in `{ status, body }` where `status === 0` means
 * success and any non-zero is an application-level error (the HTTP status can be
 * 200 even on an application error). The connector inspects `status` and treats
 * a non-zero as a hard failure (#36 fail-loud).
 *
 * Endpoints (verified against https://developer.withings.com, May 2026):
 *  - authorize  https://account.withings.com/oauth2_user/authorize2
 *  - token      https://wbsapi.withings.net/v2/oauth2        (action=requesttoken / action=refresh_token)
 *  - measures   https://wbsapi.withings.net/measure          (action=getmeas)
 *  - sleep      https://wbsapi.withings.net/v2/sleep         (action=getsummary)
 *  - notify     https://wbsapi.withings.net/notify           (subscription management, out-of-band)
 */

import { z } from 'zod';

/** Withings success status code (anything else is an application error). */
export const WITHINGS_STATUS_OK = 0;

/** Generic Withings envelope: `{ status, body }`. */
export interface WithingsEnvelope<T> {
  /** 0 = success; non-zero = application-level error. */
  status: number;
  body?: T;
  error?: string;
}

/**
 * Withings OAuth2 token endpoint response. NOTE: the token data lives under
 * `body` of the standard envelope, NOT at the top level — `POST /v2/oauth2`
 * returns `{ status, body: { access_token, refresh_token, expires_in, ... } }`.
 */
export interface WithingsTokenBody {
  access_token: string;
  refresh_token: string;
  /** Access-token lifetime in seconds. */
  expires_in: number;
  token_type?: string;
  /** Space-delimited granted scopes (provider-native). */
  scope?: string;
  /** Withings numeric user id (stable per app install). */
  userid?: number | string;
}

/**
 * One physical measure inside a measure group. The real value is
 * `value * 10^unit` (Withings encodes the decimal exponent in `unit`, so a
 * weight of 70.5 kg arrives as `{ value: 70500, unit: -3 }`).
 */
export interface WithingsMeasure {
  /** Measure type (1=weight, 6=fat ratio, 9=diastolic, 10=systolic, …). */
  type: number;
  /** Mantissa; multiply by 10^unit to get the real value. */
  value: number;
  /** Base-10 exponent applied to `value`. */
  unit: number;
}

/** A measure group taken at a single instant. */
export interface WithingsMeasureGroup {
  /** Provider-native group id (stable per measurement). */
  grpid: number;
  /** Measurement instant, UNIX epoch SECONDS. */
  date: number;
  /** Group category (1 = real measure, 2 = user objective). */
  category?: number;
  measures: WithingsMeasure[];
}

/** `GET/POST /measure?action=getmeas` body. */
export interface WithingsMeasureBody {
  measuregrps: WithingsMeasureGroup[];
  /** Pagination cursor: when `more === 1`, re-request with `offset`. */
  more?: number;
  offset?: number;
}

/**
 * `POST /v2/sleep?action=getsummary` per-night summary. Durations are SECONDS;
 * `sleep_efficiency` is a 0–1 ratio (NOT a percentage); `rr_average` is the mean
 * respiratory rate in breaths/min. The aggregate durations live under `data`.
 */
export interface WithingsSleepSummaryData {
  /** Total time asleep, SECONDS (deep + light + rem). */
  total_sleep_time?: number | null;
  /** REM sleep, SECONDS. */
  remsleepduration?: number | null;
  /** Deep sleep, SECONDS. */
  deepsleepduration?: number | null;
  /** Light sleep, SECONDS. */
  lightsleepduration?: number | null;
  /** Time awake within the sleep window, SECONDS. */
  wakeupduration?: number | null;
  /** Sleep efficiency as a 0–1 ratio (multiply by 100 for percent). */
  sleep_efficiency?: number | null;
  /** Mean respiratory rate over the night, BREATHS/MIN. */
  rr_average?: number | null;
}

export interface WithingsSleepSummarySeries {
  /** Provider-native summary id (stable per night). */
  id?: number | string;
  /** Sleep window start, UNIX epoch SECONDS. */
  startdate: number;
  /** Sleep window end, UNIX epoch SECONDS. */
  enddate: number;
  /** Aggregate per-night metrics. */
  data?: WithingsSleepSummaryData | null;
}

/** `POST /v2/sleep?action=getsummary` body. */
export interface WithingsSleepSummaryBody {
  series: WithingsSleepSummarySeries[];
  more?: number;
  offset?: number;
}

/**
 * Withings notify (webhook) callback payload. Withings delivers a
 * `application/x-www-form-urlencoded` POST with `userid`, `startdate`,
 * `enddate`, and `appli` (the notification application/category, e.g. 1 =
 * weight, 44 = sleep). It carries NO record body — the receiver re-fetches the
 * affected window from the measure/sleep API (#21 no payload trust).
 *
 * `appli` notification categories the connector handles (Withings notify docs):
 *  - 1  → new weight-related measure          → /measure getmeas  (H&F)
 *  - 44 → new sleep summary                    → /v2/sleep getsummary (S&R)
 */
export interface WithingsNotifyEvent {
  /** Withings user id (maps to WearableConnection.external_account_id). */
  userid: string;
  /** Affected window start, UNIX epoch SECONDS (string over the wire). */
  startdate: string;
  /** Affected window end, UNIX epoch SECONDS (string over the wire). */
  enddate: string;
  /** Notification application/category (see above). */
  appli: string;
}

/** Withings notify `appli` categories the connector knows how to handle. */
export const WITHINGS_APPLI_WEIGHT = 1;
export const WITHINGS_APPLI_SLEEP = 44;

/**
 * Scopes requested at connect time (AGENT_2_CODING_PLAN §3 Withings row):
 *  - `user.metrics`  → body measures (weight, fat ratio, blood pressure)
 *  - `user.activity` → sleep summaries
 */
export const WITHINGS_SCOPES = [
  'user.metrics',
  'user.activity',
] as const;

/**
 * Zod schema for the Withings notify callback. STRICT on the four fields we
 * consume — Withings sends form-encoded string values, so every field is a
 * non-empty string and `appli` must coerce to a known integer category. We do
 * NOT `.passthrough()`: a malformed-but-truthy body is rejected with a 400
 * (audit pattern #4). Numeric fields are validated as digit strings so a bad
 * `startdate` cannot hash into a garbage fetch window (#8 at the boundary).
 */
export const WithingsNotifySchema = z
  .object({
    userid: z.string().regex(/^\d+$/, 'userid must be a numeric string'),
    startdate: z.string().regex(/^\d+$/, 'startdate must be a numeric string'),
    enddate: z.string().regex(/^\d+$/, 'enddate must be a numeric string'),
    appli: z.string().regex(/^\d+$/, 'appli must be a numeric string'),
  })
  .strict();

export type WithingsNotifyParsed = z.infer<typeof WithingsNotifySchema>;

/** Source collection tags the connector wraps records under for the normalizer. */
export type WithingsCollection = 'measure' | 'sleep';
