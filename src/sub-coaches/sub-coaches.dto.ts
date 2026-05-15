import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class InviteSubCoachDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string | null;

  // Optional per-invite ceiling. Null/omitted falls back to the
  // tier-derived default at view time.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  max_clients?: number | null;
}

export class RevokeSubCoachDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReassignClientDto {
  @IsString()
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// 1-char DTO used by the analytics endpoint param validation.
export class SubCoachIdParam {
  @IsString()
  @IsUUID()
  @MinLength(1)
  id!: string;
}

// Body for POST /sub-coaches/invites/accept. Tokens are URL-safe base64
// 24-byte randoms (32 chars), but we accept anything 16..256 chars in
// case the format ever rotates.
export class AcceptSubCoachInviteDto {
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;
}
