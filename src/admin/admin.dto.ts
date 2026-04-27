import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Phase 1A/1B: OWNER-only admin DTOs. These endpoints are gated by
// JwtAuthGuard + RolesGuard with @Roles('owner').

export class PromoteUserDto {
  // Target role to set on the user. Owners may promote/demote between
  // these three values explicitly. Self-service `become-coach` (the
  // privilege-escalation hole) is removed; this is the only path to
  // role=coach or role=owner.
  @IsIn(['student', 'coach', 'owner'])
  role!: 'student' | 'coach' | 'owner';

  // Optional metadata captured on the resulting CoachProfile when
  // promoting to coach. Ignored otherwise.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  business_name?: string;

  @IsOptional()
  @IsString()
  @MinLength(0)
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  timezone?: string;
}
