import { ApiProperty } from '@nestjs/swagger';
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

/**
 * OpenAPI response DTO for the `POST /v1/wearables/preferences` 200 body
 * (P2 #1). Documentation-only: the runtime contract is the Zod
 * `PreferenceResponseSchema` above (the controller `.parse()`s every payload
 * through it). The shape mirrors that schema EXACTLY; `updated_at` is the
 * persisted timestamp serialized as an ISO-8601 string.
 */
export class PreferenceResponseDto {
  @ApiProperty({
    enum: WearableMetricType,
    enumName: 'WearableMetricType',
    description: 'The metric whose read-precedence override was persisted.',
  })
  metric!: WearableMetricType;

  @ApiProperty({
    enum: WearableProvider,
    enumName: 'WearableProvider',
    description: 'The pinned preferred provider for that metric.',
  })
  preferred_provider!: WearableProvider;

  @ApiProperty({
    format: 'date-time',
    description: 'ISO-8601 timestamp the override was last written.',
    example: '2026-06-01T12:00:00.000Z',
  })
  updated_at!: string;
}
