import { z } from 'zod';
import { WearableMetricBucket, WearableMetricType, WearableProvider } from '@prisma/client';
import { METRIC_BUCKET } from '../metric-bucket.map';

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

/**
 * S14 — typed 400 code returned when any sample in the batch carries a
 * `userId` key. The subject user is ALWAYS the authenticated JWT user; a body
 * `userId` is never honoured. The controller checks for this key BEFORE the
 * strict parse so an outdated client gets a precise, actionable code instead of
 * a generic unknown-key error.
 */
export const INGEST_USER_ID_FORBIDDEN_CODE = 'WEARABLES_INGEST_USER_ID_FORBIDDEN';

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
  })
  // S14 — the denormalized `bucket` column drives every bucket-filtered read
  // (the client Health and Sleep views). A sample whose bucket disagrees with
  // the canonical metric->bucket map would be stored but never shown, so it is
  // rejected here with a field-level 400 instead.
  .refine((sample) => METRIC_BUCKET[sample.metric] === sample.bucket, {
    message: 'bucket does not match the canonical bucket for metric',
    path: ['bucket'],
  });

export const IngestSamplesBodySchema = z
  .array(IngestSampleSchema)
  .min(1)
  .max(MAX_INGEST_BATCH);

/** Parsed, validated batch (Dates coerced, unknown keys rejected). */
export type IngestSamplesBody = z.infer<typeof IngestSamplesBodySchema>;
