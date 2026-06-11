import { Injectable, Logger } from '@nestjs/common';
import {
  isMwbAiLiveCreateEnabled,
  isMwbLiveCreateCapability,
} from './mwb-live-create.feature';

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
    // MWB-5 — the two live-create capabilities are gated by
    // FEATURE_MWB_AI_LIVE_CREATE (default OFF). While the flag is off they are
    // NEVER allowed, regardless of AI_GATEWAY_CAPABILITIES, so
    // AiGatewayService.invoke rejects them at the capability-allow-list check
    // BEFORE any AiActionDraft row is created (brief Test matrix #7). The
    // env-list membership check below still applies when the flag is on, so an
    // operator opts in explicitly on BOTH switches.
    if (isMwbLiveCreateCapability(capability) && !isMwbAiLiveCreateEnabled()) {
      return false;
    }
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
//
// Stream 2 additions (`draft.assign_workout`, `draft.assign_meal_plan`,
// `draft.send_notification`) all require approval — they emit user-
// visible side-effects on a client's roster and must never auto-fire.
// `draft.client_message` is intentionally NOT listed: it was merged
// into `draft.coach_message` during the Stream 2 build (same target
// table, same payload, same materialiser).
export const DEFAULT_APPROVAL_REQUIRED = new Set<string>([
  'draft.coach_message',
  'draft.meal_plan_change',
  'draft.client_facing_claim',
  'flag.escalation',
  // Stream 2 — AI execution capabilities
  'draft.assign_workout',
  'draft.assign_meal_plan',
  'draft.send_notification',
  // MWB-5 — live-create capabilities write real WorkoutPlan / revision rows on
  // approval and must NEVER auto-fire; they require human approval by default.
  'draft.create_workout_plan',
  'draft.edit_workout_plan',
]);

/**
 * Stream 2 — Default capability allow-list for the AI gateway.
 *
 * The env var `AI_GATEWAY_CAPABILITIES` overrides this; when it is unset
 * the gateway returns `capabilityAllowed=false` for everything (the
 * historical fail-closed posture). For the dev / staging baseline we
 * keep that posture — operators must explicitly opt-in to the
 * capabilities they want live by setting the env var.
 *
 * This set is consumed only by tests + by ops tooling that needs to
 * enumerate the Stream-2 capability strings without re-scraping the
 * spec. The gateway resolver itself reads from process.env at call
 * time so a fly-secrets flip is live without a redeploy.
 */
export const STREAM_2_AI_EXECUTION_CAPABILITIES = new Set<string>([
  'draft.coach_message',
  'draft.assign_workout',
  'draft.assign_meal_plan',
  'draft.send_notification',
]);

/**
 * Stream 2 — Capabilities subject to the `draft.*` role gate. Any
 * capability string starting with `draft.` is rejected at the gateway
 * for non-coach / non-owner roles. The constant exists so a future
 * refactor that moves the gate elsewhere has a single source of truth
 * for the prefix (50-Failures #41 — never re-inline a magic string).
 */
export const DRAFT_CAPABILITY_PREFIX = 'draft.';
