/**
 * R2b — AI egress data-subject declarations (D2 consent contract, box 2).
 *
 * Every request to an external AI provider declares WHOSE data is in it:
 *
 *   - `client_data`: the prompt carries information about one or more
 *     clients (their profile, logs, check-ins, messages, wearable data,
 *     anything derived from them). Every listed client must hold a LIVE box-2
 *     grant in the R2a ledger, read immediately before the request.
 *   - `no_client_data`: the prompt carries no client information at all. The
 *     reason is a closed list so a new exemption is a reviewed code change,
 *     never a free-text label.
 *
 * Only `anthropic` is covered by the box-2 consent copy ("processed by
 * Anthropic"). Client data never goes to any other processor.
 */

/** External AI processors the server can reach. */
export type AiProcessor = 'anthropic' | 'perplexity';

/** Processor named in the box-2 consent copy (CLIENT_AI_CONSENT_PROCESSOR). */
export const CONSENTED_AI_PROCESSOR: AiProcessor = 'anthropic';

/** Who asked: decides which refusal message is shown. */
export type AiConsentAudience = 'coach' | 'client';

/**
 * Closed list of reasons a provider request may carry no client data.
 * Each one is pinned by a test that proves the prompt has no client fields.
 *
 *   health_probe                 boot probe, fixed "ping" text
 *   fixed_template               fixed server text chosen from a closed enum
 *                                (first-win copy); no user value is sent
 *   coach_own_scope              a coach or owner talking about their own
 *                                work with no client loaded by the server
 *                                (Roman coach chat, gateway coach-self calls)
 *   coach_business_metrics       head-coach brief: team headcounts and money
 *                                totals only, no client identifier, no health
 *                                or activity field
 *   deidentified_prospect_scores public pre-signup diagnostic: section scores
 *                                and fixed question text, no identifier
 */
export const NO_CLIENT_DATA_REASONS = [
  'health_probe',
  'fixed_template',
  'coach_own_scope',
  'coach_business_metrics',
  'deidentified_prospect_scores',
] as const;
export type NoClientDataReason = (typeof NO_CLIENT_DATA_REASONS)[number];

/**
 * Consent scope a client-data send needs (client-ai-v5). 'base': every day-1
 * AI path (a live client-ai-v4 or client-ai-v5 grant). 'memory': Roman v1.1
 * notes, summaries and coach-method learning (a live client-ai-v5 grant for
 * EVERY listed client). Absent means 'base'.
 */
export type AiConsentScope = 'base' | 'memory';

export type AiDataSubject =
  | {
      readonly kind: 'client_data';
      /** Every client whose information is in the prompt. Never empty. */
      readonly clientIds: readonly string[];
      readonly audience: AiConsentAudience;
      readonly scope?: AiConsentScope;
    }
  | { readonly kind: 'no_client_data'; readonly reason: NoClientDataReason };

/**
 * Build a client-data subject (deduplicated, empty ids dropped). A 'base'
 * subject carries no scope field (identical to the pre-v5 shape).
 */
export function clientDataSubject(
  clientIds: string | readonly string[],
  audience: AiConsentAudience,
  scope: AiConsentScope = 'base',
): AiDataSubject {
  const list = typeof clientIds === 'string' ? [clientIds] : clientIds;
  const unique = [...new Set(list.filter((id) => typeof id === 'string' && id.length > 0))];
  return scope === 'memory'
    ? { kind: 'client_data', clientIds: unique, audience, scope }
    : { kind: 'client_data', clientIds: unique, audience };
}

export function noClientDataSubject(reason: NoClientDataReason): AiDataSubject {
  return { kind: 'no_client_data', reason };
}

/**
 * Short, stable label for the call site (logs and tests). Never contains
 * user data.
 */
export type AiEgressSurface =
  | 'roman.chat'
  | 'ai.client_chat'
  | 'coach_ai.workout_program'
  | 'coach_ai.meal_plan'
  | 'coach_ai.insight'
  | 'coach_ai.health_probe'
  | 'coach.brief'
  | 'coach.churn_draft'
  | 'gateway'
  | 'wearables.insight'
  | 'first_win'
  | 'diagnostic.roadmap';
