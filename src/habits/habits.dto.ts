import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsDateString,
  MaxLength,
} from 'class-validator';

// SECURITY: allow-list DTOs for habit writes. Previously both endpoints took
// `@Body() body: any`. Create would spread into prisma.habit.create, letting a
// client set `user_id` to another account. See audit C4.
export class CreateHabitDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsNumber()
  target_value?: number;

  // Mobile client sends `target_count` (historically), service coerces both.
  @IsOptional()
  @IsNumber()
  target_count?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;
}

export class LogHabitDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsNumber()
  value?: number;
}
