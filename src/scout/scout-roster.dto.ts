import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PersonState } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * IMPORTER-G — read contract for the reconstructed invite-pending roster
 * (D2, Op 59). This is the authoritative read bridge mobile PR-M3 consumes: it
 * projects one settled intent's canonical `Person` rows (materialized by
 * IMPORTER-F) joined to the honest `ScoutReconstructionLedger`, WITHOUT minting
 * any auth User/credential, duplicating state, or touching the existing
 * `/v1/coach/me/clients` roster contract. See
 * docs/decisions/2026-07-17-importer-g-reconstructed-roster-read.md.
 */

/** Default page size when the caller does not specify `limit`. */
export const ROSTER_DEFAULT_PAGE_SIZE = 50;

/**
 * Hard ceiling on rows per page. A bounded page keeps the join query and the
 * response body bounded regardless of roster size; an over-ceiling `limit` is a
 * 400 (fail closed) rather than a silently-truncated or unbounded read.
 */
export const ROSTER_MAX_PAGE_SIZE = 200;

/**
 * GET /api/scout/reconstruct/roster query. coach_id is taken from the bearer
 * identity (never a query/body field); the only inputs are which settled intent
 * to read and an opaque forward-only page cursor.
 */
export class ScoutRosterQueryDto {
  @ApiProperty({
    description: 'The settled crawl intent whose reconstructed roster to read.',
    minLength: 1,
    maxLength: 256,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  intent_id!: string;

  @ApiPropertyOptional({
    description:
      'Opaque forward-only page cursor returned as `page.next_cursor` by a prior ' +
      'call. Omit for the first page. A malformed cursor is a 400 (fail closed).',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    description: `Page size (1..${ROSTER_MAX_PAGE_SIZE}). Defaults to ${ROSTER_DEFAULT_PAGE_SIZE}.`,
    minimum: 1,
    maximum: ROSTER_MAX_PAGE_SIZE,
    default: ROSTER_DEFAULT_PAGE_SIZE,
    example: ROSTER_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ROSTER_MAX_PAGE_SIZE)
  limit?: number;
}

/**
 * Honest reconciliation for the intent, derived from the authoritative sources:
 * `staged` is the `ScoutIngestEntity` source count; `reconstructed`/`skipped`/
 * `failed` are read from the durable ledger. Mirrors the IMPORTER-F reconstruct
 * result exactly, so a partial pass is visible as
 * `staged > reconstructed + skipped + failed`.
 */
export class ScoutRosterAccountingDto {
  @ApiProperty({ description: 'Staged client entities considered for this intent.', example: 5 })
  staged!: number;

  @ApiProperty({ description: 'Entities mapped to a roster Person.', example: 3 })
  reconstructed!: number;

  @ApiProperty({ description: 'Entities intentionally not reconstructed.', example: 1 })
  skipped!: number;

  @ApiProperty({ description: 'Entities that errored during reconstruction.', example: 1 })
  failed!: number;
}

/**
 * One invite-pending roster record. Deliberately excludes email/PII beyond the
 * display_name a roster must render, and NEVER any billing field. `id` is the
 * opaque server-issued person id; provenance is (source_platform,
 * source_person_id) — the source platform's own record id, not a canonical key.
 */
export class ScoutRosterPersonDto {
  @ApiProperty({ description: 'Opaque server-issued roster person id.', format: 'uuid' })
  id!: string;

  @ApiProperty({
    description: 'Lifecycle state of the roster record.',
    enum: PersonState,
    example: PersonState.InvitePending,
  })
  state!: PersonState;

  @ApiProperty({ description: 'Source platform slug (provenance).', example: 'truecoach' })
  source_platform!: string;

  @ApiProperty({
    description: "Source platform's own record id (provenance, not a canonical key).",
    example: 'tc_client_9f831',
  })
  source_person_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Display name for the roster row, if the source provided one.',
    example: 'Jordan Ellis',
  })
  display_name!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the record was minted.' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the record last changed.' })
  updated_at!: string;
}

/** Deterministic forward-only pagination envelope. */
export class ScoutRosterPageDto {
  @ApiProperty({ description: 'Page size applied to this response.', example: 50 })
  limit!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page, or null when this is the last page.',
  })
  next_cursor!: string | null;

  @ApiProperty({ description: 'True when another page follows.', example: false })
  has_more!: boolean;
}

/** 200 body for GET /api/scout/reconstruct/roster. */
export class ScoutRosterResult {
  @ApiProperty({ description: 'The intent that was read.', example: 'intent_2026_07_09_abc123' })
  intent_id!: string;

  @ApiProperty({ type: ScoutRosterAccountingDto, description: 'Ledger-derived honest accounting.' })
  accounting!: ScoutRosterAccountingDto;

  @ApiProperty({
    type: [ScoutRosterPersonDto],
    description: 'Reconstructed invite-pending roster rows for this page (deterministic order).',
  })
  persons!: ScoutRosterPersonDto[];

  @ApiProperty({ type: ScoutRosterPageDto, description: 'Pagination envelope.' })
  page!: ScoutRosterPageDto;
}
