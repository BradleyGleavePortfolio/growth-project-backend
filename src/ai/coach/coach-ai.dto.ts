import {
  IsInt,
  IsOptional,
  IsString,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

// DTOs for the Coach AI v1 generation surface. All bounds chosen to keep
// a single generation comfortably under the Sonnet context window and to
// keep each AIDraft.inputContext + generatedPayload row well under the
// PG row size limit (~8KB target).

export class GenerateWorkoutProgramDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsInt()
  @Min(1)
  @Max(12)
  weeks!: number;

  @IsInt()
  @Min(1)
  @Max(7)
  daysPerWeek!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  focus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class GenerateMealPlanDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsInt()
  @Min(1)
  @Max(14)
  days!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class GenerateClientInsightDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  windowDays?: number;
}

export class EditDraftDto {
  // Free-shape patch; the service merges into generatedPayload at the
  // top level so the coach can tweak any field without us mirroring the
  // entire payload shape into a DTO.
  patch!: Record<string, unknown>;
}

export class RejectDraftDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
