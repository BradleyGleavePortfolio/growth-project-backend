import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendOneInviteDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
