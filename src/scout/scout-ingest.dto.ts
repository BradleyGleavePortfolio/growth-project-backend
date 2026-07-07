import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Ceiling on entities per batch. The extension's background worker chunks
// crawls into batches; a batch larger than this is treated as an oversized
// payload and rejected with 400 rather than silently accepted, bounding both
// request memory and the size of a single ON CONFLICT insert.
export const SCOUT_INGEST_MAX_ENTITIES = 500;

/** A single crawled entity: `{ source_id, payload }`. */
export class ScoutEntityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  source_id!: string;

  // The self-describing provenance envelope, kept as an opaque JSON object
  // rather than a nested validated DTO on purpose: the global ValidationPipe
  // runs whitelist + forbidNonWhitelisted, which would strip (and reject) the
  // extractor-specific fields the R80 contract permits beyond sourcePlatform /
  // capturedAt. Validating payload as a leaf object preserves those fields
  // verbatim; the two required self-describing fields are enforced in
  // ScoutIngestService.
  @IsObject()
  payload!: Prisma.InputJsonObject;
}

/**
 * The crawl envelope: `{ intent_id, entity_type, entities:[...] }`.
 * Matches extractors/_interface.js verbatim on field names (R80).
 */
export class ScoutIngestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  intent_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  entity_type!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SCOUT_INGEST_MAX_ENTITIES)
  @ValidateNested({ each: true })
  @Type(() => ScoutEntityDto)
  entities!: ScoutEntityDto[];
}

/** 202 body: how many entities arrived and how many were replay no-ops. */
export interface ScoutIngestResult {
  received: number;
  deduped: number;
}

/** PostHog event name emitted once per accepted batch. */
export const SCOUT_INGEST_EVENT = 'scout.ingest.received';

/** Env gate for the endpoint. Off unless explicitly set to the literal 'true'. */
export const FEATURE_SCOUT_INGEST = 'FEATURE_SCOUT_INGEST';
