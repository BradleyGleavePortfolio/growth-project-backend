import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// IMPORTER-E — DTOs for the extension's cross-device progress + completion
// surface (DESIGN.md v0.3 §10 + §2 step 11). Field names match the
// status_snapshot the extension already broadcasts via chrome.runtime.sendMessage
// verbatim (intent_id / progress[] / lastError) so the backend does not force a
// re-shape on the extension side. ValidationPipe (whitelist +
// forbidNonWhitelisted) rejects any unknown field with a 400.

/** One per-entity progress line inside a status_snapshot. */
export class ScoutProgressEntryDto {
  @ApiProperty({
    description: 'Entity family this line reports on.',
    maxLength: 64,
    example: 'clients',
  })
  @IsString()
  @MaxLength(64)
  entity_type!: string;

  @ApiProperty({
    description: 'Entities committed so far for this family.',
    minimum: 0,
    example: 12,
  })
  @IsInt()
  @Min(0)
  count_committed!: number;

  @ApiProperty({ description: 'Best-effort total the crawler expects.', minimum: 0, example: 40 })
  @IsInt()
  @Min(0)
  total_estimated!: number;
}

/**
 * POST /api/scout/progress body — the status_snapshot the background worker
 * posts on every batch commit. Only the latest snapshot per (coach, intent)
 * is retained, so the array is bounded: a crawl walks a fixed, small set of
 * entity types (identity, clients, workouts, library, goals — see DESIGN §9).
 */
export class ScoutProgressDto {
  @ApiProperty({
    description: 'Crawl session id (snake_case outer envelope).',
    maxLength: 128,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MaxLength(128)
  intent_id!: string;

  /**
   * Client-generated stable identifier for the physical device running the
   * crawl (the same device id the extension already mints under R80). It is
   * part of the progress storage key so a coach mirroring one import from two
   * devices at once — e.g. laptop and phone — keeps two independent snapshot
   * rows instead of clobbering each other.
   *
   * deviceId alone is sufficient: intent_id is already generated per crawl
   * session, so the only overlap it does not disambiguate is the same intent
   * mirrored from two physical devices, which deviceId resolves. Two tabs on a
   * single device either share one crawl (one stream — coalescing is correct)
   * or mint distinct intent_ids, so a separate sessionId would add a key column
   * with no distinct collision to prevent.
   */
  @ApiProperty({
    description: 'Client-minted stable device id (camelCase); part of the progress storage key.',
    minLength: 1,
    maxLength: 64,
    example: 'dev_5f2c',
  })
  @IsString()
  @Length(1, 64)
  deviceId!: string;

  @ApiProperty({
    type: [ScoutProgressEntryDto],
    description: 'Per-entity progress lines.',
    maxItems: 64,
  })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ScoutProgressEntryDto)
  progress!: ScoutProgressEntryDto[];

  @ApiPropertyOptional({ description: 'Latest non-fatal error, if any.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  lastError?: string;
}

/** The three terminal states the extension reports on crawl settle. */
export const SCOUT_TERMINAL_STATUSES = ['success', 'partial', 'failed'] as const;
export type ScoutTerminalStatus = (typeof SCOUT_TERMINAL_STATUSES)[number];

/**
 * POST /api/scout/ingest/complete body — the terminal call fired once the
 * crawl settles. final_counts is an open per-entity tally kept as a bounded
 * JSON object; error_summary is present only for partial / failed runs.
 */
export class ScoutCompleteDto {
  @ApiProperty({
    description: 'Crawl session id (snake_case outer envelope).',
    maxLength: 128,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MaxLength(128)
  intent_id!: string;

  @ApiProperty({
    description: 'Terminal state the crawl settled into.',
    enum: SCOUT_TERMINAL_STATUSES,
    example: 'success',
  })
  @IsIn(SCOUT_TERMINAL_STATUSES)
  terminal_status!: ScoutTerminalStatus;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Optional per-entity final tally.',
  })
  @IsOptional()
  @IsObject()
  final_counts?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Human-readable summary for partial/failed runs.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error_summary?: string;
}

// States the READ surface can prove: `running` is derived from present evidence
// when no terminal row exists yet; the other three are the settled
// terminal_status reflected verbatim. `pending`/`cancelled` are deliberately
// absent (not representable). See docs/decisions/2026-07-15-importer-import-status-read.md.
export const SCOUT_READ_STATUSES = ['running', ...SCOUT_TERMINAL_STATUSES] as const;
export type ScoutReadStatus = (typeof SCOUT_READ_STATUSES)[number];

/** GET /api/scout/import/status query — one run, identified by its intent id. */
export class ScoutImportStatusQueryDto {
  @ApiProperty({ description: 'Crawl session id of the run to read.', maxLength: 128 })
  @IsString()
  @Length(1, 128)
  intent_id!: string;
}

/** One server-authoritative committed count per entity family. */
export class ScoutImportEntityCountDto {
  @ApiProperty({ description: 'Entity family.', example: 'clients' })
  entity_type!: string;

  @ApiProperty({ description: 'Entities actually committed (proof, not an estimate).', minimum: 0 })
  committed!: number;
}

// 200 body for GET /api/scout/import/status. Evidence-only: `entity_counts` are
// persisted-row counts, never the extension's `total_estimated`. The `status`
// itself conveys the terminal class (partial/failed) — no free-text error text.
export class ScoutImportStatusResult {
  @ApiProperty({ description: 'The intent id that was read.' })
  intent_id!: string;

  @ApiProperty({ description: 'Proven lifecycle state.', enum: SCOUT_READ_STATUSES })
  status!: ScoutReadStatus;

  @ApiProperty({ type: [ScoutImportEntityCountDto], description: 'Committed counts per entity.' })
  entity_counts!: ScoutImportEntityCountDto[];

  // type/format are explicit because the reflector cannot infer them from a
  // `string | null` union — without them @nestjs/swagger emits `type: object`,
  // which breaks client codegen (a Date field degrades to `any`/`object`).
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Earliest evidence timestamp the backend holds for this run (ISO-8601): ' +
      'the first committed entity when any exist, else the run lifecycle start, ' +
      'else the most recent progress snapshot. Null when no evidence is timestamped.',
  })
  started_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Settled at (ISO-8601); null while running.',
  })
  completed_at!: string | null;
}

/** 200 body: the settle call is acknowledged and echoes the intent id. */
export class ScoutCompleteResult {
  @ApiProperty({ description: 'Always true on a successful (idempotent) settle.', example: true })
  acknowledged!: true;

  @ApiProperty({
    description: 'The intent id that was settled.',
    example: 'intent_2026_07_09_abc123',
  })
  intent_id!: string;
}
