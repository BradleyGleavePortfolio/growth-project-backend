// Coach AI v1 — pinned constants.
//
// COACH_AI_MODEL is the single source of truth for which Claude model the
// Coach AI engine talks to. Bump this here when promoting to a newer
// Sonnet; every adapter call, audit row, AICallLog row, and AIDraft row
// uses this value verbatim so a model migration is a one-line diff +
// regenerate-prompt-snapshots.
//
// Sonnet pricing as of 2026-05-13 (Anthropic public price card):
//   * Input tokens:  $3.00 per 1M tokens
//   * Output tokens: $15.00 per 1M tokens
// If pricing changes, update both numbers. Cost is computed in
// AnthropicAdapter and written to AICallLog.costCents.
export const COACH_AI_MODEL = 'claude-sonnet-4-6';
export const INPUT_USD_PER_MTOK = 3.0;
export const OUTPUT_USD_PER_MTOK = 15.0;

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
