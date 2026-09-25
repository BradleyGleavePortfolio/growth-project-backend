import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length } from 'class-validator';

// S7-L2 — DTOs of the two lifecycle routes (decision §6). The 409 envelopes are documented
// on the controller with `envelopeWithCode(RUN_CONFLICT_CODES)` so the OpenAPI enums derive
// from the one catalog in reason-codes.ts, never re-typed here.

/** POST /api/scout/runs/start body. */
export class ScoutRunStartDto {
  @ApiProperty({
    description:
      'Server setup intent (ImportIntent.id) to start the server-owned run for. Must be owned ' +
      'by the calling coach, paired and not superseded.',
    format: 'uuid',
  })
  @IsString()
  @IsUUID('all')
  import_intent_id!: string;
}

/** POST /api/scout/runs/cancel body. */
export class ScoutRunCancelDto {
  @ApiProperty({
    description: 'Intent id of the run to cancel (the text form of the server setup intent).',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  intent_id!: string;
}

/** 200 body of Start (identical on the idempotent duplicate). */
export class ScoutRunStartResult {
  @ApiProperty({ description: 'The run key: the text form of import_intent_id.' })
  intent_id!: string;

  @ApiProperty({ description: 'Always `server` for a started run.', enum: ['server'] })
  mode!: 'server';

  @ApiProperty({ description: 'Always `discovering` at Start.', enum: ['discovering'] })
  phase!: 'discovering';

  @ApiProperty({ description: 'Fence epoch; 1 until the run is fenced.', minimum: 1, example: 1 })
  execution_epoch!: number;

  @ApiProperty({ type: String, format: 'date-time', description: 'Server-owned start (set once).' })
  accepted_start_at!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'accepted_start_at + SCOUT_RUN_DEADLINE_MS; enforced lazily, never by a timer.',
  })
  deadline_at!: string;
}

/** 200 body of cancel (identical when the run was already cancelled). */
export class ScoutRunCancelResult {
  @ApiProperty({ description: 'The intent id that was cancelled.' })
  intent_id!: string;

  @ApiProperty({ description: 'Always `cancelled`.', enum: ['cancelled'] })
  status!: 'cancelled';

  @ApiProperty({
    description: 'Fence epoch after the cancel (strictly greater than before the fence).',
    minimum: 2,
  })
  execution_epoch!: number;
}
