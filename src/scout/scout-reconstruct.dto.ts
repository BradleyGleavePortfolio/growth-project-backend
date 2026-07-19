import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The entity families the reconstruction engine can reconstruct (IMPORTER-H).
 * `clients` targets the invite-pending roster `Person`; `workouts` and
 * `client_history` target the generic canonical `ScoutReconstructedEntity`
 * table. Billing/messaging are deliberately absent — an unlisted family is a
 * 400 at validation and can never be reconstructed.
 */
export const RECONSTRUCT_FAMILY = {
  clients: 'clients',
  workouts: 'workouts',
  client_history: 'client_history',
} as const;

/** The closed allow-list of reconstructable families (fail-closed). */
export const RECONSTRUCT_ENTITY_TYPES = Object.values(RECONSTRUCT_FAMILY);

/**
 * Request to reconstruct one settled crawl intent's staged entities of a given
 * family into canonical records. coach_id is taken from the bearer identity
 * (never the body); the inputs are which settled intent to replay and which
 * family to reconstruct (defaults to `clients` for backward compatibility).
 */
export class ScoutReconstructDto {
  @ApiProperty({
    description: 'The settled crawl session whose staged entities to reconstruct.',
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
      'The staged entity family to reconstruct. Defaults to `clients`. An ' +
      'unsupported family (e.g. billing/messaging) is a 400 (fail closed).',
    enum: RECONSTRUCT_ENTITY_TYPES,
    default: RECONSTRUCT_FAMILY.clients,
    example: RECONSTRUCT_FAMILY.clients,
  })
  @IsOptional()
  @IsIn(RECONSTRUCT_ENTITY_TYPES)
  entity_type?: string;
}

/**
 * Honest reconciliation for one reconstruction pass. The invariant
 * `staged === reconstructed + skipped + failed` always holds; the numbers are
 * derived from the durable ledger, so a replay returns identical counts.
 */
export class ScoutReconstructResult {
  @ApiProperty({ description: 'The reconstructed intent.', example: 'intent_2026_07_09_abc123' })
  intent_id!: string;

  @ApiProperty({ description: 'Staged client entities considered.', example: 5 })
  staged!: number;

  @ApiProperty({ description: 'Entities mapped to a roster Person.', example: 3 })
  reconstructed!: number;

  @ApiProperty({
    description: 'Entities intentionally not reconstructed (with a reason).',
    example: 1,
  })
  skipped!: number;

  @ApiProperty({
    description: 'Entities that errored during reconstruction (with a reason).',
    example: 1,
  })
  failed!: number;
}

/** Env gate for the reconstruct endpoint. Off unless literally 'true'. */
export const FEATURE_SCOUT_RECONSTRUCT = 'FEATURE_SCOUT_RECONSTRUCT';

/**
 * The default reconstruction family and the one the roster read (IMPORTER-G)
 * projects. IMPORTER-H parametrizes the engine over {@link RECONSTRUCT_FAMILY};
 * this constant stays the backward-compatible default for callers that omit
 * `entity_type` and the fixed family the clients-only roster contract reads.
 */
export const RECONSTRUCT_ENTITY_TYPE = RECONSTRUCT_FAMILY.clients;

/**
 * Staged rows are read and reconstructed one deterministic page at a time
 * (ordered by source_id) so a large intent never loads its whole roster into
 * memory or issues an unbounded burst of queries. Mirrors the ingest side's
 * per-batch discipline (SCOUT_INGEST_MAX_ENTITIES = 500).
 */
export const RECONSTRUCT_PAGE_SIZE = 500;

/**
 * Hard ceiling on staged rows per reconstruction pass. A settled intent with
 * more staged `clients` than this is pathological (abuse or a runaway crawl),
 * so the pass fails closed — BEFORE any Person is minted or ledger row written —
 * rather than silently truncating or leaving a partial, ambiguous roster. The
 * bound is deterministic and enforced from a pre-flight count, so the honest
 * accounting invariant (staged === reconstructed + skipped + failed) is never
 * put at risk by an over-ceiling intent.
 */
export const RECONSTRUCT_MAX_ROWS = 10_000;

/** Ledger outcome vocabulary. */
export const RECONSTRUCT_STATUS = {
  reconstructed: 'reconstructed',
  skipped: 'skipped',
  failed: 'failed',
} as const;
