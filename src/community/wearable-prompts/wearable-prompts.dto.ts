import { WearableMetricType } from '@prisma/client';
import { z } from 'zod';

/**
 * v3-4 wearable-aware coaching-prompts DTOs (Zod-first, mirroring the search +
 * voice slices). The coach-facing read/list shapes carry NO raw health values
 * to the wire beyond the human-readable prompt text the coach is authorized to
 * see; the source-audit rows expose the metric KEY + observed value to the
 * COACH only (never to a client — enforced by the coach-only RLS + service).
 */

/** Lookback window for metric-trend computation (brief §thresholds): 14 days. */
export const WEARABLE_LOOKBACK_DAYS = 14;
/** Cooldown per (coachId, clientId, metricKey): 24h (brief §thresholds). */
export const WEARABLE_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** The consent scope a client must have granted before any prompt generates. */
export const WEARABLE_INSIGHTS_CONSENT_SCOPE = 'wearable.insights';

/**
 * The curated metric keys v3-4 generates prompts from. A subset of
 * WearableMetricType — the recovery/sleep/strain signals a coach acts on. The
 * generator rejects a metric outside this allowlist (no speculative metrics).
 */
export const PROMPT_METRIC_ALLOWLIST = [
  WearableMetricType.HRV_MS,
  WearableMetricType.RECOVERY_SCORE,
  WearableMetricType.READINESS_SCORE,
  WearableMetricType.SLEEP_EFFICIENCY_PCT,
  WearableMetricType.SLEEP_TOTAL_MIN,
  WearableMetricType.RESTING_HEART_RATE_BPM,
] as const;

export type PromptMetricKey = (typeof PROMPT_METRIC_ALLOWLIST)[number];

const MetricEnum = z.enum(PROMPT_METRIC_ALLOWLIST);

/** Generate prompts for a coach's client across the allowlisted metrics. */
export const GeneratePromptsBodySchema = z
  .object({
    clientId: z.guid({ message: 'clientId must be a UUID' }),
    // Optional: restrict generation to a single metric.
    metricKey: MetricEnum.optional(),
  })
  .strict();

export type GeneratePromptsBody = z.infer<typeof GeneratePromptsBodySchema>;

/** List a coach's active (non-dismissed) prompts in a workspace. */
export const ListPromptsQuerySchema = z
  .object({
    clientId: z.guid({ message: 'clientId must be a UUID' }).optional(),
    includeDismissed: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ListPromptsQuery = z.infer<typeof ListPromptsQuerySchema>;

/**
 * A single prompt source-audit row in the response. Exposes which real
 * WearableSample drove the prompt (sampleId), the metric key, and the observed
 * value — coach-only (the whole prompt object is coach-only).
 */
export const PromptSourceViewSchema = z
  .object({
    // sampleId is a real WearableSample UUID; pin the UUID contract so a
    // regression to a non-UUID id fails response validation (PR #405 N4).
    sampleId: z.guid({ message: 'sampleId must be a UUID' }),
    metricKey: z.string(),
    observedValue: z.number(),
  })
  .strict();

export type PromptSourceView = z.infer<typeof PromptSourceViewSchema>;

/** A coach-facing prompt view. NEVER returned to a client. */
export const PromptViewSchema = z
  .object({
    // F1 re-keyed these ids onto UUIDs; pin the UUID contract here so a
    // regression that emitted a cuid (or any non-UUID) prompt id is caught by
    // response validation, not only by the controller's ParseUUIDPipe path
    // params (PR #405 re-audit N4).
    id: z.guid({ message: 'id must be a UUID' }),
    workspaceId: z.guid({ message: 'workspaceId must be a UUID' }),
    coachId: z.guid({ message: 'coachId must be a UUID' }),
    clientId: z.guid({ message: 'clientId must be a UUID' }),
    metricKey: z.string(),
    promptText: z.string(),
    sources: z.array(PromptSourceViewSchema),
    generatedAt: z.string(),
    dismissedAt: z.string().nullable(),
    actedOnAt: z.string().nullable(),
  })
  .strict();

export type PromptView = z.infer<typeof PromptViewSchema>;

export const PromptListResponseSchema = z
  .object({
    version: z.literal(1),
    prompts: z.array(PromptViewSchema),
  })
  .strict();

export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;

export const GenerateResponseSchema = z
  .object({
    version: z.literal(1),
    generated: z.array(PromptViewSchema),
    // Metrics skipped (with a bounded reason) — never raw values.
    skipped: z.array(
      z
        .object({
          metricKey: z.string(),
          reason: z.enum([
            'cooldown',
            'no_consent',
            'degraded_connector',
            'no_data',
            'no_signal',
          ]),
        })
        .strict(),
    ),
  })
  .strict();

export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
