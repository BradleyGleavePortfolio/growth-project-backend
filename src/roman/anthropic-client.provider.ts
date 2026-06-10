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
import Anthropic from '@anthropic-ai/sdk';

/** DI token for Roman's Anthropic client (brief §4). */
export const ROMAN_ANTHROPIC_CLIENT = 'ROMAN_ANTHROPIC_CLIENT';

/**
 * Phase 1 model (brief §4): cost-efficient Sonnet default. Phase 1.1 may
 * upgrade to opus for milestone moments — documented in the PR body. R31
 * note: this is the PRODUCT runtime model the deployed Roman calls, chosen by
 * the brief; it is unrelated to the agent runtime that authored this code.
 */
export const ROMAN_MODEL_PHASE_1 = 'claude-3-7-sonnet-20250219';

/**
 * Factory provider. Returns `null` when no API key is configured so the
 * service can fail with a structured error (never a raw SDK crash) instead of
 * throwing at construction. Tests bind a fake client to the token directly,
 * which takes precedence over this factory.
 */
export const romanAnthropicClientProvider: Provider = {
  provide: ROMAN_ANTHROPIC_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Anthropic | null => {
    const apiKey =
      config.get<string>('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      // No key — service surfaces ROMAN_UNAVAILABLE rather than crashing boot.
      return null;
    }
    return new Anthropic({ apiKey });
  },
};
