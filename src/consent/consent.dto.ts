import { IsString } from 'class-validator';

export class GrantConsentDto {
  @IsString()
  coach_id!: string;

  @IsString()
  scope!: string;
}

export class RevokeConsentDto {
  @IsString()
  coach_id!: string;

  @IsString()
  scope!: string;
}
