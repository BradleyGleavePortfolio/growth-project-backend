// TM-8 — Hirer applicant-tracking DTOs.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PII BOUNDARY. Request DTOs are a strict allow-list; response shapes are    ║
// ║ the CandidateCard projection (candidate-card.dto.ts) or the redacted full  ║
// ║ detail below. No raw entity is ever spread, and no free-text field may     ║
// ║ echo applicant identity back across a hirer boundary.                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PIPELINE_STAGES, type PipelineStage } from './pipeline-stage';
import type { CandidateCardDto } from './candidate-card.dto';

export class ApplicantQueueQueryDto {
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

export class MoveStageDto {
  @IsIn(PIPELINE_STAGES as readonly string[])
  stage!: PipelineStage;
  // NOTE: no `note` field here. A stage-change note was accepted-then-discarded
  // (misleading). Real hirer-private notes ship in TM-8b via
  // POST /applicants/:applicantId/notes with AppendNoteDto.
}

export class AppendNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  note!: string;
}

// Paginated CandidateCard queue. `next_cursor` is null on the last page.
export interface ApplicantQueueResponse {
  items: CandidateCardDto[];
  next_cursor: string | null;
}

// Redacted full detail. Even on the detail endpoint, identity is minimised:
// email → domain only, phone → last 4. The applicant schema currently exposes
// no phone column, so `phone_last4` is reserved for the TM-8b unlock flow and is
// always null here.
export interface ApplicantDetailDto {
  application_id: string;
  first_name: string;
  last_initial: string;
  specialty: string | null;
  fit_score: number | null;
  stage: PipelineStage;
  applied_at: string;
  // NOTE: no `headline` field. headline is applicant-authored free text that can
  // contain email/phone/name — it is not in the TM-8 PII allow-list and must not
  // cross the hirer boundary. A future reveal/consent path would ship it
  // separately with redaction + tests.
  years_experience: number | null;
  email_domain: string | null;
  phone_last4: string | null;
}
