import { Injectable } from '@nestjs/common';
import { AiGatewayConfig, AiProviderName } from '../ai-gateway.config';

// L1-gw — configuration for the `importer.mapping` capability.
//
// Capability id is vendor-free by design (NEW SOURCE → CORE DIFF = 0). Every
// value is read from the environment AT CALL TIME (same posture as
// AiGatewayConfig) so the kill switch and the spend cap flip without a
// redeploy. Names follow the learn-and-remember record D-L0-7.3/7.4
// (Q-L0-4 approved flags):
//
//   AI_GATEWAY_ENABLED / AI_GATEWAY_CAPABILITIES / AI_GATEWAY_PROVIDER
//                                     — shared gateway gate (AiGatewayConfig)
//   SCOUT_LEARN_AI_ENABLED            — kill switch for this capability (default OFF)
//   AI_MODEL_IMPORTER_MAPPING         — primary model id (required; no default)
//   SCOUT_LEARN_MODEL_FALLBACKS       — comma list of fallback models (default none)
//   SCOUT_LEARN_CALL_TIMEOUT_MS       — hard per-request timeout (default 45 000)
//   SCOUT_LEARN_MAX_OUTPUT_TOKENS     — max output tokens per call (default 4 096)
//   SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD— global daily spend cap; placeholder 20
//                                       outside production; production REFUSES when unset
//   AI_PRICE_INPUT_USD_PER_MTOK       — list price used for the estimate (default 10)
//   AI_PRICE_OUTPUT_USD_PER_MTOK      — list price used for the estimate (default 50)
//   AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER         — dev-only: permit the stub provider outside
//                                       NODE_ENV=test. Ignored in production.

export const IMPORTER_MAPPING_CAPABILITY = 'importer.mapping';

export const IMPORTER_MAPPING_DEFAULTS = Object.freeze({
  callTimeoutMs: 45_000,
  maxOutputTokens: 4_096,
  // Owner D3 placeholder (2026-09-28). Applies OUTSIDE production only.
  dailySpendUsdPlaceholder: 20,
  inputUsdPerMTok: 10,
  outputUsdPerMTok: 50,
  temperature: 0,
});

export interface ImporterMappingResolvedConfig {
  // True only when every gate is open and a real provider will be called.
  ok: boolean;
  // Content-free reason when `ok` is false.
  refusalReason: string | null;
  // True when the stub adapter is what would be called and that is allowed
  // (NODE_ENV=test or AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER outside production).
  stubPermitted: boolean;
  provider: AiProviderName;
  models: string[];
  callTimeoutMs: number;
  maxOutputTokens: number;
  dailySpendCapUsd: number | null;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  temperature: number;
  isProduction: boolean;
}

@Injectable()
export class ImporterMappingConfig {
  constructor(private readonly gateway: AiGatewayConfig) {}

  isProduction(): boolean {
    return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  }

  isTest(): boolean {
    return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'test';
  }

  // Stub is allowed ONLY in test, or with the explicit dev flag outside
  // production. Production never gets a stub answer for this capability.
  stubAllowed(): boolean {
    if (this.isProduction()) return false;
    if (this.isTest()) return true;
    return envFlag('AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER');
  }

  resolve(): ImporterMappingResolvedConfig {
    const isProduction = this.isProduction();
    const shared = this.gateway.resolve(IMPORTER_MAPPING_CAPABILITY);
    const models = this.models();
    const callTimeoutMs = envPositiveInt(
      'SCOUT_LEARN_CALL_TIMEOUT_MS',
      IMPORTER_MAPPING_DEFAULTS.callTimeoutMs,
    );
    const maxOutputTokens = envPositiveInt(
      'SCOUT_LEARN_MAX_OUTPUT_TOKENS',
      IMPORTER_MAPPING_DEFAULTS.maxOutputTokens,
    );
    const dailySpendCapUsd = this.dailySpendCapUsd(isProduction);
    const inputUsdPerMTok = envPositiveNumber(
      'AI_PRICE_INPUT_USD_PER_MTOK',
      IMPORTER_MAPPING_DEFAULTS.inputUsdPerMTok,
    );
    const outputUsdPerMTok = envPositiveNumber(
      'AI_PRICE_OUTPUT_USD_PER_MTOK',
      IMPORTER_MAPPING_DEFAULTS.outputUsdPerMTok,
    );

    const base = {
      stubPermitted: false,
      provider: shared.provider,
      models,
      callTimeoutMs,
      maxOutputTokens,
      dailySpendCapUsd,
      inputUsdPerMTok,
      outputUsdPerMTok,
      temperature: IMPORTER_MAPPING_DEFAULTS.temperature,
      isProduction,
    };

    // Order matters: the cheapest, most operator-visible refusals first.
    if (!envFlag('SCOUT_LEARN_AI_ENABLED')) {
      return { ...base, ok: false, refusalReason: 'kill-switch-off' };
    }
    if (!shared.capabilityAllowed) {
      return { ...base, ok: false, refusalReason: 'capability-not-allowed' };
    }
    if (shared.reason === 'gateway-disabled') {
      return { ...base, ok: false, refusalReason: 'gateway-disabled' };
    }
    if (shared.reason && shared.reason.startsWith('provider-key-missing')) {
      return { ...base, ok: false, refusalReason: shared.reason };
    }
    if (shared.provider === 'stub') {
      // AI_GATEWAY_PROVIDER=stub or an unknown provider name. Permit only
      // where the stub is allowed; production refuses.
      if (this.stubAllowed()) {
        return { ...base, ok: true, refusalReason: null, stubPermitted: true };
      }
      return { ...base, ok: false, refusalReason: 'stub-provider-not-permitted' };
    }
    if (models.length === 0) {
      return { ...base, ok: false, refusalReason: 'model-unset' };
    }
    if (dailySpendCapUsd == null) {
      return { ...base, ok: false, refusalReason: 'spend-cap-unset' };
    }
    return { ...base, ok: true, refusalReason: null };
  }

  // Ordered, de-duplicated model list: primary first, then any fallbacks.
  // Fallbacks are attempted ONLY when explicitly configured.
  models(): string[] {
    const primary = (process.env.AI_MODEL_IMPORTER_MAPPING ?? '').trim();
    const fallbacks = (process.env.SCOUT_LEARN_MODEL_FALLBACKS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out: string[] = [];
    for (const m of [primary, ...fallbacks]) {
      if (m && !out.includes(m)) out.push(m);
    }
    return out;
  }

  private dailySpendCapUsd(isProduction: boolean): number | null {
    const raw = (process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD ?? '').trim();
    if (raw === '') {
      // Production: unset cap = refuse (fail closed on spend). Elsewhere the
      // owner placeholder applies so local/dev/test can exercise the path.
      return isProduction ? null : IMPORTER_MAPPING_DEFAULTS.dailySpendUsdPlaceholder;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }
}

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envPositiveNumber(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
