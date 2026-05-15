import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Body for PUT /coach/team. business_name is required on the first
// upsert; team_code is server-generated unless the caller explicitly
// supplies one (kept optional so the same DTO doubles as the partial
// update shape).
export class UpsertTeamProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  business_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  team_code?: string;
}
