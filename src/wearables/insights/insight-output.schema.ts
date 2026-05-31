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

// Empty / "not enough data" fallback payloads. Returned when the LLM call
// times out and there is no cache to fall back to (graceful degradation,
// audit criteria #35/#50). Deliberately low-confidence and metric-empty so
// the renderer shows a neutral "keep syncing" state, never a fabricated
// observation.
export const EMPTY_OBSERVATION = 'Not enough data yet — keep syncing.';

export function emptyCoachInsight(): CoachInsight {
  return {
    observation: EMPTY_OBSERVATION,
    hypothesis: EMPTY_OBSERVATION,
    suggested_action: 'Encourage another few days of syncing before acting.',
    suggested_message_draft:
      'Keep your wearable synced for a few more days and we will have a clearer picture.',
    confidence_level: 'i_think',
    source_metrics: [],
  } as CoachInsight; // source_metrics intentionally empty for the fallback path
}

export function emptyClientInsight(): ClientInsight {
  return {
    observation: EMPTY_OBSERVATION,
    norm_comparison: 'No comparison available yet.',
    intervention: 'Keep syncing for a few more days to unlock your insight.',
    optional_cta: null,
    confidence_level: 'i_think',
    source_metrics: [],
  } as ClientInsight; // source_metrics intentionally empty for the fallback path
}
