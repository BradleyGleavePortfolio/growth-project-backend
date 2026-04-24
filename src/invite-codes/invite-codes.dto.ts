import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// SECURITY: allow-list DTOs. Global ValidationPipe has whitelist=true and
// forbidNonWhitelisted=true, so any extra field (e.g. coach_id) is rejected —
// coaches cannot mint codes on behalf of other coaches via mass-assignment.
export class CreateInviteCodeDto {
  @IsOptional()
  @IsDateString()
  expires_at?: string;

  // Cap at a sane upper bound so a typo/overflow can't create an effectively
  // unlimited code. Null/undefined still means unlimited.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  max_uses?: number;
}

export class ValidateInviteCodeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  code!: string;
}
