import { IsISO8601, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Shared cursor-pagination query DTO for all Coach Command Center list
 * endpoints. `cursor` is an ISO-8601 timestamp (created_at / computed_at
 * of the last row seen); `limit` is clamped server-side.
 */
export class CcPageQueryDto {
  /** ISO-8601 cursor — the `created_at` of the last row from the prior page. */
  @IsOptional()
  @IsISO8601()
  cursor?: string;

  /** Page size. Clamped to [1, 100] server-side. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

/**
 * Query DTO for the action-queue endpoint. `reason_code` filters to a
 * specific reason type (e.g. 'unread_message', 'missed_checkin', 'at_risk').
 */
export class ActionQueueQueryDto extends CcPageQueryDto {
  @IsOptional()
  @IsString()
  reason_code?: string;
}
