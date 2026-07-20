import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RECONSTRUCT_ENTITY_TYPE, RECONSTRUCT_ENTITY_TYPES } from './scout-reconstruct.dto';

/**
 * IMPORTER-I — read contract for reconstructed NON-person canonical entities
 * (D2, site-agnostic). IMPORTER-H reconstructs the `workouts` and
 * `client_history` families into the ONE generic tenant-owned
 * `ScoutReconstructedEntity` table; this is the authoritative read bridge the
 * mobile consumer (PR-M4) uses to review those canonical rows for one settled
 * crawl intent.
 *
 * Deliberately NOT a second progress system: it returns canonical rows plus
 * honest per-page metadata (page_count + an opaque forward-only cursor), never a
 * full-collection total. The `clients` family targets the roster `Person` and is
 * served by the separate IMPORTER-G roster contract, so it is intentionally
 * absent from this endpoint's allow-list (a 400 pointing at the roster read,
 * fail-closed).
 */

/** Default page size when the caller does not specify `limit`. */
export const ENTITIES_DEFAULT_PAGE_SIZE = 50;

/**
 * Hard ceiling on rows per page. A bounded page keeps the ledger read and the
 * response body bounded regardless of intent size; an over-ceiling `limit` is a
 * 400 (fail closed) rather than a silently-truncated or unbounded read.
 */
export const ENTITIES_MAX_PAGE_SIZE = 200;

/**
 * The families this endpoint can review: exactly the families that write to the
 * generic canonical `ScoutReconstructedEntity` table — i.e. every reconstructable
 * family EXCEPT the person family (`clients`, which targets `Person` and is read
 * via the roster contract). Derived from {@link RECONSTRUCT_ENTITY_TYPES} so a
 * newly-registered non-person family is automatically reviewable, and `clients`
 * can never accidentally be served empty from a table it does not populate.
 */
export const ENTITY_REVIEW_FAMILIES: readonly string[] = RECONSTRUCT_ENTITY_TYPES.filter(
  (family) => family !== RECONSTRUCT_ENTITY_TYPE,
);

/**
 * GET /api/scout/reconstruct/entities query. coach_id is taken from the bearer
 * identity (never a query/body field); the inputs are which settled intent to
 * read, which non-person family, and an opaque forward-only page cursor.
 */
export class ScoutEntitiesQueryDto {
  @ApiProperty({
    description: 'The settled crawl intent whose reconstructed entities to read.',
    minLength: 1,
    maxLength: 256,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  intent_id!: string;

  @ApiProperty({
    description:
      'The reconstructed entity family to review. One of the non-person canonical ' +
      'families. `clients` is served by the roster read, not this endpoint; any ' +
      'unsupported family is a 400 (fail closed).',
    enum: ENTITY_REVIEW_FAMILIES,
    example: ENTITY_REVIEW_FAMILIES[0],
  })
  @IsString()
  @IsIn(ENTITY_REVIEW_FAMILIES)
  family!: string;

  @ApiPropertyOptional({
    description:
      'Opaque forward-only page cursor returned as `next_cursor` by a prior call ' +
      'for the SAME intent + family. Omit for the first page. A malformed or ' +
      'mismatched cursor is a 400 (fail closed).',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    description: `Page size (1..${ENTITIES_MAX_PAGE_SIZE}). Defaults to ${ENTITIES_DEFAULT_PAGE_SIZE}.`,
    minimum: 1,
    maximum: ENTITIES_MAX_PAGE_SIZE,
    default: ENTITIES_DEFAULT_PAGE_SIZE,
    example: ENTITIES_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ENTITIES_MAX_PAGE_SIZE)
  limit?: number;
}

/**
 * One reconstructed canonical entity row. Provenance is (source_platform,
 * source_id) — the source platform's own opaque record id, never a canonical
 * key. `client_source_id` is the soft provenance link to the owning client and
 * `label` a best-effort PII-minimal title. NEVER any email, billing, or
 * credential field.
 */
export class ReconstructedEntityDto {
  @ApiProperty({ description: 'Opaque server-issued canonical entity id.', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Source platform slug (provenance).', example: 'truecoach' })
  source_platform!: string;

  @ApiProperty({ description: 'The entity family this row belongs to.', example: 'workouts' })
  entity_type!: string;

  @ApiProperty({
    description: "Source platform's own record id (provenance, not a canonical key).",
    example: 'tc_workout_5c22a',
  })
  source_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Soft provenance link to the owning client's source record id, if any.",
    example: 'tc_client_9f831',
  })
  client_source_id!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Best-effort PII-minimal display label (a title/name), if the source provided one.',
    example: 'Upper Body — Week 3',
  })
  label!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the record was minted.' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the record last changed.' })
  updated_at!: string;
}

/** 200 body for GET /api/scout/reconstruct/entities. */
export class ScoutEntitiesResult {
  @ApiProperty({ description: 'The intent that was read.', example: 'intent_2026_07_09_abc123' })
  intent_id!: string;

  @ApiProperty({ description: 'The family that was read.', example: 'workouts' })
  family!: string;

  @ApiProperty({
    type: [ReconstructedEntityDto],
    description: 'Reconstructed canonical entity rows for this page (deterministic order).',
  })
  entities!: ReconstructedEntityDto[];

  @ApiProperty({
    description:
      'Number of rows returned in THIS page (entities.length). Deliberately NOT a ' +
      'full-collection total — this endpoint issues no unbounded count scan.',
    example: 50,
  })
  page_count!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page, or null when this is the last page.',
  })
  next_cursor!: string | null;
}
