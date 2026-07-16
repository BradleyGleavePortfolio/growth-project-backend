import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request to reconstruct the staged `clients` entities of one settled crawl
 * intent into invite-pending roster records. coach_id is taken from the bearer
 * identity (never the body); the only input is which settled intent to replay.
 */
export class ScoutReconstructDto {
  @ApiProperty({
    description: 'The settled crawl session whose staged clients to reconstruct.',
    minLength: 1,
    maxLength: 256,
    example: 'intent_2026_07_09_abc123',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  intent_id!: string;
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

/** The only entity family this first proving pass reconstructs. */
export const RECONSTRUCT_ENTITY_TYPE = 'clients';

/** Ledger outcome vocabulary. */
export const RECONSTRUCT_STATUS = {
  reconstructed: 'reconstructed',
  skipped: 'skipped',
  failed: 'failed',
} as const;
