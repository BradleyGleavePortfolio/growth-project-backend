/**
 * Roman model configuration (PLAN_roman_intelligence §3, slice R1).
 *
 * The model Roman calls comes from CONFIG, never from a hard-coded literal in
 * the call site. Roman was pinned to `claude-3-7-sonnet-20250219`, which
 * Anthropic retired on 2026-02-19; every turn failed upstream and the failure
 * was swallowed into a blank reply. This module:
 *
 *   - reads `ROMAN_MODEL_PRIMARY` / `ROMAN_MODEL_FALLBACK` / `ROMAN_MODEL_EFFORT`
 *     with the plan's defaults (`claude-sonnet-5-5` / `claude-sonnet-4-6` / `low`);
 *   - rejects unknown or RETIRED ids at boot with a clear message (NORTH_STAR
 *     model doctrine: "the model comes from config … never a silent downgrade");
 *   - carries a small per-model REQUEST PROFILE, because Sonnet 5.5 and 4.6 take
 *     different request shapes (verified against Anthropic's Sonnet 5.5
 *     migration guide on 2026-09-30):
 *       * 5.5: adaptive thinking is ON by default; to run without up-front
 *         thinking send `thinking: {type: 'between_tools'}` and set
 *         `output_config.effort` (low|medium|high). `thinking.type='disabled'`,
 *         `temperature`, `top_p`, `top_k`, prefill and forced tool_choice
 *         return 400.
 *       * Opus 5.5: thinking is ALWAYS adaptive. The request must omit
 *         `thinking` or send `thinking: {type: 'adaptive'}`; `between_tools`
 *         is a Sonnet 5.5 setting and returns 400 on Opus (Sol audit of
 *         #598, finding B1). Because the model may think before answering,
 *         `max_tokens` must cover thinking + text, so the Opus profile carries
 *         a larger turn budget and a larger probe budget.
 *       * 4.6: the plain request. No `thinking` (off by default there) and no
 *         `output_config`.
 *   - resolves ids with an OWN-property check (`Object.hasOwn`), so inherited
 *     names such as `constructor`, `toString` or `__proto__` fail boot as
 *     unknown models instead of resolving to a function (Sol finding C1).
 *   - carries the public price card per model so each call can write an
 *     `AICallLog.costCents` row and the daily USD cap can be computed.
 *
 * `@anthropic-ai/sdk 0.104.1` types `ThinkingConfigParam` as
 * enabled|disabled|adaptive; `between_tools` is not in the union yet but the
 * SDK serialises the body verbatim, so the profile is cast at the call site.
 * No SDK bump is needed (`output_config.effort` IS typed in 0.104.1).
 */

export const ROMAN_MODEL_PRIMARY_ENV = 'ROMAN_MODEL_PRIMARY';
export const ROMAN_MODEL_FALLBACK_ENV = 'ROMAN_MODEL_FALLBACK';
export const ROMAN_MODEL_EFFORT_ENV = 'ROMAN_MODEL_EFFORT';
export const ROMAN_GLOBAL_DAILY_USD_CAP_ENV = 'ROMAN_GLOBAL_DAILY_USD_CAP';

export const ROMAN_DEFAULT_PRIMARY_MODEL = 'claude-sonnet-5-5';
export const ROMAN_DEFAULT_FALLBACK_MODEL = 'claude-sonnet-4-6';
export const ROMAN_DEFAULT_EFFORT: RomanEffort = 'low';
export const ROMAN_DEFAULT_GLOBAL_DAILY_USD_CAP = 25;

export type RomanEffort = 'low' | 'medium' | 'high';
export const ROMAN_EFFORT_VALUES: readonly RomanEffort[] = ['low', 'medium', 'high'];

/** Which request shape a model takes. */
export type RomanRequestFamily = 'sonnet_5_5' | 'opus_5_5' | 'legacy_plain';

export interface RomanModelProfile {
  id: string;
  family: RomanRequestFamily;
  /** Public price card, USD per million tokens. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /**
   * `max_tokens` for one Roman turn. Thinking-inclusive for families whose
   * thinking cannot be switched off (Opus 5.5); text-only otherwise.
   */
  maxOutputTokens: number;
  /** `max_tokens` for the boot/health probe ("ping"), thinking-inclusive. */
  probeMaxTokens: number;
}

/** Text-only turn budget (plan §2.4) for models that do not think up front. */
export const ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS = 2048;
/**
 * Thinking-inclusive turn budget for always-adaptive models (Opus 5.5): the
 * same 2,048 tokens of text plus headroom for the adaptive thinking block.
 */
export const ROMAN_ADAPTIVE_MAX_OUTPUT_TOKENS = 4096;
/** 4 tokens is enough for "pong" when nothing is thought up front. */
export const ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS = 4;
/** Adaptive models may think before "pong"; give the probe room to finish. */
export const ROMAN_ADAPTIVE_PROBE_MAX_TOKENS = 256;

/**
 * Allow-list of model ids Roman may be configured with. Anything else — and
 * every id in `ROMAN_RETIRED_MODELS` — is rejected at boot. Prices from the
 * Anthropic models overview (plan §3 table).
 */
export const ROMAN_MODEL_ALLOWLIST: Readonly<Record<string, RomanModelProfile>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, RomanModelProfile>, {
    'claude-sonnet-5-5': {
      id: 'claude-sonnet-5-5',
      family: 'sonnet_5_5',
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      maxOutputTokens: ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS,
      probeMaxTokens: ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS,
    },
    'claude-opus-5-5': {
      id: 'claude-opus-5-5',
      family: 'opus_5_5',
      inputUsdPerMTok: 4,
      outputUsdPerMTok: 20,
      maxOutputTokens: ROMAN_ADAPTIVE_MAX_OUTPUT_TOKENS,
      probeMaxTokens: ROMAN_ADAPTIVE_PROBE_MAX_TOKENS,
    },
    'claude-sonnet-4-6': {
      id: 'claude-sonnet-4-6',
      family: 'legacy_plain',
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      maxOutputTokens: ROMAN_TEXT_ONLY_MAX_OUTPUT_TOKENS,
      probeMaxTokens: ROMAN_TEXT_ONLY_PROBE_MAX_TOKENS,
    },
  } satisfies Record<string, RomanModelProfile>),
);

/** Allowed ids, in allow-list order (own keys only — the object has no prototype). */
export function allowedRomanModelIds(): string[] {
  return Object.keys(ROMAN_MODEL_ALLOWLIST);
}

/**
 * Own-property lookup. `ROMAN_MODEL_ALLOWLIST` is a null-prototype object AND
 * the lookup checks `Object.hasOwn`, so `constructor` / `toString` /
 * `__proto__` / `hasOwnProperty` can never resolve to anything (Sol C1).
 */
export function lookupRomanModel(id: string): RomanModelProfile | null {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(ROMAN_MODEL_ALLOWLIST, id))
    return null;
  const profile = ROMAN_MODEL_ALLOWLIST[id];
  return profile && typeof profile === 'object' && profile.id === id ? profile : null;
}

/**
 * Ids that are known-retired or whose retirement window opens too close to
 * launch (plan §3: haiku-4-5 retires no sooner than 2026-10-15, two weeks
 * after launch — do not use). Listed separately so the boot error can say
 * "retired" rather than "unknown".
 */
export const ROMAN_RETIRED_MODELS: ReadonlySet<string> = new Set([
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-0',
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5',
]);

export interface RomanModelConfig {
  primary: RomanModelProfile;
  fallback: RomanModelProfile;
  effort: RomanEffort;
  /** Global daily spend cap in USD across all Roman calls (UTC day). */
  globalDailyUsdCap: number;
}

export class RomanModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RomanModelConfigError';
  }
}

/** Resolve a single model id against the allow-list, with a clear message. */
export function resolveRomanModel(
  envName: string,
  raw: string | undefined,
  fallback: string,
): RomanModelProfile {
  const id = (raw ?? '').trim() || fallback;
  if (ROMAN_RETIRED_MODELS.has(id)) {
    throw new RomanModelConfigError(
      `[roman] ${envName}=${id} is RETIRED by Anthropic. Use one of: ${allowedRomanModelIds().join(', ')}.`,
    );
  }
  const profile = lookupRomanModel(id);
  if (!profile) {
    throw new RomanModelConfigError(
      `[roman] ${envName}=${id} is not an allowed Roman model. Use one of: ${allowedRomanModelIds().join(', ')}.`,
    );
  }
  return profile;
}

/**
 * Read + validate the Roman model config from the environment. Throws
 * `RomanModelConfigError` on an unknown / retired id or a bad effort value, so
 * a misconfigured deploy fails at boot instead of on the first user turn.
 */
export function resolveRomanModelConfig(env: NodeJS.ProcessEnv = process.env): RomanModelConfig {
  const primary = resolveRomanModel(
    ROMAN_MODEL_PRIMARY_ENV,
    env[ROMAN_MODEL_PRIMARY_ENV],
    ROMAN_DEFAULT_PRIMARY_MODEL,
  );
  const fallback = resolveRomanModel(
    ROMAN_MODEL_FALLBACK_ENV,
    env[ROMAN_MODEL_FALLBACK_ENV],
    ROMAN_DEFAULT_FALLBACK_MODEL,
  );

  const rawEffort = (env[ROMAN_MODEL_EFFORT_ENV] ?? '').trim().toLowerCase();
  const effort = (rawEffort || ROMAN_DEFAULT_EFFORT) as RomanEffort;
  if (!ROMAN_EFFORT_VALUES.includes(effort)) {
    throw new RomanModelConfigError(
      `[roman] ${ROMAN_MODEL_EFFORT_ENV}=${rawEffort} is invalid. Use one of: ${ROMAN_EFFORT_VALUES.join(', ')}.`,
    );
  }

  const rawCap = (env[ROMAN_GLOBAL_DAILY_USD_CAP_ENV] ?? '').trim();
  const globalDailyUsdCap = rawCap ? Number(rawCap) : ROMAN_DEFAULT_GLOBAL_DAILY_USD_CAP;
  if (!Number.isFinite(globalDailyUsdCap) || globalDailyUsdCap < 0) {
    throw new RomanModelConfigError(
      `[roman] ${ROMAN_GLOBAL_DAILY_USD_CAP_ENV}=${rawCap} is invalid. Use a non-negative number of US dollars.`,
    );
  }

  return { primary, fallback, effort, globalDailyUsdCap };
}

/**
 * Per-model request fields merged into the Messages API body. Returned as a
 * plain record so the caller can spread it; the `thinking.type='between_tools'`
 * value is newer than the SDK's typed union and is cast at the call site.
 *
 *   sonnet_5_5   thinking.between_tools + output_config.effort
 *   opus_5_5     thinking.adaptive      + output_config.effort  (never between_tools)
 *   legacy_plain nothing
 */
export function requestProfileFor(
  profile: RomanModelProfile,
  effort: RomanEffort,
): Record<string, unknown> {
  switch (profile.family) {
    case 'sonnet_5_5':
      return {
        thinking: { type: 'between_tools' },
        output_config: { effort },
      };
    case 'opus_5_5':
      return {
        thinking: { type: 'adaptive' },
        output_config: { effort },
      };
    case 'legacy_plain':
    default:
      return {};
  }
}

/**
 * The complete per-model body fields for ONE Roman turn: `model`, a
 * thinking-inclusive `max_tokens` and the request profile. Used by both the
 * turn path and (with `probeRequestFor`) the boot probe so the two can never
 * disagree on a model's contract.
 */
export function turnRequestFor(
  profile: RomanModelProfile,
  effort: RomanEffort,
): { model: string; max_tokens: number } & Record<string, unknown> {
  return {
    model: profile.id,
    max_tokens: profile.maxOutputTokens,
    ...requestProfileFor(profile, effort),
  };
}

/** The complete per-model body fields for the boot/health probe. */
export function probeRequestFor(
  profile: RomanModelProfile,
  effort: RomanEffort,
): { model: string; max_tokens: number } & Record<string, unknown> {
  return {
    model: profile.id,
    max_tokens: profile.probeMaxTokens,
    ...requestProfileFor(profile, effort),
  };
}

/** Cost in integer cents for one call, rounded up so the cap is conservative. */
export function costCentsFor(
  profile: RomanModelProfile,
  inputTokens: number,
  outputTokens: number,
): number {
  const usd =
    (Math.max(0, inputTokens) / 1_000_000) * profile.inputUsdPerMTok +
    (Math.max(0, outputTokens) / 1_000_000) * profile.outputUsdPerMTok;
  return Math.ceil(usd * 100);
}

/** The AICallLog capability string for Roman chat turns. */
export const ROMAN_AI_CAPABILITY = 'roman_chat';
export const ROMAN_AI_CAPABILITY_PROBE = 'roman_boot_probe';
