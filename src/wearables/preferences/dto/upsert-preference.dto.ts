import { ApiProperty } from '@nestjs/swagger';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { z } from 'zod';

/**
 * PR-HK-3a — Zod schema for `POST /v1/wearables/preferences`.
 *
 * Validates the read-time precedence override write. `.strict()` rejects
 * unknown body keys (#8). `metric` + `preferred_provider` are required
 * nativeEnum values — an invalid metric/provider yields a field-level 400,
 * never a fail-open default.
 *
 * HK-6b — `target_user_id` is the OPTIONAL coach-on-behalf-of target. When
 * absent (or equal to the caller's id) the write is the caller's own row
 * (existing PR-HK-3a behavior). When present and different, the controller
 * authorizes the caller against the coach→client assignment relation before
 * the service writes the target's row. It is a UUID so a malformed value is a
 * clean 400 rather than reaching the authorization layer.
 */
export const UpsertPreferenceSchema = z
  .object({
    metric: z.enum(WearableMetricType),
    preferred_provider: z.enum(WearableProvider),
    target_user_id: z
      .string()
      .uuid({ message: 'target_user_id must be a UUID' })
      .optional(),
  })
  .strict();

export type UpsertPreferenceDto = z.infer<typeof UpsertPreferenceSchema>;

/**
 * Zod schema for the `:metric` path param on DELETE. Validates the enum so a
 * garbage segment is a clean 400 rather than a no-op delete the client could
 * mistake for success (#36 — no silent failure).
 *
 * The path param is intentionally kept to the metric enum ONLY. The HK-6b
 * coach-on-behalf target is a SEPARATE optional query param
 * (`DeletePreferenceQuerySchema`) rather than mixed into the path, so the
 * route shape stays `DELETE …/:metric`.
 */
export const DeletePreferenceParamSchema = z.object({
  metric: z.enum(WearableMetricType),
});

export type DeletePreferenceParam = z.infer<typeof DeletePreferenceParamSchema>;

/**
 * HK-6b — Zod schema for the OPTIONAL `?target_user_id=…` query param on
 * DELETE. Same coach-on-behalf semantics as the upsert body field: absent (or
 * self) = caller's own row; present + different = an authorized cross-user
 * delete. `.strict()` rejects unknown query keys; the UUID guard turns a
 * malformed value into a clean 400 before authorization runs.
 */
export const DeletePreferenceQuerySchema = z
  .object({
    target_user_id: z
      .string()
      .uuid({ message: 'target_user_id must be a UUID' })
      .optional(),
  })
  .strict();

export type DeletePreferenceQuery = z.infer<typeof DeletePreferenceQuerySchema>;

/** Locked 200 response shape for both POST (upsert) and the read. */
export const PreferenceResponseSchema = z
  .object({
    metric: z.enum(WearableMetricType),
    preferred_provider: z.enum(WearableProvider),
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
