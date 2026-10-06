/**
 * Roman's Anthropic client provider.
 *
 * Roman deliberately owns its OWN Anthropic client behind the DI token
 * `ROMAN_ANTHROPIC_CLIENT` (brief §4) rather than reusing the coach-AI
 * `AnthropicAdapter`. Two reasons:
 *   1. File-surface isolation — the coach-AI adapter lives in `src/ai/*`, a
 *      directory actively churned by the master-workout-builder track. Roman
 *      keeps a clean blast radius in `src/roman/*`.
 *   2. Different call shape — Roman STREAMS (SSE) and self-rate-limits its
 *      voice budget; the coach adapter is a request/response JSON engine.
 *
 * The token is `@Optional()`-injectable so tests inject a fake streaming client
 * without any network. Production boot leaves it unset and the service lazily
 * constructs a real client from `ANTHROPIC_API_KEY`.
 */

import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AnthropicHandle,
  AnthropicThinkingBetweenTools,
} from '../ai-egress/ai-egress.service';
import { createAnthropicClient } from '../ai-egress/provider-clients';

/** DI token for Roman's Anthropic client (brief §4). */
export const ROMAN_ANTHROPIC_CLIENT = 'ROMAN_ANTHROPIC_CLIENT';

/**
 * Phase 1 model (brief §4): cost-efficient Sonnet default. Phase 1.1 may
 * upgrade to opus for milestone moments — documented in the PR body. R31
 * note: this is the PRODUCT runtime model the deployed Roman calls, chosen by
 * the brief; it is unrelated to the agent runtime that authored this code.
 */
export const ROMAN_MODEL_PHASE_1 = 'claude-sonnet-5-5';
// B-ROMANIQ-125: Claude Sonnet 5.5 (was claude-sonnet-4-6; before that
// claude-3-7-sonnet-20250219, retired 2026-02-19), the same id the coach AI
// uses (src/ai/coach/coach-ai.constants.ts). Pricing used by the daily spend
// cap: ROMAN_PRICE_PER_MTOK in roman.constants.ts.

/** The id Roman turns used before B-ROMANIQ-125 (priced below for ledger rows it wrote). */
export const ROMAN_MODEL_PREVIOUS = 'claude-sonnet-4-6';

/**
 * Roman turn thinking + effort (B-ROMANIQ-125). Sonnet 5.5 thinks before
 * answering when a request has no `thinking` field, which would delay the
 * first streamed word and spend ROMAN_MAX_OUTPUT_TOKENS on thinking. A turn
 * sends the lowest setting instead, `between_tools` (no up-front thinking;
 * with no tools the response is text only), as claude-sonnet-4-6 ran:
 * platform.claude.com/docs/en/models/sonnet-5-5/migration-guide "To turn off
 * up-front thinking on Claude Sonnet 5.5, send thinking: {type:
 * between_tools}". Effort `medium`: "For chat and other latency-sensitive
 * work, start with medium or low" (platform.claude.com/docs/en/
 * build-with-claude/effort); one level for the whole conversation, which
 * between_tools requires.
 */
export const ROMAN_TURN_THINKING: AnthropicThinkingBetweenTools = { type: 'between_tools' };
export const ROMAN_TURN_EFFORT = 'medium' as const;

/**
 * R11-00: the cheaper model for v1.1 background work (day summaries and note
 * extraction). Turns and playbook builds stay on ROMAN_MODEL_PHASE_1. Product
 * runtime model, chosen by the v1.1 plan; the operator confirms the id.
 */
export const ROMAN_MODEL_BACKGROUND = 'claude-haiku-4-5-20251001';

/**
 * List price per million tokens (input / output, USD) of every model Roman
 * calls. The background breaker prices each ledger row by its model; an
 * unknown model is priced at the highest listed rate (over-counts, never
 * under-counts).
 */
export const ROMAN_MODEL_PRICE_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  [ROMAN_MODEL_PHASE_1]: { input: 2, output: 10 },
  [ROMAN_MODEL_PREVIOUS]: { input: 3, output: 15 },
  [ROMAN_MODEL_BACKGROUND]: { input: 1, output: 5 },
};

/**
 * Factory provider. Returns `null` when no API key is configured so the
 * service can fail with a structured error (never a raw SDK crash) instead of
 * throwing at construction. Tests bind a fake client to the token directly,
 * which takes precedence over this factory.
 */
export const romanAnthropicClientProvider: Provider = {
  provide: ROMAN_ANTHROPIC_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AnthropicHandle | null => {
    const apiKey =
      config.get<string>('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      // No key — service surfaces ROMAN_UNAVAILABLE rather than crashing boot.
      return null;
    }
    // R2b — built by the egress module; RomanService only uses it through
    // AiEgressService (box-2 consent checked before every request).
    return createAnthropicClient(apiKey);
  },
};
