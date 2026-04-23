import { IsOptional, IsString, MaxLength } from 'class-validator';

// SECURITY: allow-list DTOs for fasting endpoints.
export class StartFastDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  protocol?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class EndFastDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
