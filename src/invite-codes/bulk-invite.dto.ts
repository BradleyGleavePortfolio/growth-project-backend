import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class BulkInviteRowDto {
  @IsEmail()
  @Transform(trim)
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  note?: string;
}

export class BulkInviteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkInviteRowDto)
  rows!: BulkInviteRowDto[];
}
