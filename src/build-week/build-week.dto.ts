import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Body for POST /build-week/days/:dayNumber/complete.
//
// `responses` is the per-prompt answer blob; we leave it loosely typed
// because the catalog itself owns the prompt schema (see
// BuildWeekDay.prompt_questions). The service validates that responses is
// an object before persisting.
//
// `artifact_text` is the user's free-form artifact for the day (e.g. the
// 100-word success statement on Day 1). Optional — the action items list
// already carries copy describing what the artifact should be.
export class CompleteDayDto {
  @IsObject()
  responses!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  artifact_text?: string;
}

// Query params for GET /admin/build-week/enrollments. Cursor is the
// `started_at` of the last row from the previous page (descending order)
// so pagination stays index-friendly.
export class AdminBuildWeekEnrollmentsQuery {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  completed_after?: string;

  @IsOptional()
  @IsString()
  before?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// Lightweight typed shape for the catalog row returned to clients. Mirrors
// the BuildWeekDay table 1:1; we surface this from the service so the
// controller never leaks Prisma types into HTTP boundaries.
export interface BuildWeekDayDto {
  id: string;
  day_number: number;
  title: string;
  focus_area: string;
  narrative: string;
  prompt_questions: string[];
  action_items: BuildWeekActionItemDto[];
  expected_artifact: string;
}

export interface BuildWeekActionItemDto {
  title: string;
  description: string;
  time_estimate_min: number;
}

// Read-only shape passed back from POST /enroll and GET /me. The
// `completions` array is included for /me; /enroll returns it empty on a
// fresh row.
export interface BuildWeekEnrollmentDto {
  id: string;
  user_id: string;
  started_at: string;
  current_day: number;
  status: 'active' | 'completed' | 'abandoned' | string;
  completed_at: string | null;
  completions: BuildWeekDayCompletionDto[];
}

export interface BuildWeekDayCompletionDto {
  id: string;
  day_number: number;
  completed_at: string;
  responses: Record<string, unknown>;
  artifact_text: string | null;
}

// Funnel response — total enrolled, completion rate, drop-off per day.
// `dropoff_per_day[N]` = users who reached day N (have a completion for
// day N or current_day > N) but did NOT complete day N+1.
export interface BuildWeekFunnelDto {
  total_enrolled: number;
  total_completed: number;
  completion_rate: number;
  dropoff_per_day: { day_number: number; reached: number; dropped: number }[];
}
