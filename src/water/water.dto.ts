import { IsNumber, IsOptional, IsString, IsDateString, Min, Max, MaxLength } from 'class-validator';

// SECURITY: allow-list DTO for water logging.
export class LogWaterDto {
  @IsNumber()
  @Min(0.01)
  @Max(20000)
  amount_ml!: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  // WATER-WEIGHT-KEYS-BE (#191-D3): the phone's one-time key for this save, in
  // food's form (src/log/log.dto.ts LogFoodDto.client_uuid). A resend with the
  // same key returns the first row and stores nothing; no key = a new row.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  client_uuid?: string;
}
