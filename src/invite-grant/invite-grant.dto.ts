import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { InviteGrantMode } from '@prisma/client';
import {
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
  INVITE_CODE_PATTERN,
} from '../invite-codes/invite-codes.service';
import { INVITE_GRANT_MODES } from './invite-grant.service';

export class InviteCodeParamDto {
  @ApiProperty({
    description: 'Invite code (per-row code or the permanent coach link code).',
    example: 'GP-A1B2C3',
  })
  @IsString()
  @MinLength(INVITE_CODE_MIN_LENGTH)
  @MaxLength(INVITE_CODE_MAX_LENGTH)
  @Matches(INVITE_CODE_PATTERN)
  code!: string;
}

export class SetInviteCodeBindingDto {
  @ApiPropertyOptional({
    description: 'Package to grant on attach. null (or grant_mode "none") clears the binding.',
    format: 'uuid',
    nullable: true,
  })
  @ValidateIf((o: SetInviteCodeBindingDto) => o.package_id !== null)
  @IsUUID()
  package_id!: string | null;

  @ApiProperty({
    enum: ['none', 'free', 'prepaid'],
    description: '"prepaid" = the client paid outside the app.',
  })
  @IsIn(INVITE_GRANT_MODES)
  grant_mode!: InviteGrantMode;
}

export class PackageIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

export class RevokeGrantDto {
  @ApiProperty({ format: 'uuid', description: 'Client whose grant(s) to revoke.' })
  @IsUUID()
  client_user_id!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Limit to one package; omit to revoke every active grant for the client.',
  })
  @IsOptional()
  @IsUUID()
  package_id?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
