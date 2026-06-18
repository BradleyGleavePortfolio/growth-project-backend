// TM-9 — Job-hunter (/me/*) DTOs.
//
// PII boundary: every /me route returns the caller's OWN data, so identity may
// be echoed back to the owner. Responses are still explicit allow-list shapes —
// no raw Applicant/Application entity is ever spread onto the wire. Portfolio
// writes are bounded (URL allow-list + size caps live in portfolio-showcase.ts).

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

// Keyset (created_at, id) cursor query for /me/applications.
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

// PUT /me/portfolio — bounded showcase fields over existing Applicant columns.
// URL fields are re-validated in the service against the HTTPS allow-list; the
// class-validator caps here are the cheap first line (length + array bounds).
export class UpdatePortfolioDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  headline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  about?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1_024)
  intro_video_url?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PORTFOLIO_MAX_SAMPLE_PROGRAMS)
  @IsString({ each: true })
  @MaxLength(1_024, { each: true })
  sample_program_urls?: string[];
}

// POST /me/alerts/preferences — what listings the applicant wants surfaced.
export class AlertPreferencesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string | null;
}

// ── Response allow-list shapes ──────────────────────────────────────────────

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

// A specialty-matched listing alert. No hirer PII — public listing fields only.
export interface ListingAlertDto {
  listing_id: string;
  title: string;
  specialty: string | null;
  location: string | null;
  published_at: string | null;
}
