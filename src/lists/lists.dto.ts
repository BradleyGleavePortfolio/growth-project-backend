import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsIn,
  MaxLength,
  Min,
} from 'class-validator';

export class AddListItemDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsString()
  source_recipe_id?: string;
}

export class UpdateListItemDto {
  @IsOptional()
  @IsBoolean()
  is_checked?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
