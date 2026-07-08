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
  @IsString()
  @MaxLength(64)
  entity_type!: string;

  @IsInt()
  @Min(0)
  count_committed!: number;

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
  @IsString()
  @Length(1, 64)
  deviceId!: string;

  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ScoutProgressEntryDto)
  progress!: ScoutProgressEntryDto[];

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
  @IsString()
  @MaxLength(128)
  intent_id!: string;

  @IsIn(SCOUT_TERMINAL_STATUSES)
  terminal_status!: ScoutTerminalStatus;

  @IsOptional()
  @IsObject()
  final_counts?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error_summary?: string;
}
