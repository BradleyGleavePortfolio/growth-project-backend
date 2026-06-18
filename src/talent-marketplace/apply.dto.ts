// TM-5 — Apply funnel DTOs.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PII BOUNDARY (the gate). Every response below is an EXPLICIT allow-list.   ║
// ║ Raw Applicant / Application / User entities are NEVER spread into a        ║
// ║ response — only the named fields here cross the wire. Identity columns     ║
// ║ (email, names) are echoed back ONLY to the owning applicant. Mobile TM-M5  ║
// ║ ApplyFlow + TM-W5 consume these shapes; do not widen without a PII review. ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Minimum-field account+profile create at Apply (Hick's law — ask the least;
// smart-default the rest). email + first/last name are the only required
// identity fields; everything else enriches the pre-coach profile optionally.
export class ApplyDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  first_name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  last_name!: string;

  // Optional pre-coach profile enrichment — smart-defaulted when omitted.
  @IsOptional()
  @IsString()
  @MaxLength(160)
  headline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  bio?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  certifications?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  years_experience?: number | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2_000)
  sample_program_url?: string | null;

  // Free-text note attached to the Application (PII — applicant authored).
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  cover_note?: string | null;

  // Per-mutation idempotency key (TM-4 ledger). The same key replays the same
  // Application instead of creating a second one. Defaulted server-side when
  // the client omits it so a double-tap on a flaky network is still safe.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotency_key?: string;
}

// Lightweight CRUD on the applicant's OWN pre-coach profile (reads-own).
export class UpdateApplicantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  first_name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  headline?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  bio?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  certifications?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  years_experience?: number | null;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2_000)
  sample_program_url?: string | null;
}

// Keyset (created_at, id) tuple cursor query for "my applications".
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

// ── Response allow-list DTOs (the PII gate boundary) ────────────────────────

// The applicant's view of their OWN profile. Echoes identity back to the owner
// only; never returned to any other principal.
export interface ApplicantProfileDto {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  headline: string | null;
  bio: string | null;
  specialties: string[];
  certifications: string[];
  years_experience: number | null;
  sample_program_url: string | null;
  created_at: string;
  updated_at: string;
}

// A single application card in the applicant's own list. No hirer PII; the
// fit signal is one primary chip (luxury doctrine — not a scorecard).
export interface MyApplicationCardDto {
  id: string;
  listing_id: string;
  status: string;
  fit: FitSignalDto;
  cover_note: string | null;
  created_at: string;
}

export interface MyApplicationsResponse {
  items: MyApplicationCardDto[];
  next_cursor: string | null;
}

// ONE primary two-way fit signal (a single chip) — desired vs offered.
export interface FitSignalDto {
  level: 'strong' | 'moderate' | 'exploratory';
  label: string;
  score: number;
}

// The Apply confirmation payload (luxury doctrine — peak-end closure). A
// definitive "you're in" with the created Application id, a celebratable
// status, the computed fit chip, and an explicit what's-next step. NEVER an
// empty 200. Carries the pre-coach account id forward for TM-12 auto-flip.
export interface ApplyConfirmationDto {
  application_id: string;
  applicant_id: string;
  account_id: string;
  status: string;
  fit: FitSignalDto;
  confirmation: {
    headline: string;
    message: string;
    next_step: string;
  };
}
