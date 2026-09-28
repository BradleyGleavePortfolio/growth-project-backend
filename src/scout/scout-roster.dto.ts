import { SCOUT_CURSOR_MAX_LENGTH } from './scout-cursor';
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
 * S8-F — the only ledger `target_kind` the roster materializes (besides the
 * legacy NULL kind, which means the same pre-S8-B Person target). Mirrors the
 * ledger's person kind value written by the clients writer; any other kind is
 * never joined to Person here.
 */
export const ROSTER_TARGET_KIND = 'person';

/**
 * S8-F introduced this response-level qualifier fixed `true`: the roster was the
 * interim Person bridge and imported clients were NOT visible in the coach
 * roster (native contract §4.1). S8-D2 (docs/decisions/2026-09-26-s8d-person-link.md
 * §5.2) landed that visibility — `GET /api/coach/clients/imported` lists the
 * coach's imported Persons as "imported, not yet joined" — so the qualifier is
 * now fixed `false`. The field itself stays in the response shape until mobile
 * no longer reads it (retirement is a later contract regen); it is never derived
 * from row contents or counts.
 */
export const ROSTER_BRIDGE_PENDING = false as const;

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
      'call. Omit for the first page. Accepts legacy, scoped v2 and scoped v3 tokens; emits scoped v3 (row-precise). ' +
      'A malformed cursor, or a legacy cursor that no longer resolves to one reconstructed ' +
      'row, is a 400 (fail closed): restart pagination from the first page.',
    maxLength: SCOUT_CURSOR_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SCOUT_CURSOR_MAX_LENGTH)
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
  @ApiProperty({
    description:
      'Staged entities of this intent that classify to the roster (clients) family by their ' +
      "source's own (source_platform, step token) pair through the source mapping registry " +
      '(legacy token == family included).',
    example: 5,
  })
  staged!: number;

  @ApiProperty({ description: 'Entities mapped to a roster Person.', example: 3 })
  reconstructed!: number;

  @ApiProperty({ description: 'Entities intentionally not reconstructed.', example: 1 })
  skipped!: number;

  @ApiProperty({ description: 'Entities that errored during reconstruction.', example: 1 })
  failed!: number;

  @ApiProperty({
    description:
      'Staged entities of this intent whose (source_platform, step token) no source mapping ' +
      'spec classifies to ANY family (unregistered platform or unmapped token). Counted here ' +
      'so an unreadable staged row is never a silent zero; such rows are never listed. Staged ' +
      'rows of other families are not counted here.',
    example: 0,
  })
  unclassified!: number;
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

  @ApiProperty({ description: 'Source platform slug (provenance).', example: 'example-site' })
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

  @ApiProperty({
    type: Boolean,
    description:
      'Always false since S8-D2: imported Persons are visible in the coach roster as ' +
      '"imported, not yet joined" (GET /api/coach/clients/imported). No principal is minted ' +
      'here; these rows are still the reconstructed Person records, not User accounts. ' +
      'Present on empty pages too. Kept only until mobile stops reading it; then retired.',
    example: false,
  })
  roster_bridge_pending!: boolean;
}
