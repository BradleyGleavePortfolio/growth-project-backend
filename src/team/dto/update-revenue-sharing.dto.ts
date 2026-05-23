import { IsBoolean, IsDefined } from 'class-validator';

// Body for PATCH /coach/team/members/:sub_coach_id/revenue-sharing.
//
// Strict boolean: `@IsBoolean()` rejects strings ("false") and `@IsDefined()`
// rejects omitted/null which would otherwise be coerced to `enabled=false`
// by the service and silently disable the head-coach revenue split.
export class UpdateRevenueSharingDto {
  @IsDefined()
  @IsBoolean()
  enabled!: boolean;
}
