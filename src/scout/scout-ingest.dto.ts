import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsNotEmpty,
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

/**
 * A single crawled entity as emitted by the extension's makeEntity():
 *   { sourceId, sourcePlatform, payload, capturedAt }
 * Provenance (sourceId / sourcePlatform / capturedAt) lives at the TOP LEVEL
 * in camelCase — it is NOT nested inside payload. This mirrors the executable
 * producer (extractors/_interface.js makeEntity) verbatim, which is the R80
 * source of truth over any prose header comment.
 */
export class ScoutEntityDto {
  @ApiProperty({
    description: 'Stable per-record id from the source platform (camelCase, top-level provenance).',
    minLength: 1,
    maxLength: 256,
    example: 'tc_client_9f831',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  sourceId!: string;

  @ApiProperty({
    description: 'Slug of the platform the record was captured from (camelCase, top-level).',
    minLength: 1,
    maxLength: 256,
    example: 'truecoach',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  sourcePlatform!: string;

  // Strict ISO8601 with a mandatory "T" date/time separator. The extension's
  // makeEntity() emits new Date().toISOString(), so a strict check costs the
  // producer nothing while rejecting ambiguous or malformed timestamps at the
  // boundary — the service can then persist captured_at unconditionally with no
  // null-degrade path (R-IDEMP-1 keeps captured_at a value, never a key).
  @ApiProperty({
    description:
      'Strict ISO-8601 timestamp with a mandatory "T" separator (new Date().toISOString()).',
    format: 'date-time',
    example: '2026-07-09T18:30:00.000Z',
  })
  @IsNotEmpty()
  @IsISO8601({ strict: true, strictSeparator: true })
  capturedAt!: string;

  // The crawled record itself, kept as an opaque JSON object rather than a
  // nested validated DTO on purpose: the global ValidationPipe runs whitelist +
  // forbidNonWhitelisted, which would strip (and reject) the extractor-specific
  // fields the R80 contract permits. Validating payload as a leaf object
  // preserves those fields verbatim; the service applies a denylist redaction
  // before persistence.
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Opaque source record. Extractor-specific fields are preserved verbatim; ' +
      'the server strips a credential/prototype-pollution denylist before persistence.',
  })
  @IsObject()
  payload!: Prisma.InputJsonObject;
}

/**
 * The crawl envelope: `{ intent_id, entity_type, entities:[...] }`.
 * Matches extractors/_interface.js verbatim on field names (R80).
 */
export class ScoutIngestDto {
  @ApiProperty({
    description: 'Idempotency scope for this crawl session (snake_case outer envelope).',
    minLength: 1,
    maxLength: 256,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  intent_id!: string;

  @ApiProperty({
    description: 'Entity family carried by this batch (e.g. clients, workouts, library).',
    minLength: 1,
    maxLength: 128,
    example: 'clients',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  entity_type!: string;

  @ApiProperty({
    type: [ScoutEntityDto],
    description: `Crawled records for this batch (1..${SCOUT_INGEST_MAX_ENTITIES}).`,
    minItems: 1,
    maxItems: SCOUT_INGEST_MAX_ENTITIES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SCOUT_INGEST_MAX_ENTITIES)
  @ValidateNested({ each: true })
  @Type(() => ScoutEntityDto)
  entities!: ScoutEntityDto[];
}

/** 202 body: how many entities arrived and how many were replay no-ops. */
export class ScoutIngestResult {
  @ApiProperty({ description: 'Entities in the accepted envelope.', example: 42 })
  received!: number;

  @ApiProperty({
    description: 'Entities that produced no new row (idempotent replay).',
    example: 3,
  })
  deduped!: number;
}

/** PostHog event name emitted once per accepted batch. */
export const SCOUT_INGEST_EVENT = 'scout.ingest.received';

/** Env gate for the endpoint. Off unless explicitly set to the literal 'true'. */
export const FEATURE_SCOUT_INGEST = 'FEATURE_SCOUT_INGEST';
