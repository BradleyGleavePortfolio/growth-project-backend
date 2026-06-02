import { WearableMetricBucket, WearableMetricType } from '@prisma/client';
import { z } from 'zod';

/**
 * PR-HK-3a — Zod schema for `GET /v1/wearables/samples`.
 *
 * 50-Failures defenses:
 *  - #8 input validation: every field is typed + range-checked; `.strict()`
 *    REJECTS unknown query keys (no silent extra-param acceptance) and a
 *    bad value yields a field-level 400, never a fail-open default.
 *  - the 90-day window cap is enforced HERE (schema-level superRefine) so the
 *    service never even issues an unbounded range query (defense in depth on
 *    top of the SQL index).
 *
 * Booleans/enums arrive as strings on the query string; the schema coerces
 * them explicitly (no implicit truthiness — `'false'` must mean false).
 */

/** Hard cap on the queryable window (LOCK — auditor gates). */
export const MAX_WINDOW_DAYS = 90;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Query-string boolean: accepts only the literal strings 'true' | 'false'. */
const QueryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

/** ISO-8601 datetime → Date, rejecting anything Date can't parse. */
const IsoDateTime = z
  .string()
  .datetime({ offset: true, message: 'must be an ISO-8601 datetime' })
  .transform((s) => new Date(s));

export const GetSamplesQuerySchema = z
  .object({
    bucket: z.nativeEnum(WearableMetricBucket),
    metric: z.nativeEnum(WearableMetricType).optional(),
    from: IsoDateTime,
    to: IsoDateTime,
    clientId: z.string().uuid({ message: 'clientId must be a UUID' }).optional(),
    granularity: z.enum(['raw', 'hour', 'day']).default('raw'),
    preferredOnly: QueryBoolean.default('true'),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.from.getTime() > val.to.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must be <= to',
      });
    }
    if (val.to.getTime() - val.from.getTime() > MAX_WINDOW_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `window (to - from) must be <= ${MAX_WINDOW_DAYS} days`,
      });
    }
  });

/** Parsed, validated query (Dates, defaults applied). */
export type GetSamplesQuery = z.infer<typeof GetSamplesQuerySchema>;
