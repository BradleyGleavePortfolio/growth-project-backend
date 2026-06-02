import { WearableMetricType, WearableProvider } from '@prisma/client';
import { z } from 'zod';

/**
 * PR-HK-3a — Zod schema for `POST /v1/wearables/preferences`.
 *
 * Validates the read-time precedence override write. `.strict()` rejects
 * unknown body keys (#8). Both fields are required nativeEnum values — an
 * invalid metric/provider yields a field-level 400, never a fail-open default.
 */
export const UpsertPreferenceSchema = z
  .object({
    metric: z.nativeEnum(WearableMetricType),
    preferred_provider: z.nativeEnum(WearableProvider),
  })
  .strict();

export type UpsertPreferenceDto = z.infer<typeof UpsertPreferenceSchema>;

/**
 * Zod schema for the `:metric` path param on DELETE. Validates the enum so a
 * garbage segment is a clean 400 rather than a no-op delete the client could
 * mistake for success (#36 — no silent failure).
 */
export const DeletePreferenceParamSchema = z.object({
  metric: z.nativeEnum(WearableMetricType),
});

export type DeletePreferenceParam = z.infer<typeof DeletePreferenceParamSchema>;

/** Locked 200 response shape for both POST (upsert) and the read. */
export const PreferenceResponseSchema = z
  .object({
    metric: z.nativeEnum(WearableMetricType),
    preferred_provider: z.nativeEnum(WearableProvider),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type PreferenceResponse = z.infer<typeof PreferenceResponseSchema>;
