import { z } from 'zod';
import { WearableMetricType, WearableMetricBucket } from '@prisma/client';

// PR-HK-4 — locked output schemas for the dual-role AI insight surface.
//
// UNIFIED_BUILD_PLAN §"AI dual-role schema" pins TWO distinct payload
// shapes — one for the coach (a working hypothesis + a draft message the
// coach can approve/edit) and one for the client (a norm comparison + a
// concrete self-coaching intervention). The schemas are intentionally
// NOT shared: the coach-side fields (`hypothesis`, `suggested_message_draft`)
// MUST NEVER reach a client (privacy + RLS boundary, audit criteria #5), and
// the controller projects strictly per audience.
//
// Confidence labels are the calibrated vocabulary from UNIFIED_BUILD_PLAN
// §"Confidence calibration": i_think (50%) / fairly_sure (70%) /
// confident (85%) / certain (95%) / verified (100%). Renderers (PR-HK-5a/b)
// map these to a neutral chip — never green-for-good.

// The five calibrated confidence labels, shared by both audiences.
export const CONFIDENCE_LEVELS = [
  'i_think',
  'fairly_sure',
  'confident',
  'certain',
  'verified',
] as const;

export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

// The full WearableMetricType enum, surfaced as a Zod enum so the model
// can only cite metrics that actually exist in the taxonomy. Derived from
// the Prisma enum so the two never drift (single source of truth, #40).
const METRIC_VALUES = Object.values(WearableMetricType) as [
  WearableMetricType,
  ...WearableMetricType[],
];
export const SourceMetricSchema = z.nativeEnum(WearableMetricType);
export const SourceMetricsSchema = z.array(SourceMetricSchema).min(1);

// Keep METRIC_VALUES referenced so future schema edits that switch to a
// literal z.enum() have the source list to hand; also documents intent.
export const ALL_SOURCE_METRICS: readonly WearableMetricType[] = METRIC_VALUES;

// ── Coach payload ──────────────────────────────────────────────────────
// observation → hypothesis → suggested_action + a ready-to-edit message
// draft. The draft is NEVER auto-sent (PR-HK-6 owns the approval loop).
// .strict() — exact-field validation. The model is contractually bound to
// the coach field set; any extra key (e.g. a client-only field, or a
// prompt-injection attempt that smuggles in an unexpected key) is a hard
// validation failure rather than being silently stripped (audit R1 #2,
// schema-isolation #5).
export const CoachInsightSchema = z
  .object({
    observation: z.string().min(1).max(280),
    hypothesis: z.string().min(1).max(280),
    suggested_action: z.string().min(1).max(280),
    suggested_message_draft: z.string().min(1).max(1000),
    confidence_level: ConfidenceLevelSchema,
    source_metrics: SourceMetricsSchema,
  })
  .strict();
export type CoachInsight = z.infer<typeof CoachInsightSchema>;

// ── Client payload ─────────────────────────────────────────────────────
// observation → norm_comparison → intervention + an OPTIONAL CTA that
// deep-links into the app. The deep-link is constrained to the `tgp://`
// scheme so a model can never smuggle an http(s)/javascript link into a
// tappable affordance (defence-in-depth alongside the renderer).
// .strict() — exact-field validation, same rationale as the coach schema.
// A model response containing coach-only fields (hypothesis, etc.) on a
// client payload is rejected, never accepted-and-stripped.
export const ClientInsightSchema = z
  .object({
    observation: z.string().min(1).max(280),
    norm_comparison: z.string().min(1).max(280),
    intervention: z.string().min(1).max(280),
    optional_cta: z
      .object({
        label: z.string().min(1).max(40),
        deep_link: z.string().regex(/^tgp:\/\//),
      })
      .nullable(),
    confidence_level: ConfidenceLevelSchema,
    source_metrics: SourceMetricsSchema,
  })
  .strict();
export type ClientInsight = z.infer<typeof ClientInsightSchema>;

// Audience discriminator used as the cache-key prefix and the controller
// projection switch.
export type InsightAudience = 'coach' | 'client';

// Union for places that hold either payload (cache layer).
export type AnyInsight = CoachInsight | ClientInsight;

// ── Prompt-template I/O contract ───────────────────────────────────────
// Every bucket+audience prompt builder is a PURE function with this
// signature. It receives the already-fetched samples (the service owns
// data retrieval so tenant boundaries stay explicit — the prompt layer
// never touches the database), a small user-context object, and the
// bucket. It returns the system + user message pair the gateway expects.

// A trimmed sample shape the prompt builders consume. Decoupled from the
// Prisma row so prompts never accidentally embed sensitive columns.
export interface InsightSample {
  metric: WearableMetricType;
  value: number;
  unit: string;
  start_at: Date;
  end_at: Date;
}

export interface InsightUserContext {
  // Subject client's first name, if available (coach-side personalisation).
  firstName?: string;
  // Subject's age, used to age-adjust norm comparisons.
  age?: number;
  // Coach's first name, for the coach-side draft-message voice.
  coachFirstName?: string;
}

export interface BuildPromptInput {
  samples: InsightSample[];
  userContext: InsightUserContext;
  bucket: WearableMetricBucket;
}

export interface BuildPromptResult {
  system: string;
  user: string;
}

export type PromptBuilder = (input: BuildPromptInput) => BuildPromptResult;

// ── Empty / "not enough data" state ────────────────────────────────────
// Returned when the LLM call times out / fails and there is no cache to
// fall back to (graceful degradation, audit criteria #35/#50). R1 #3:
// the old fallback cast `source_metrics: []` onto the full insight types,
// which violates the `.min(1)` contract and hid the breach from
// TypeScript. Instead we model the empty state as its OWN strict schema
// with an explicit `is_empty: true` discriminator and a `source_metrics`
// array pinned to length 0 — honest provenance (we cite nothing because
// we computed nothing) and a clean render hook for the "keep syncing"
// empty state in PR-HK-5a/b.
export const EMPTY_OBSERVATION = 'Not enough data yet — keep syncing.';

export const EmptyInsightSchema = z
  .object({
    observation: z.literal(EMPTY_OBSERVATION),
    confidence_level: z.literal('i_think'),
    source_metrics: z.array(SourceMetricSchema).length(0),
    is_empty: z.literal(true),
  })
  .strict();
export type EmptyInsight = z.infer<typeof EmptyInsightSchema>;

// Public response contracts: a controller/service may return EITHER a full
// audience insight OR the empty state. Both branches are schema-validated
// (no casts), so a controller can `.parse(payload)` and be certain the
// wire response honours the locked contract on every path.
export const CoachInsightResponseSchema = z.union([
  CoachInsightSchema,
  EmptyInsightSchema,
]);
export type CoachInsightResponse = z.infer<typeof CoachInsightResponseSchema>;

export const ClientInsightResponseSchema = z.union([
  ClientInsightSchema,
  EmptyInsightSchema,
]);
export type ClientInsightResponse = z.infer<typeof ClientInsightResponseSchema>;

// Type guard so callers can branch on the empty state without reaching for
// the `is_empty` literal directly.
export function isEmptyInsight(
  value: CoachInsightResponse | ClientInsightResponse,
): value is EmptyInsight {
  return (value as Partial<EmptyInsight>).is_empty === true;
}

export function emptyInsight(): EmptyInsight {
  return {
    observation: EMPTY_OBSERVATION,
    confidence_level: 'i_think',
    source_metrics: [],
    is_empty: true,
  };
}
