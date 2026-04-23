import { IsNumber, IsOptional, IsDateString, Min, Max } from 'class-validator';

// SECURITY: allow-list DTO for water logging.
export class LogWaterDto {
  @IsNumber()
  @Min(0.01)
  @Max(20000)
  amount_ml!: number;

  @IsOptional()
  @IsDateString()
  date?: string;
}
