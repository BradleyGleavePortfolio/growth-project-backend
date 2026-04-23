import { IsNumber, IsOptional, IsString, IsDateString, Min, Max, MaxLength } from 'class-validator';

// SECURITY: allow-list DTO for weight logging.
export class LogWeightDto {
  @IsNumber()
  @Min(40)
  @Max(1500)
  weight_lbs!: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
