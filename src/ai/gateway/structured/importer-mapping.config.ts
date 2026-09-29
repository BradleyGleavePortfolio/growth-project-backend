import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiGatewayConfig, AiProviderName } from '../ai-gateway.config';
import { MICROS_PER_USD, parseUsdToMicros } from './money';

// L1-gw — configuration for the `importer.mapping` capability.
//
// Capability id is vendor-free by design (NEW SOURCE → CORE DIFF = 0). Every
// value is read from the environment AT CALL TIME (same posture as
// AiGatewayConfig) so the kill switch and the spend cap flip without a
// redeploy. Names follow the learn-and-remember record D-L0-7.3/7.4
// (Q-L0-4 approved flags). Each key is read through an in-file string const
// (`process.env[ENV_X]`) so the repo's env discovery (R108,
// test/prod-readiness/env-discovery.ts) can see it; every key has a row in
// prod-switches.yml.
//
// r2 (R592-B-C4, R592-A-B2): garbage config REFUSES (`config-invalid:<NAME>`)
// instead of silently falling back; prices must be strictly positive.
//
// r3 (R592-c7B-03, R592-c7A-05, R592-c7A-01): production has NO silent
// defaults for money or model — prices (`price-unset:<NAME>`), the cap
// (`spend-cap-unset`) and the primary model (`model-unset`) must be set
// explicitly; a malformed primary or fallback entry refuses instead of being
// dropped (no silent promotion of a fallback to primary). Money is parsed to
// integer micro-USD (see money.ts), never to a float. At boot, with the kill
// switch ON in production, an incomplete money/model configuration FAILS the
// boot (`assertBootPosture`) so an operator cannot enable the capability on
// defaults by accident; with the switch OFF it is logged and every call is
// refused at call time.

export const IMPORTER_MAPPING_CAPABILITY = 'importer.mapping';

// Env keys (in-file consts — see header).
const ENV_KILL_SWITCH = 'SCOUT_LEARN_AI_ENABLED';
const ENV_PROVIDER = 'AI_PROVIDER_IMPORTER_MAPPING';
const ENV_MODEL = 'AI_MODEL_IMPORTER_MAPPING';
const ENV_FALLBACKS = 'SCOUT_LEARN_MODEL_FALLBACKS';
const ENV_CALL_TIMEOUT = 'SCOUT_LEARN_CALL_TIMEOUT_MS';
const ENV_MAX_INPUT_TOKENS = 'SCOUT_LEARN_MAX_INPUT_TOKENS';
const ENV_MAX_OUTPUT_TOKENS = 'SCOUT_LEARN_MAX_OUTPUT_TOKENS';
const ENV_DAILY_SPEND = 'SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD';
const ENV_PRICE_IN = 'AI_PRICE_INPUT_USD_PER_MTOK';
const ENV_PRICE_OUT = 'AI_PRICE_OUTPUT_USD_PER_MTOK';
const ENV_DEV_OFFLINE = 'AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER';
const ENV_LEGACY_PROVIDER = 'AI_GATEWAY_PROVIDER';

export const IMPORTER_MAPPING_ENV_KEYS = Object.freeze([
  ENV_KILL_SWITCH,
  ENV_PROVIDER,
  ENV_MODEL,
  ENV_FALLBACKS,
  ENV_CALL_TIMEOUT,
  ENV_MAX_INPUT_TOKENS,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_DAILY_SPEND,
  ENV_PRICE_IN,
  ENV_PRICE_OUT,
  ENV_DEV_OFFLINE,
]);

export const IMPORTER_MAPPING_DEFAULTS = Object.freeze({
  // Record D-L0-7.3: per-call timeout 90 s.
  callTimeoutMs: 90_000,
  // Record D-L0-7.3: 24 000 input / 4 096 output tokens per call.
  maxInputTokens: 24_000,
  maxOutputTokens: 4_096,
  // Owner D3 placeholder (2026-09-28), in micro-USD. Applies OUTSIDE
  // production only; production refuses when the cap is unset.
  dailySpendMicrosPlaceholder: 20 * MICROS_PER_USD,
  // Conservative list prices (micro-USD per million tokens = $10 / $50 per
  // MTok) used OUTSIDE production when AI_PRICE_* are unset. Production
  // refuses when either price is unset (R592-c7B-03). Prices are config,
  // never per-model code.
  inputPriceMicrosPerMTok: 10 * MICROS_PER_USD,
  outputPriceMicrosPerMTok: 50 * MICROS_PER_USD,
  temperature: 0,
});

// Refusal reasons that mean "money or model not explicitly configured" —
// the set `assertBootPosture` fails the boot on when the switch is ON in
// production.
export const BOOT_FATAL_REASON_RE =
  /^(model-unset|spend-cap-unset|price-unset:.*|config-invalid:.*)$/;

export interface ImporterMappingResolvedConfig {
  // True only when every gate is open and a real provider will be called.
  ok: boolean;
  // Content-free reason when `ok` is false.
  refusalReason: string | null;
  // True when the stub adapter is what would be called and that is allowed
  // (NODE_ENV=test or the dev flag outside production).
  stubPermitted: boolean;
  provider: AiProviderName;
  models: string[];
  callTimeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  // Integer micro-USD (money.ts). Null only when the cap could not be
  // resolved (then `ok` is false).
  dailySpendCapMicros: number | null;
  // Integer micro-USD per million tokens. 0 only when `ok` is false.
  inputPriceMicrosPerMTok: number;
  outputPriceMicrosPerMTok: number;
  temperature: number;
  isProduction: boolean;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

@Injectable()
export class ImporterMappingConfig implements OnModuleInit {
  private readonly logger = new Logger(ImporterMappingConfig.name);

  constructor(private readonly gateway: AiGatewayConfig) {}

  onModuleInit(): void {
    this.assertBootPosture();
  }

  // r3 — fail closed AT BOOT. In production with the kill switch ON, an
  // unset / malformed price, cap or model (or any other config-invalid
  // value) throws so the process does not start on defaults. With the switch
  // OFF the capability is dark: the posture is logged (error level in
  // production) and every call is refused at call time. Outside production
  // this only logs.
  assertBootPosture(): void {
    const r = this.resolve();
    if (r.ok) {
      this.logger.log(
        `[importer.mapping] boot posture: ${r.stubPermitted ? 'stub-permitted' : 'open'} provider=${r.provider} models=${r.models.length}`,
      );
      return;
    }
    const line = `[importer.mapping] boot posture: refusing every call (${r.refusalReason})`;
    if (
      this.isProduction() &&
      this.killSwitchOn() &&
      BOOT_FATAL_REASON_RE.test(r.refusalReason ?? '')
    ) {
      throw new Error(
        `${line} — ${ENV_KILL_SWITCH} is on but the capability is not explicitly configured; set the value or turn the switch off`,
      );
    }
    if (this.isProduction()) this.logger.error(line);
    else this.logger.warn(line);
  }

  isProduction(): boolean {
    return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  }

  isTest(): boolean {
    return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'test';
  }

  // Live kill switch. Re-read before EVERY provider attempt (R592-A-B1).
  killSwitchOn(): boolean {
    return flag(process.env[ENV_KILL_SWITCH]);
  }

  // Stub is allowed ONLY in test, or with the explicit dev flag outside
  // production. Production never gets a stub answer for this capability.
  stubAllowed(): boolean {
    if (this.isProduction()) return false;
    if (this.isTest()) return true;
    return flag(process.env[ENV_DEV_OFFLINE]);
  }

  // Provider for this capability: AI_PROVIDER_IMPORTER_MAPPING, else the
  // gateway-wide AI_GATEWAY_PROVIDER (R592-B-C2). Unknown names → 'stub'
  // (which production refuses).
  providerName(): AiProviderName {
    const raw = (process.env[ENV_PROVIDER] ?? process.env[ENV_LEGACY_PROVIDER] ?? 'stub')
      .trim()
      .toLowerCase();
    if (raw === 'anthropic' || raw === 'openai' || raw === 'perplexity') return raw;
    return 'stub';
  }

  resolve(): ImporterMappingResolvedConfig {
    const isProduction = this.isProduction();
    const shared = this.gateway.resolve(IMPORTER_MAPPING_CAPABILITY);
    const provider = this.providerName();
    const models = this.models();

    const callTimeout = parseDurationMs(
      process.env[ENV_CALL_TIMEOUT],
      IMPORTER_MAPPING_DEFAULTS.callTimeoutMs,
    );
    const maxIn = parsePositiveInt(
      process.env[ENV_MAX_INPUT_TOKENS],
      IMPORTER_MAPPING_DEFAULTS.maxInputTokens,
    );
    const maxOut = parsePositiveInt(
      process.env[ENV_MAX_OUTPUT_TOKENS],
      IMPORTER_MAPPING_DEFAULTS.maxOutputTokens,
    );
    const priceIn = parsePriceMicros(
      ENV_PRICE_IN,
      process.env[ENV_PRICE_IN],
      IMPORTER_MAPPING_DEFAULTS.inputPriceMicrosPerMTok,
      isProduction,
    );
    const priceOut = parsePriceMicros(
      ENV_PRICE_OUT,
      process.env[ENV_PRICE_OUT],
      IMPORTER_MAPPING_DEFAULTS.outputPriceMicrosPerMTok,
      isProduction,
    );
    const cap = parseCapMicros(process.env[ENV_DAILY_SPEND], isProduction);

    const base = {
      stubPermitted: false,
      provider,
      models: models.ok ? models.value : [],
      callTimeoutMs: callTimeout.ok ? callTimeout.value : IMPORTER_MAPPING_DEFAULTS.callTimeoutMs,
      maxInputTokens: maxIn.ok ? maxIn.value : IMPORTER_MAPPING_DEFAULTS.maxInputTokens,
      maxOutputTokens: maxOut.ok ? maxOut.value : IMPORTER_MAPPING_DEFAULTS.maxOutputTokens,
      dailySpendCapMicros: cap.ok ? cap.value : null,
      inputPriceMicrosPerMTok: priceIn.ok ? priceIn.value : 0,
      outputPriceMicrosPerMTok: priceOut.ok ? priceOut.value : 0,
      temperature: IMPORTER_MAPPING_DEFAULTS.temperature,
      isProduction,
    };
    const refuse = (refusalReason: string): ImporterMappingResolvedConfig => ({
      ...base,
      ok: false,
      refusalReason,
    });

    // Order matters: the cheapest, most operator-visible refusals first.
    if (!this.killSwitchOn()) return refuse('kill-switch-off');
    if (!shared.capabilityAllowed) return refuse('capability-not-allowed');
    if (shared.reason === 'gateway-disabled') return refuse('gateway-disabled');
    if (provider === 'stub') {
      // Explicit stub or unknown provider name. Permit only where the stub is
      // allowed; production refuses.
      if (this.stubAllowed())
        return { ...base, ok: true, refusalReason: null, stubPermitted: true };
      return refuse('stub-provider-not-permitted');
    }
    if (!this.gateway.providerKeyPresent(provider))
      return refuse(`provider-key-missing:${provider}`);
    // r3 (R592-c7A-05): the PRIMARY must be set and valid regardless of any
    // fallback; a malformed fallback entry refuses rather than being dropped.
    if (!models.ok) return refuse(models.reason);
    // Strict config: any unparseable or non-positive limit/price refuses.
    if (!callTimeout.ok) return refuse(callTimeout.reason);
    if (!maxIn.ok) return refuse(maxIn.reason);
    if (!maxOut.ok) return refuse(maxOut.reason);
    if (!priceIn.ok) return refuse(priceIn.reason);
    if (!priceOut.ok) return refuse(priceOut.reason);
    if (!cap.ok) return refuse(cap.reason);
    return { ...base, ok: true, refusalReason: null };
  }

  // Ordered model list: the explicit primary first, then the explicit
  // fallbacks in order (each model at most once; a repeated id is collapsed).
  // Fallbacks are attempted ONLY when configured. Refuses — never silently
  // drops an entry or promotes a fallback to primary (R592-c7A-05) — when the
  // primary is unset or invalid, or when any fallback entry is malformed or
  // empty (e.g. a trailing comma).
  models(): Parsed<string[]> {
    const primary = (process.env[ENV_MODEL] ?? '').trim();
    if (primary === '') return { ok: false, reason: 'model-unset' };
    if (!MODEL_ID_RE.test(primary)) return { ok: false, reason: `config-invalid:${ENV_MODEL}` };
    const out = [primary];
    const rawFallbacks = (process.env[ENV_FALLBACKS] ?? '').trim();
    if (rawFallbacks === '') return { ok: true, value: out };
    for (const entry of rawFallbacks.split(',')) {
      const m = entry.trim();
      if (!MODEL_ID_RE.test(m)) return { ok: false, reason: `config-invalid:${ENV_FALLBACKS}` };
      if (!out.includes(m)) out.push(m);
    }
    return { ok: true, value: out };
  }
}

const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function flag(v: string | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

// Durations: an integer with an optional unit (`ms`, `s`, `m`); bare integers
// are milliseconds. Anything else refuses (R592-B-C4: `90s` must never parse
// as 90 ms).
const DURATION_RE = /^(\d{1,9})(ms|s|m)?$/;

export function parseDurationMs(raw: string | undefined, fallback: number): Parsed<number> {
  const s = (raw ?? '').trim();
  if (s === '') return { ok: true, value: fallback };
  const m = DURATION_RE.exec(s);
  if (!m) return { ok: false, reason: `config-invalid:${ENV_CALL_TIMEOUT}` };
  const n = Number.parseInt(m[1], 10);
  const unit = m[2] ?? 'ms';
  const ms = unit === 'm' ? n * 60_000 : unit === 's' ? n * 1_000 : n;
  if (!Number.isFinite(ms) || ms <= 0)
    return { ok: false, reason: `config-invalid:${ENV_CALL_TIMEOUT}` };
  return { ok: true, value: ms };
}

function parsePositiveInt(raw: string | undefined, fallback: number): Parsed<number> {
  const s = (raw ?? '').trim();
  if (s === '') return { ok: true, value: fallback };
  if (!/^\d{1,9}$/.test(s)) return { ok: false, reason: 'config-invalid:positive-integer' };
  const n = Number.parseInt(s, 10);
  if (n <= 0) return { ok: false, reason: 'config-invalid:positive-integer' };
  return { ok: true, value: n };
}

// Prices are decimal USD per million tokens, parsed to integer micro-USD per
// million tokens (money.ts; at most six decimals). Strictly positive
// (R592-A-B2: a zero price would make every reservation $0). Production
// REFUSES when unset (`price-unset:<NAME>`, R592-c7B-03); outside production
// the conservative list-price default applies.
function parsePriceMicros(
  name: string,
  raw: string | undefined,
  fallbackMicros: number,
  isProduction: boolean,
): Parsed<number> {
  const s = (raw ?? '').trim();
  if (s === '') {
    return isProduction
      ? { ok: false, reason: `price-unset:${name}` }
      : { ok: true, value: fallbackMicros };
  }
  const micros = parseUsdToMicros(s);
  if (micros === null || micros <= 0) return { ok: false, reason: `config-invalid:${name}` };
  return { ok: true, value: micros };
}

// Daily cap in decimal USD → integer micro-USD. Production REFUSES when unset
// (`spend-cap-unset`); elsewhere the owner placeholder applies. Zero is a
// valid cap (refuses every paid call, because a reservation is never 0).
function parseCapMicros(raw: string | undefined, isProduction: boolean): Parsed<number> {
  const s = (raw ?? '').trim();
  if (s === '') {
    return isProduction
      ? { ok: false, reason: 'spend-cap-unset' }
      : { ok: true, value: IMPORTER_MAPPING_DEFAULTS.dailySpendMicrosPlaceholder };
  }
  const micros = parseUsdToMicros(s);
  if (micros === null) return { ok: false, reason: `config-invalid:${ENV_DAILY_SPEND}` };
  return { ok: true, value: micros };
}
