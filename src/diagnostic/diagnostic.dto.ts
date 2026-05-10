import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * One answer in a 40-question submission.
 *
 * The validator enforces 1..40 on `question_id` and 1..5 on `answer`. The
 * service layer additionally enforces "exactly 40 distinct ids covering the
 * full catalog" — that's a structural rule, not a per-element one, and lives
 * with the scoring logic.
 */
export class DiagnosticAnswerDto {
  @ApiProperty({ minimum: 1, maximum: 40 })
  @IsInt()
  @Min(1)
  @Max(40)
  question_id!: number;

  @ApiProperty({ minimum: 1, maximum: 5, description: 'Likert 1=Strongly disagree .. 5=Strongly agree' })
  @IsInt()
  @Min(1)
  @Max(5)
  answer!: number;
}

export class SubmitDiagnosticDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false, minimum: 13, maximum: 110 })
  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(110)
  age?: number;

  @ApiProperty({ required: false, description: 'UTM-style source tag, e.g. web | mobile_signup | invite_link | lead_magnet' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  @ApiProperty({ type: [DiagnosticAnswerDto], minItems: 40, maxItems: 40 })
  @IsArray()
  @ArrayMinSize(40)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => DiagnosticAnswerDto)
  answers!: DiagnosticAnswerDto[];
}

/**
 * Returned by GET /diagnostic/questions. Strictly read-only; no PII.
 */
export interface DiagnosticQuestionPublic {
  id: number;
  section: 'income' | 'body' | 'lifestyle';
  text: string;
}

export interface DiagnosticCatalogResponse {
  version: string;
  scale_label: string;
  sections: Array<{ id: string; title: string; max_score: number; question_count: number }>;
  questions: DiagnosticQuestionPublic[];
}

export type DiagnosticBucket = 'stuck' | 'moving' | 'compounding';

export interface DiagnosticScores {
  /** Section sums, normalized to 0-100 percentages of section max. */
  income: number;
  body: number;
  lifestyle: number;
  /** Raw section sums (income: 15-75, body: 12-60, lifestyle: 13-65). */
  income_raw: number;
  body_raw: number;
  lifestyle_raw: number;
  /** Sum of all 40 raw answers, range 40-200 — matches the brief's overall band. */
  overall_raw: number;
}

export interface DiagnosticBuckets {
  income: DiagnosticBucket;
  body: DiagnosticBucket;
  lifestyle: DiagnosticBucket;
  overall: DiagnosticBucket;
  overall_headline: string;
}

export type RoadmapStatus = 'generating' | 'ready' | 'failed';

export interface RoadmapPayload {
  summary: string;
  top_strength: string;
  biggest_gap: string;
  ninety_day_focus: string;
  raw_text: string;
}

export interface SubmissionResponse {
  submission_id: string;
  scores: DiagnosticScores;
  buckets: DiagnosticBuckets;
  roadmap_status: RoadmapStatus;
}

export interface ResultResponse {
  submission: {
    id: string;
    submitted_at: string;
    scores: DiagnosticScores;
    buckets: DiagnosticBuckets;
  };
  roadmap: RoadmapPayload | null;
  roadmap_status: RoadmapStatus;
}
