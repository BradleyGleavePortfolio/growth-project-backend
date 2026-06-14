import { z } from 'zod';
import {
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
} from '@prisma/client';

/**
 * P0-0A — Zod schema for `POST /v1/wearables/samples/ingest`.
 *
 * This is the on-device sample ingest contract. A mobile client (HealthKit /
 * Health Connect) normalizes its native records into this shape and POSTs a
 * batch. The route handler stamps the subject `userId` from the authenticated
 * JWT (NEVER from the body) and forwards to the shared IngestionService, so the
 * cloud-webhook and on-device lanes converge at the NormalizedSample[]
 * boundary (PR-HK-0).
 *
 * 50-Failures defenses:
 *  - #8 input validation: every field is typed + range-checked; `.strict()`
 *    REJECTS unknown keys (no silent extra-field acceptance) and a bad value
 *    yields a field-level 400, never a fail-open default.
 *  - the batch cap (max 2000) is enforced HERE so an oversized payload is
 *    rejected before it can touch the DB (defense in depth on top of the
 *    single-statement createMany).
 *  - the per-sample `startAt <= endAt` invariant is enforced at the schema
 *    layer (refine) AND again in IngestionService.validateSample — a malformed
 *    window can never reach the insert.
 */

/** Hard cap on a single ingest batch (LOCK — auditor gates). */
export const MAX_INGEST_BATCH = 2000;

export const IngestSampleSchema = z
  .object({
    connectionId: z.guid(),
    provider: z.enum(WearableProvider),
    metric: z.enum(WearableMetricType),
    bucket: z.enum(WearableMetricBucket),
    value: z.number().finite(),
    unit: z.string().min(1).max(40),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    sourceTz: z.string().max(80).nullable().optional(),
    sourceRecordId: z.string().max(180).nullable().optional(),
    rawRef: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((sample) => sample.startAt <= sample.endAt, {
    message: 'startAt must be before or equal to endAt',
    path: ['endAt'],
  });

export const IngestSamplesBodySchema = z
  .array(IngestSampleSchema)
  .min(1)
  .max(MAX_INGEST_BATCH);

/** Parsed, validated batch (Dates coerced, unknown keys rejected). */
export type IngestSamplesBody = z.infer<typeof IngestSamplesBodySchema>;
