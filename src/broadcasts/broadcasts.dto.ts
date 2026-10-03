import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Shape checks only. The nested JSON (segment, recurrence, card) is validated
// field by field by parseSegment / parseRecurrence / parseCardSpec, which
// return coded errors (broadcast.segment_invalid, ...).

export class BroadcastPreviewDto {
  @ApiProperty({ description: 'Audience definition, see src/broadcasts/segment.ts' })
  @IsObject()
  segment!: Record<string, unknown>;
}

export class CardValidateDto {
  @ApiProperty({ description: '{ type, ref_id?, note? }' })
  @IsObject()
  card!: Record<string, unknown>;
}

export class UpsertBroadcastDto {
  @ApiProperty({
    maxLength: 4000,
    description: 'Message text. `{first_name}` is replaced per recipient.',
  })
  @IsString()
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({ description: '{ type, ref_id?, note? } or null' })
  @IsOptional()
  @IsObject()
  card?: Record<string, unknown> | null;

  @ApiProperty()
  @IsObject()
  segment!: Record<string, unknown>;

  @ApiProperty({ example: 'America/New_York' })
  @IsString()
  @MaxLength(64)
  timezone!: string;

  @ApiPropertyOptional({ description: 'ISO instant. Null sends now (or starts the series now).' })
  @IsOptional()
  @IsString()
  send_at?: string | null;

  @ApiPropertyOptional({
    description: '{ freq, interval?, local_time, by_weekday?, by_month_day?, until?, count? }',
  })
  @IsOptional()
  @IsObject()
  recurrence?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Bypasses recipient quiet hours. Use for time-critical notices only.',
  })
  @IsOptional()
  @IsBoolean()
  urgent?: boolean;

  @ApiPropertyOptional({ enum: ['draft', 'scheduled'] })
  @IsOptional()
  @IsIn(['draft', 'scheduled'])
  status?: 'draft' | 'scheduled';
}

export class ListBroadcastsQueryDto {
  @IsOptional()
  @IsIn(['draft', 'scheduled', 'sending', 'sent', 'paused', 'canceled', 'failed'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class SavedReplyDto {
  @ApiProperty({ maxLength: 60 })
  @IsString()
  @MaxLength(60)
  title!: string;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MaxLength(4000)
  body!: string;
}

export class SavedReplyPatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;
}

export class ListSavedRepliesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
}

export class ClientTagsDto {
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  tags!: string[];
}
