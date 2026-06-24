// TM-9 — Job-hunter (/me/*) DTOs. Responses are explicit allow-list shapes; no
// raw Applicant/Application entity is ever spread onto the wire.

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PORTFOLIO_MAX_SAMPLE_PROGRAMS } from './portfolio-showcase';

export class MyApplicationsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

// URL fields are re-validated in the service; caps here are the first line.
export class UpdatePortfolioDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  headline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  about?: string | null;

  // null is an explicit clear (@IsOptional skips validation for null), handled
  // by the service as "reset to []" (B-P0-2).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[] | null;

  // null and [] both clear the persisted URL; omission leaves it unchanged (B-P0-2).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PORTFOLIO_MAX_SAMPLE_PROGRAMS)
  @IsString({ each: true })
  @MaxLength(1_024, { each: true })
  sample_program_urls?: string[] | null;
}

export interface MyApplicationCardDto {
  id: string;
  listing_id: string;
  status: string;
  is_terminal: boolean;
  cover_note: string | null;
  created_at: string;
}

export interface MyApplicationsResponse {
  items: MyApplicationCardDto[];
  next_cursor: string | null;
}

export interface ProfileStrengthNudge {
  kind: string;
  message: string;
}

export interface ProfileStrengthDto {
  score: number;
  nudges: ProfileStrengthNudge[];
}
