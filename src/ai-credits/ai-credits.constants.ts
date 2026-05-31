// Stream 1 — Coach AI Credits. Locked numbers per operator override
// 2026-05-28 (see canonical_docs/STREAM_1_AI_CREDITS_SPEC.md and the
// OPERATOR OVERRIDE block in docs/audits/ai_*_2026-05-27.md).
//
// These constants are read in service code, controllers, tests, and the
// admin tooling. Centralizing them prevents the kind of drift the
// 2026-05-28 override was correcting in the first place — the audit
// docs and the schema defaults disagreed, the operator had to override
// one of them, and we won't repeat that mistake.
//
// Env-var lookups read process.env at call time (not module-load) so
// tests can mutate the env per-case without re-importing the module.

/** Hard ceiling on actual Anthropic spend, in cents, per coach per period. */
export const COACH_AI_MAX_ACTUAL_CENTS_DEFAULT = 4000;

/**
 * Locked value multiplier. The displayed allowance shown to the coach is
 * base_actual_cents * value_multiplier. Decimal precision matters for the
 * banker's rounding step in applyCreditPack — see bankers-round.util.ts.
 */
export const COACH_AI_VALUE_MULTIPLIER_DEFAULT = 3.125;

/** Displayed allowance in cents (= 4000 * 3.125 = 12500 = $125). */
export const COACH_AI_BASE_DISPLAYED_CENTS_DEFAULT = 12500;

/** Pack tier face-values in cents. UI shows these three buttons + Custom. */
export const COACH_AI_PACK_TIERS_CENTS = [1000, 2500, 9900] as const;

/** Custom-pack bounds in cents. min $10, max $500. */
export const COACH_AI_CUSTOM_PACK_MIN_CENTS = 1000;
export const COACH_AI_CUSTOM_PACK_MAX_CENTS = 50_000;

/** Structured error code emitted on 402 (budget exhausted). */
export const COACH_AI_BUDGET_EXHAUSTED_CODE = 'COACH_AI_BUDGET_EXHAUSTED';

/** Capabilities that count against the budget. The gateway consults this set
 *  on every invoke; capabilities not listed bypass the budget check. */
export const COACH_AI_METERED_CAPABILITIES: ReadonlySet<string> = new Set([
  'draft.coach_message',
  'client_path_summary',
  'check_in_summary',
  'food_log_explain',
  'coach_brief_draft',
  'workout_program',
  'meal_plan',
  'weekly_insight',
  'client_chat',
  // PR-HK-4 — wearable AI insight capabilities. Additive declarations so
  // the gateway's existing pre-call budget gate + atomic post-call
  // recordUsage path meters them like every other real LLM call. The
  // client-side insight resolves to the subject's coach budget via
  // AiGatewayService.resolveBudgetCoachId (student.coach_id), and the
  // coach-side resolves to the head-coach budget via tenantCoachId. No
  // behavioural change to any existing capability.
  'wearable_insight.coach',
  'wearable_insight.client',
]);

/** Resolve the actual ceiling at call time so test env mutations stick. */
export function resolveMaxActualCents(): number {
  const raw = process.env.COACH_AI_MAX_ACTUAL_CENTS;
  if (!raw) return COACH_AI_MAX_ACTUAL_CENTS_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return COACH_AI_MAX_ACTUAL_CENTS_DEFAULT;
  return n;
}

/** Resolve the multiplier at call time (Decimal precision lives in the schema). */
export function resolveValueMultiplier(): number {
  const raw = process.env.COACH_AI_VALUE_MULTIPLIER;
  if (!raw) return COACH_AI_VALUE_MULTIPLIER_DEFAULT;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return COACH_AI_VALUE_MULTIPLIER_DEFAULT;
  return n;
}

/** Resolve the base displayed cents (= actual * multiplier) at call time. */
export function resolveBaseDisplayedCents(): number {
  return Math.round(resolveMaxActualCents() * resolveValueMultiplier());
}
