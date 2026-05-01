import { Injectable, Logger } from '@nestjs/common';

// AI gateway feature gate. Default is FAIL CLOSED: even if a provider key
// is configured, the gateway only routes to a real provider when the
// operator has explicitly enabled the gateway and the per-capability flag
// is on. Anything else falls through to the deterministic stub provider.
//
// Env vars (names only — never commit values):
//   AI_GATEWAY_ENABLED          — master switch (default off)
//   AI_GATEWAY_PROVIDER         — "stub" | "perplexity" | "openai" | "anthropic"
//   AI_GATEWAY_CAPABILITIES     — comma-separated allow-list
//   AI_GATEWAY_REQUIRE_APPROVAL — comma-separated capabilities that require human approval
//   PERPLEXITY_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY (handled by provider adapters)
//
// Reading the env on every call (not at module load) keeps tests
// deterministic and lets ops flip the kill-switch without a redeploy.

export type AiProviderName = 'stub' | 'perplexity' | 'openai' | 'anthropic';

export interface ResolvedAiConfig {
  enabled: boolean;
  provider: AiProviderName;
  capabilityAllowed: boolean;
  requireApproval: boolean;
  reason?: string;
}

@Injectable()
export class AiGatewayConfig {
  private readonly logger = new Logger(AiGatewayConfig.name);

  resolve(capability: string): ResolvedAiConfig {
    const enabled = this.envFlag('AI_GATEWAY_ENABLED');
    const providerRaw = (process.env.AI_GATEWAY_PROVIDER ?? 'stub').trim().toLowerCase();
    const provider: AiProviderName = this.normalizeProvider(providerRaw);
    const capabilityAllowed = this.capabilityAllowed(capability);
    const requireApproval = this.requireApprovalFor(capability);

    if (!enabled) {
      return {
        enabled: false,
        provider: 'stub',
        capabilityAllowed,
        requireApproval,
        reason: 'gateway-disabled',
      };
    }
    if (!capabilityAllowed) {
      return {
        enabled: false,
        provider: 'stub',
        capabilityAllowed: false,
        requireApproval,
        reason: `capability-not-allowed:${capability}`,
      };
    }
    if (provider !== 'stub' && !this.providerKeyPresent(provider)) {
      return {
        enabled: false,
        provider: 'stub',
        capabilityAllowed,
        requireApproval,
        reason: `provider-key-missing:${provider}`,
      };
    }
    return {
      enabled: provider !== 'stub',
      provider,
      capabilityAllowed,
      requireApproval,
    };
  }

  // Capabilities that consequential outputs must hit before any downstream
  // mutation (sending a coach message, applying a meal-plan change, etc).
  // Default-on: if the env var is missing we still gate the canonical
  // consequential capabilities so an operator must opt OUT of the safety
  // rather than opt IN.
  requireApprovalFor(capability: string): boolean {
    const raw = process.env.AI_GATEWAY_REQUIRE_APPROVAL;
    if (raw == null || raw.trim() === '') {
      return DEFAULT_APPROVAL_REQUIRED.has(capability);
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(capability);
  }

  private capabilityAllowed(capability: string): boolean {
    const raw = process.env.AI_GATEWAY_CAPABILITIES;
    if (raw == null || raw.trim() === '') return false;
    if (raw.trim() === '*') return true;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(capability);
  }

  private providerKeyPresent(provider: AiProviderName): boolean {
    if (provider === 'perplexity') return !!process.env.PERPLEXITY_API_KEY?.trim();
    if (provider === 'openai') return !!process.env.OPENAI_API_KEY?.trim();
    if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY?.trim();
    return true;
  }

  private envFlag(name: string): boolean {
    const v = (process.env[name] ?? '').trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }

  private normalizeProvider(raw: string): AiProviderName {
    if (raw === 'perplexity' || raw === 'openai' || raw === 'anthropic') return raw;
    return 'stub';
  }
}

// Capabilities that require human approval by default. Mirrors the
// finance-app contract from PR #112 (see docs/AI_GATEWAY.md).
export const DEFAULT_APPROVAL_REQUIRED = new Set<string>([
  'draft.coach_message',
  'draft.meal_plan_change',
  'draft.client_facing_claim',
  'flag.escalation',
]);
