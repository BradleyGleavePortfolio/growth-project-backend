import {
  IsString,
  IsOptional,
  IsArray,
  IsIn,
  IsInt,
  Min,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

// SECURITY: allow-list DTOs for lesson writes. Previously both endpoints took
// `@Body() body: any` and spread into Prisma — which (combined with the
// CaboRules backdoor that let any user claim the coach role) meant any user
// could set `coach_id` to any value and publish lessons to another coach's
// students. See audit C4/C8. `coach_id` is NEVER writable via these endpoints.
const GOAL_TYPES = ['fat_loss', 'muscle_gain', 'maintenance', 'performance'] as const;
type GoalType = (typeof GOAL_TYPES)[number];

export class CreateLessonDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  video_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  article_url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(GOAL_TYPES, { each: true })
  goal_tags?: GoalType[];

  @IsOptional()
  @IsInt()
  @Min(0)
  order_index?: number;
}

export class UpdateLessonDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  video_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  article_url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(GOAL_TYPES, { each: true })
  goal_tags?: GoalType[];

  @IsOptional()
  @IsInt()
  @Min(0)
  order_index?: number;
}
