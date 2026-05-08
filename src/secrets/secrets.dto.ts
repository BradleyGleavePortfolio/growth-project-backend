import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body accepted by POST /admin/secrets/rotation-log — records that an operator
 * has manually rotated a secret. The actual secret value is NEVER accepted or
 * stored here.
 */
export class RecordRotationDto {
  @ApiPropertyOptional({
    description:
      'Optional notes about this rotation (e.g. "routine 90-day", "incident response"). ' +
      'Do NOT include the secret value.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
