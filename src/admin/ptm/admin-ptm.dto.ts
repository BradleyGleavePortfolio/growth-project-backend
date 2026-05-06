import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  PtmOutcomeTypeT,
  PtmRiskBucket,
} from '../../ptm/ptm.types';

// Phase 1C: OWNER-only PTM teaching DTOs.
//
// outcome_type values must stay 1:1 with the Postgres PtmOutcomeType enum
// (prisma/schema.prisma) and the PtmOutcomeTypeT union (ptm.types.ts). A
// silent drift here would let an admin label a client with a string the
// weighted engine (1D) does not know how to weight.
const OUTCOME_TYPES: ReadonlyArray<PtmOutcomeTypeT> = [
  'churned',
  'completed_90day',
  'upgraded',
  'referred',
  'milestone_hit',
  'dropped_off',
  'renewed',
];

const RISK_BUCKETS: ReadonlyArray<PtmRiskBucket> = ['green', 'amber', 'red'];

export class LabelOutcomeDto {
  @IsIn(OUTCOME_TYPES as unknown as string[])
  outcome_type!: PtmOutcomeTypeT;

  // Notes are persisted to ClientOutcome.notes for the labeller's own
  // reference. They are NEVER returned over the API to anyone — see
  // admin-ptm.service.ts: `select` clauses omit `notes` on every read
  // path. Cap at 2000 chars to keep the row bounded.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class RiskBoardQueryDto {
  @IsOptional()
  @IsIn(RISK_BUCKETS as unknown as string[])
  bucket?: PtmRiskBucket;

  // Cursor is the `computed_at` ISO timestamp of the last row from the
  // previous page; the next page returns rows with computed_at < cursor.
  @IsOptional()
  @IsISO8601()
  cursor?: string;

  // Page size. Default and clamp range applied server-side; we still
  // accept any int so the validator does not 400 on a generous value.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

export class OutcomeHistoryQueryDto {
  @IsOptional()
  @IsIn(OUTCOME_TYPES as unknown as string[])
  outcome_type?: PtmOutcomeTypeT;

  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

export const PTM_OUTCOME_TYPES_FOR_TEST = OUTCOME_TYPES;
