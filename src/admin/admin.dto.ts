import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// Phase 1A/1B: OWNER-only admin DTOs. These endpoints are gated by
// JwtAuthGuard + RolesGuard with @Roles('owner').

// Composite keyset cursor for the coach/user roster lists:
// `<ISO8601 created_at>|<row id>`. Both halves are required so pagination is
// deterministic across rows that share a created_at instant. The ISO half is
// validated structurally here; the service re-parses and rejects (400) any
// cursor whose timestamp is unparseable, so a malformed cursor never silently
// resets paging to the top of the roster.
export const KEYSET_CURSOR_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})\|.+$/;

export class PromoteUserDto {
  // Target role to set on the user. Owners may promote/demote between
  // these three values explicitly. Self-service `become-coach` (the
  // privilege-escalation hole) is removed; this is the only path to
  // role=coach or role=owner.
  @IsIn(['student', 'coach', 'owner'])
  role!: 'student' | 'coach' | 'owner';

  // Optional metadata captured on the resulting CoachProfile when
  // promoting to coach. Ignored otherwise.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  business_name?: string;

  @IsOptional()
  @IsString()
  @MinLength(0)
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  timezone?: string;
}

// ---------------------------------------------------------------------------
// Validated query DTOs (#6 raw-parseInt removal, #2 bounded pagination).
//
// Every numeric query param below is coerced by the global ValidationPipe
// ({ whitelist, forbidNonWhitelisted, transform }) in main.ts via
// `@Type(() => Number)`, then validated with `@IsInt` + `@Min`/`@Max`. A
// non-numeric value (e.g. ?limit=abc) now yields a clean 400 instead of a
// silent NaN that fell through to a default. Limits are hard-capped here so
// the bound is enforced at the edge as well as in the service `take`.
// ---------------------------------------------------------------------------

// Default/maximum page sizes. Defaults are applied service-side (so an
// absent limit still pages); the DTO only enforces the bounds when a value
// is supplied.
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 100;
// The Stripe-events / generic list surfaces historically clamped to 200 in
// the service; keep that ceiling so we do not tighten an existing contract.
const WIDE_LIMIT_MAX = 200;

// GET /admin/metrics — overview window in days.
export class AdminMetricsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  since_days?: number;
}

// GET /admin/coaches — cursor-paginated coach list.
export class ListCoachesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(LIST_LIMIT_MAX)
  limit?: number;

  // Composite keyset cursor `<created_at ISO>|<id>` of the last row from the
  // previous page; coaches are ordered (created_at, id) ASC so the next page
  // resumes strictly after that exact (created_at, id) tuple.
  @IsOptional()
  @Matches(KEYSET_CURSOR_REGEX, { message: 'cursor must be `<ISO8601>|<id>`' })
  cursor?: string;
}

// GET /admin/users — filtered + cursor-paginated user list.
export class ListUsersQueryDto {
  @IsOptional()
  @IsIn(['owner', 'coach', 'student'])
  role?: 'owner' | 'coach' | 'student';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(LIST_LIMIT_MAX)
  limit?: number;

  // Composite keyset cursor `<created_at ISO>|<id>` of the last row from the
  // previous page; users are ordered (created_at, id) DESC so the next page
  // resumes strictly before that exact (created_at, id) tuple.
  @IsOptional()
  @Matches(KEYSET_CURSOR_REGEX, { message: 'cursor must be `<ISO8601>|<id>`' })
  cursor?: string;
}

// GET /admin/audit-log — forensic filters + keyset cursor.
export class AuditLogQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  target_user_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenant_coach_id?: string;

  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}

// GET /admin/stripe/events — webhook delivery log.
export class StripeEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  type?: string;

  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}

// GET /admin/federation/search and GET /admin/search — unified search.
export class FederationSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(LIST_LIMIT_MAX)
  limit?: number;
}

// POST /admin/gdpr/scrub — manual scrub trigger / dry-run.
export class GdprScrubQueryDto {
  // Truthy string ("true"/"1"/"yes") enables dry-run; unset honors the
  // GDPR_SCRUB_DRY_RUN env default. Kept as a string so the existing
  // truthiness parsing in the controller is preserved unchanged.
  @IsOptional()
  @IsString()
  @MaxLength(8)
  dry_run?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}

// GET /admin/coach-effective/:coachId — trailing score history window.
export class CoachEffectivenessQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}

// GET /admin/coach-onboarding — wizard progress list.
export class CoachOnboardingQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  completed?: 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}

// GET /admin/coach-alerts — red-flag alert aggregator.
export class CoachAlertsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coach_id?: string;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}

// GET /admin/build-week/enrollments — enrollment list with cursor.
export class BuildWeekEnrollmentsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  status?: string;

  @IsOptional()
  @IsISO8601()
  completed_after?: string;

  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(WIDE_LIMIT_MAX)
  limit?: number;
}
