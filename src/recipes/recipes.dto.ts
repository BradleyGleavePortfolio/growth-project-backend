import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsArray,
  IsBoolean,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

export class CreateRecipeDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  imageUrl?: string;

  @IsInt()
  @Min(0)
  @Max(600)
  prepTimeMin: number;

  @IsInt()
  @Min(0)
  @Max(600)
  cookTimeMin: number;

  @IsInt()
  @Min(1)
  @Max(100)
  servings: number;

  @IsNumber()
  @Min(0)
  calories: number;

  @IsNumber()
  @Min(0)
  protein: number;

  @IsNumber()
  @Min(0)
  carbs: number;

  @IsNumber()
  @Min(0)
  fat: number;

  @IsArray()
  @IsString({ each: true })
  ingredients: string[];

  @IsArray()
  @IsString({ each: true })
  instructions: string[];

  @IsArray()
  @IsString({ each: true })
  tags: string[];

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
