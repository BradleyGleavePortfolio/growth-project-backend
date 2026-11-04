import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
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

/** PLAN-SWAPS-BE: a bulk item may name the plan meal it came from (a slot of the caller's own plan). */
export class BulkListItemDto extends AddListItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  source_plan_slot_id?: string;
}

/** POST /lists/:type/bulk. Before PLAN-SWAPS-BE the body was an untyped object and its items were never validated. */
export class BulkAddListItemsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'items must be a non-empty array' })
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkListItemDto)
  items!: BulkListItemDto[];
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
