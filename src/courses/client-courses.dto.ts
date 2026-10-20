import { IsInt, Max, Min } from 'class-validator';

export class LessonPositionDto {
  // Whole seconds into the lesson video; a day is more than any lesson runs.
  @IsInt()
  @Min(0)
  @Max(86400)
  position_seconds!: number;
}
