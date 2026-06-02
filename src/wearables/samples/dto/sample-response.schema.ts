import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';
import { z } from 'zod';

/**
 * PR-HK-3a — Zod schema for the `GET /v1/wearables/samples` 200 response.
 *
 * This is the LOCKED wire contract (UNIFIED_BUILD_PLAN §2 UX↔Code Contract).
 * The mobile `wearablesSamplesApi.ts` client mirrors this shape exactly;
 * HK-3b imports the same client and MUST NOT widen it. The controller
 * `.parse()`s its payload through this schema before returning so a
 * contract-violating shape can never reach the wire (defense in depth).
 *
 * Datetimes are serialized as ISO-8601 strings (the controller converts the
 * service's `Date`s via `.toISOString()`), so the schema validates strings.
 */

const IsoString = z.string().datetime({ offset: true });

const SampleSchema = z.object({
  start_at: IsoString,
  end_at: IsoString,
  value: z.number(),
  provider: z.nativeEnum(WearableProvider),
});

const AggBucketSchema = z.object({
  bucket_start: IsoString,
  bucket_end: IsoString,
  agg: z.number(),
  count: z.number().int().nonnegative(),
});

const SeriesSchema = z.object({
  metric: z.nativeEnum(WearableMetricType),
  unit: z.string(),
  /** null when the series has zero samples in the window. */
  provider_used: z.nativeEnum(WearableProvider).nullable(),
  sample_count: z.number().int().nonnegative(),
  samples: z.array(SampleSchema),
  /** present only when granularity != 'raw'. */
  buckets: z.array(AggBucketSchema).optional(),
});

export const FRESHNESS_STATUSES = [
  'current',
  'needs_attention',
  'never_synced',
] as const;

const FreshnessProviderSchema = z.object({
  provider: z.nativeEnum(WearableProvider),
  last_synced_at: IsoString.nullable(),
  status: z.enum(FRESHNESS_STATUSES),
});

export const SamplesResponseSchema = z
  .object({
    version: z.literal(1),
    user_id: z.string(),
    bucket: z.nativeEnum(WearableMetricBucket),
    window: z.object({ from: IsoString, to: IsoString }),
    series: z.array(SeriesSchema),
    freshness: z.object({ providers: z.array(FreshnessProviderSchema) }),
  })
  .strict();

export type SamplesResponse = z.infer<typeof SamplesResponseSchema>;
export type SampleSeries = z.infer<typeof SeriesSchema>;
export type SampleDatum = z.infer<typeof SampleSchema>;
export type AggBucket = z.infer<typeof AggBucketSchema>;
export type FreshnessProvider = z.infer<typeof FreshnessProviderSchema>;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];
