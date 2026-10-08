import type { AnthropicThinkingBetweenTools } from '../../ai-egress/ai-egress.service';

// Coach AI v1 — pinned constants.
//
// COACH_AI_MODEL is the single source of truth for which Claude model the
// Coach AI engine talks to. Bump this here when promoting to a newer
// Sonnet; every adapter call, audit row, AICallLog row, and AIDraft row
// uses this value verbatim so a model migration is a one-line diff +
// regenerate-prompt-snapshots.
//
// B-ROMANIQ-125: Claude Sonnet 5.5 (was claude-sonnet-4-6). List price
// (docs.anthropic.com/en/docs/about-claude/models/overview):
//   * Input tokens:  $2.00 per 1M tokens
//   * Output tokens: $10.00 per 1M tokens
// If pricing changes, update both numbers. Cost is computed in
// AnthropicAdapter and written to AICallLog.costCents; the coach AI credit
// pool and the gateway meter price with the same two numbers.
export const COACH_AI_MODEL = 'claude-sonnet-5-5';
export const INPUT_USD_PER_MTOK = 2.0;
export const OUTPUT_USD_PER_MTOK = 10.0;

/**
 * CREDIT-METER-130 — the exact provider cost of one call in cents at the list
 * price above, fractions kept. The coach AI pool rounds once per period, so
 * debit paths pass this value unrounded.
 */
export function coachAiCostCents(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_USD_PER_MTOK + outputTokens * OUTPUT_USD_PER_MTOK) / 10_000;
}

// Sonnet 5.5 thinks by default when a request has no `thinking` field, and
// rejects `thinking: {type: 'disabled'}` and non-default temperature/top_p/
// top_k with a 400 (platform.claude.com/docs/en/models/sonnet-5-5/
// migration-guide). Every coach AI request therefore sends the lowest
// thinking setting (no up-front thinking, as on claude-sonnet-4-6, so
// max_tokens still covers only the reply) at `high` effort, the effort
// claude-sonnet-4-6 ran these calls at by default, and no sampling params.
export const COACH_AI_THINKING: AnthropicThinkingBetweenTools = { type: 'between_tools' };
export const COACH_AI_EFFORT = 'high' as const;

// Centralized capability strings — used by AICallLog.capability and the
// throttle decorators. Keeping these in one place so a typo in a string
// literal cannot quietly skew the cost dashboard.
export const COACH_AI_CAPABILITIES = {
  WORKOUT_PROGRAM: 'workout_program',
  MEAL_PLAN: 'meal_plan',
  INSIGHT: 'insight',
  CLIENT_CHAT_FALLBACK: 'client_chat_fallback',
  BOOT_PROBE: 'boot_probe',
} as const;

export type CoachAICapability =
  (typeof COACH_AI_CAPABILITIES)[keyof typeof COACH_AI_CAPABILITIES];
