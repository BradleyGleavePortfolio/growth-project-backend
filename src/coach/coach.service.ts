import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ConsentScope, ConsentService } from '../consent/consent.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';

// Concrete payload shapes for the timeline/summary slices below. These
// derive their structure from the Prisma findMany calls so adding columns
// to the underlying tables flows through without manual updates.
type LoggedFoodEntryWithFood = Prisma.LoggedFoodEntryGetPayload<{
  include: { food_item: true };
}>;
type WorkoutSessionWithExercises = Prisma.WorkoutSessionGetPayload<{
  include: { exercises: true };
}>;
type WeightLogRow = Prisma.WeightLogGetPayload<Record<string, never>>;
type CheckInRow = Prisma.CheckInGetPayload<Record<string, never>>;

// UX-COACHLOOKUP-124: user columns the roster never sends to the coach app.
type RosterHiddenField = 'deletion_token_hash' | 'deletion_token_expires_at' | 'expo_push_token';

// COACH-ROW-SCRUB-130 (AUD-FIN-FOOD-129 B1): the only client columns the
// timeline, archive and unarchive responses carry. Never the push token, the
// deletion token or the auth id.
const COACH_CLIENT_ROW = { id: true, name: true, archived_at: true } as const satisfies Prisma.UserSelect;
type CoachClientRow = Prisma.UserGetPayload<{ select: typeof COACH_CLIENT_ROW }>;

// Copies only those columns, so a response stays trimmed even if a query
// later stops selecting.
function coachClientRow(row: CoachClientRow): CoachClientRow {
  return { id: row.id, name: row.name, archived_at: row.archived_at };
}

// UX-COACHLOOKUP-124: per-row at-a-glance block on GET /coach/clients. Days
// are YYYY-MM-DD (the logged day). A slice the client has not shared with
// this coach is null; `shared` is false when no fitness slice is shared.
export interface RosterActivity {
  shared: boolean;
  last_active_on: string | null;
  last_food_on: string | null;
  last_workout_on: string | null;
  last_weigh_in_on: string | null;
  last_check_in_on: string | null;
  check_ins_to_review: number | null;
}

interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
}

// Per-scope filter for the timeline/summary view: when the client has
// not granted the scope, the coach sees an empty array for that slice
// rather than a 403 (so the UI can render the rest of the dashboard).
// Owners bypass the check.
interface FitnessConsentFlags {
  workouts: boolean;
  food: boolean;
  bodyMetrics: boolean;
  habitsProgress: boolean;
}

// Row shape returned by the $queryRaw aggregate in getDashboard.
interface FoodTotalsRow {
  user_id: string;
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
}

// Audit-1 Fix #7: cursor-pagination options for getClientTimeline().
// Each slice is independently cursor-paginated so the client can
// scroll-load each data type without re-fetching the others.
export interface TimelineCursors {
  mealsCursor?: string;
  workoutsCursor?: string;
  weightsCursor?: string;
  checkInsCursor?: string;
}

@Injectable()
export class CoachService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    // Optional in the constructor signature so legacy unit tests that
    // construct CoachService directly with (prisma, audit) keep
    // compiling; in NestJS DI this is always populated because
    // ConsentModule is @Global.
    private consent?: ConsentService,
    // Phase 11: sub-coach overlay scope helper. Optional for the same
    // unit-test reason as `consent` above — SubCoachModule is @Global,
    // so production DI always populates this.
    private subCoachScope?: SubCoachScopeService,
  ) {}

  private async loadFitnessConsents(
    coachId: string,
    clientId: string,
    callerRole?: string,
  ): Promise<FitnessConsentFlags> {
    if (callerRole === 'owner') {
      return { workouts: true, food: true, bodyMetrics: true, habitsProgress: true };
    }
    if (!this.consent) {
      // Defensive default for tests that build CoachService without DI:
      // assume all scopes granted so existing fixtures still pass. Real
      // requests always go through DI and get the real ConsentService.
      return { workouts: true, food: true, bodyMetrics: true, habitsProgress: true };
    }
    const [workouts, food, bodyMetrics, habitsProgress] = await Promise.all([
      this.consent.coachCanAccess(coachId, clientId, ConsentScope.FITNESS_WORKOUTS, callerRole),
      this.consent.coachCanAccess(coachId, clientId, ConsentScope.FITNESS_FOOD_MACROS, callerRole),
      this.consent.coachCanAccess(coachId, clientId, ConsentScope.FITNESS_BODY_METRICS, callerRole),
      this.consent.coachCanAccess(coachId, clientId, ConsentScope.FITNESS_HABITS_PROGRESS, callerRole),
    ]);
    return { workouts, food, bodyMetrics, habitsProgress };
  }

  // Phase 1B: when the caller is an OWNER, every list/lookup widens to
  // the platform-wide view. When the caller is a COACH, the existing
  // coach_id filter is preserved.
  //
  // `byCoach` returns the right Prisma `where` fragment for each role:
  //   - OWNER: {}                       (sees every coach's data)
  //   - else : { coach_id: callerId }    (existing behavior)
  private byCoach(callerId: string, callerRole?: string): { coach_id?: string } {
    if (callerRole === 'owner') return {};
    return { coach_id: callerId };
  }

  // Phase 11: scope-aware Prisma `where` fragment for client-row lookups.
  // Resolves to:
  //   - OWNER: {}                                (platform-wide)
  //   - head coach: { coach_id: callerId }       (their own roster)
  //   - sub-coach:  { id: { in: [...assignedIds] } }
  //     (intersect with the open SubCoachAssignment overlay; if a sub-
  //     coach has no assigned clients we return an impossible filter so
  //     queries return zero rows rather than the whole platform)
  //
  // If SubCoachScopeService isn't wired up (unit tests), we silently fall
  // back to the head-coach behavior so existing fixtures keep passing.
  private async scopeClientsBy(
    callerId: string,
    callerRole?: string,
  ): Promise<Prisma.UserWhereInput> {
    if (callerRole === 'owner') return {};
    if (!this.subCoachScope) return { coach_id: callerId };
    const isSub = await this.subCoachScope.isSubCoach(callerId);
    if (!isSub) return { coach_id: callerId };
    const ids = await this.subCoachScope.getAuthorizedClientIds(callerId);
    if (ids.length === 0) {
      // Impossible filter — sub-coach has no assigned clients.
      return { id: { in: [] } };
    }
    return { id: { in: ids } };
  }

  async getClients(
    coachId: string,
    status: 'active' | 'archived' | 'all' = 'active',
    callerRole?: string,
    cursor?: string,
    take?: number,
  ) {
    let archiveFilter: object = {};
    if (status === 'active') {
      archiveFilter = { archived_at: null };
    } else if (status === 'archived') {
      archiveFilter = { archived_at: { not: null } };
    }
    const scope = await this.scopeClientsBy(coachId, callerRole);
    return this.prisma.user.findMany({
      where: {
        ...scope,
        role: 'student',
        ...archiveFilter,
      },
      include: { profile: true },
      orderBy: { created_at: 'desc' },
      take: take ?? 20,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  /**
   * UX-COACHLOOKUP-124: what a coach needs at a glance on the Clients list.
   * Adds an `activity` block to each GET /coach/clients row (latest food,
   * workout, weigh-in and check-in day, plus check-ins waiting for review)
   * and stops sending fields no roster reader uses (deletion token hash,
   * push token). Every slice follows the same per-scope consent rule as the
   * client summary and timeline (loadFitnessConsents / coachCanAccess): a
   * scope the client has not granted is null, and the profile is sent only
   * with body-metrics consent, exactly as getClientSummary does. Owners
   * bypass consent. Five grouped queries per page, never one per client.
   */
  async withRosterActivity<T extends { id: string; profile?: unknown }>(
    coachId: string,
    callerRole: string | undefined,
    rows: T[],
  ): Promise<Array<Omit<T, RosterHiddenField> & { activity: RosterActivity }>> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const granted = await this.rosterFitnessConsents(coachId, ids, callerRole);
    const idsWith = (scope: string) => ids.filter((id) => granted.get(id)?.has(scope));
    const foodIds = idsWith(ConsentScope.FITNESS_FOOD_MACROS);
    const workoutIds = idsWith(ConsentScope.FITNESS_WORKOUTS);
    const bodyIds = idsWith(ConsentScope.FITNESS_BODY_METRICS);
    const habitIds = idsWith(ConsentScope.FITNESS_HABITS_PROGRESS);

    type MaxDate = { user_id: string; _max: { date: Date | null } };
    type Counted = { user_id: string; _count: { _all: number } };
    type Grouped = [MaxDate[], MaxDate[], MaxDate[], MaxDate[], Counted[]];
    const [food, workouts, weights, checkIns, toReview]: Grouped = await Promise.all([
      foodIds.length
        ? this.prisma.loggedFoodEntry.groupBy({
            by: ['user_id'],
            where: { user_id: { in: foodIds } },
            _max: { date: true },
          })
        : Promise.resolve<MaxDate[]>([]),
      workoutIds.length
        ? this.prisma.workoutSession.groupBy({
            by: ['user_id'],
            where: { user_id: { in: workoutIds } },
            _max: { date: true },
          })
        : Promise.resolve<MaxDate[]>([]),
      bodyIds.length
        ? this.prisma.weightLog.groupBy({
            by: ['user_id'],
            where: { user_id: { in: bodyIds } },
            _max: { date: true },
          })
        : Promise.resolve<MaxDate[]>([]),
      habitIds.length
        ? this.prisma.checkIn.groupBy({
            by: ['user_id'],
            where: { user_id: { in: habitIds } },
            _max: { date: true },
          })
        : Promise.resolve<MaxDate[]>([]),
      habitIds.length
        ? this.prisma.checkIn.groupBy({
            by: ['user_id'],
            where: { user_id: { in: habitIds }, reviewed_by_coach: false },
            _count: { _all: true },
          })
        : Promise.resolve<Counted[]>([]),
    ]);

    const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
    const byUser = (groups: MaxDate[]) => new Map(groups.map((g) => [g.user_id, day(g._max.date)]));
    const foodOn = byUser(food);
    const workoutOn = byUser(workouts);
    const weighInOn = byUser(weights);
    const checkInOn = byUser(checkIns);
    const reviewCount = new Map(toReview.map((g) => [g.user_id, g._count._all]));

    return rows.map((row) => {
      const scopes = granted.get(row.id);
      const has = (scope: string) => scopes?.has(scope) === true;
      // Destructured only to leave them out of the response.
      const {
        deletion_token_hash: _hash,
        deletion_token_expires_at: _expires,
        expo_push_token: _push,
        ...rest
      } = row as T & Partial<Record<RosterHiddenField, unknown>>;
      const slices: Array<string | null> = [
        foodOn.get(row.id) ?? null,
        workoutOn.get(row.id) ?? null,
        weighInOn.get(row.id) ?? null,
        checkInOn.get(row.id) ?? null,
      ];
      const lastActive = slices.reduce<string | null>(
        (latest, d) => (d && (!latest || d > latest) ? d : latest),
        null,
      );
      const anyShared =
        has(ConsentScope.FITNESS_FOOD_MACROS) ||
        has(ConsentScope.FITNESS_WORKOUTS) ||
        has(ConsentScope.FITNESS_BODY_METRICS) ||
        has(ConsentScope.FITNESS_HABITS_PROGRESS);
      return {
        ...(rest as Omit<T, RosterHiddenField>),
        profile: has(ConsentScope.FITNESS_BODY_METRICS) ? (row.profile ?? null) : null,
        activity: {
          shared: anyShared,
          last_active_on: lastActive,
          last_food_on: has(ConsentScope.FITNESS_FOOD_MACROS) ? (foodOn.get(row.id) ?? null) : null,
          last_workout_on: has(ConsentScope.FITNESS_WORKOUTS) ? (workoutOn.get(row.id) ?? null) : null,
          last_weigh_in_on: has(ConsentScope.FITNESS_BODY_METRICS) ? (weighInOn.get(row.id) ?? null) : null,
          last_check_in_on: has(ConsentScope.FITNESS_HABITS_PROGRESS) ? (checkInOn.get(row.id) ?? null) : null,
          check_ins_to_review: has(ConsentScope.FITNESS_HABITS_PROGRESS)
            ? (reviewCount.get(row.id) ?? 0)
            : null,
        },
      };
    });
  }

  // Batch form of loadFitnessConsents for one roster page: one query, the same
  // rule as ConsentService.coachCanAccess (owner bypass; otherwise a granted
  // row for this coach, client and scope). No ConsentService (legacy unit
  // tests) means every scope is granted, as in loadFitnessConsents.
  private async rosterFitnessConsents(
    coachId: string,
    clientIds: string[],
    callerRole?: string,
  ): Promise<Map<string, Set<string>>> {
    const fitness = [
      ConsentScope.FITNESS_WORKOUTS,
      ConsentScope.FITNESS_FOOD_MACROS,
      ConsentScope.FITNESS_BODY_METRICS,
      ConsentScope.FITNESS_HABITS_PROGRESS,
    ] as string[];
    if (callerRole === 'owner' || !this.consent) {
      return new Map(clientIds.map((id) => [id, new Set(fitness)]));
    }
    const consentRows = await this.prisma.clientCoachConsent.findMany({
      where: { coach_id: coachId, client_id: { in: clientIds }, scope: { in: fitness } },
      select: { client_id: true, scope: true, granted_at: true, revoked_at: true },
    });
    const out = new Map<string, Set<string>>();
    for (const r of consentRows) {
      if (!ConsentService.rowIsGranted(r)) continue;
      const set = out.get(r.client_id) ?? new Set<string>();
      set.add(r.scope);
      out.set(r.client_id, set);
    }
    return out;
  }

  async archiveClient(
    coachId: string,
    clientId: string,
    callerRole?: string,
    ctx: AuditContext = {},
  ) {
    const scope = await this.scopeClientsBy(coachId, callerRole);
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...scope },
      select: { ...COACH_CLIENT_ROW, coach_id: true },
    });
    if (!client) throw new Error('Client not found');
    if (client.archived_at) {
      // Idempotent — re-archive is a no-op and skips the audit row to
      // avoid polluting the log on a double-tap.
      return coachClientRow(client);
    }
    const updated = await this.prisma.user.update({
      where: { id: clientId },
      data: { archived_at: new Date() },
      select: COACH_CLIENT_ROW,
    });
    await this.audit.write({
      action: AuditAction.COACH_CLIENT_ARCHIVED,
      actorId: coachId,
      actorRole: callerRole ?? null,
      targetUserId: clientId,
      targetType: 'user',
      targetId: clientId,
      tenantCoachId: client.coach_id ?? coachId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return coachClientRow(updated);
  }

  async unarchiveClient(
    coachId: string,
    clientId: string,
    callerRole?: string,
    ctx: AuditContext = {},
  ) {
    const scope = await this.scopeClientsBy(coachId, callerRole);
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...scope },
      select: { ...COACH_CLIENT_ROW, coach_id: true },
    });
    if (!client) throw new Error('Client not found');
    if (!client.archived_at) {
      // Idempotent — already active, skip audit.
      return coachClientRow(client);
    }
    const updated = await this.prisma.user.update({
      where: { id: clientId },
      data: { archived_at: null },
      select: COACH_CLIENT_ROW,
    });
    await this.audit.write({
      action: AuditAction.COACH_CLIENT_UNARCHIVED,
      actorId: coachId,
      actorRole: callerRole ?? null,
      targetUserId: clientId,
      targetType: 'user',
      targetId: clientId,
      tenantCoachId: client.coach_id ?? coachId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return coachClientRow(updated);
  }

  // Audit-1 Fix #7: each of the 4 parallel findMany slices is now capped
  // at 100 rows and supports cursor-based pagination. Callers that omit
  // `opts` (or leave all cursor fields undefined) get the first page of
  // 100 — identical to the previous unbounded behaviour for small data
  // sets, but safe for daily-active clients with 270 + rows per slice.
  //
  // Pagination contract (per slice):
  //   • First page: omit the cursor param entirely.
  //   • Next page: pass the `id` of the last row from the previous page.
  //   • Exhausted: response slice length < 100 means no further pages.
  async getClientTimeline(
    coachId: string,
    clientId: string,
    days: number = 90,
    callerRole?: string,
    opts: TimelineCursors = {},
    auditCtx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    const scope = await this.scopeClientsBy(coachId, callerRole);
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...scope },
      select: COACH_CLIENT_ROW,
    });
    if (!client) return { error: 'Client not found' };

    // Audit: log coach data access. Fire-and-forget so a log write cannot
    // block or fail the primary timeline response.
    void this.audit.write({
      action: AuditAction.COACH_VIEWED_CLIENT_DATA,
      actorId: coachId,
      actorRole: callerRole ?? 'coach',
      targetUserId: clientId,
      targetType: 'user',
      targetId: clientId,
      tenantCoachId: coachId,
      ip: auditCtx.ip ?? null,
      userAgent: auditCtx.userAgent ?? null,
      metadata: { view: 'timeline', days },
    });

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - days);

    // Per-scope consent gating. A scope the client has not granted
    // returns an empty slice rather than a 403 — the rest of the
    // timeline still renders. Owners bypass the check.
    const flags = await this.loadFitnessConsents(coachId, clientId, callerRole);

    const [meals, workouts, weights, checkIns] = await Promise.all([
      flags.food
        ? this.prisma.loggedFoodEntry.findMany({
            // Use `date` (the actual eat date the user recorded) for timeline
            // filtering and ordering, not `logged_at` (server sync timestamp).
            // An offline queue flush may sync days-old entries with a recent
            // logged_at, which would make them disappear from the coach's
            // 90-day window or appear out of order. See Fix 5.
            where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
            include: { food_item: true },
            // `date` is a calendar day, so same-day foods tie. The id
            // tie-break makes mealsCursor pages exact: no entry repeats on
            // the next page and none is skipped.
            orderBy: [{ date: 'desc' }, { id: 'desc' }],
            take: 100,
            ...(opts.mealsCursor ? { cursor: { id: opts.mealsCursor }, skip: 1 } : {}),
          })
        : Promise.resolve<LoggedFoodEntryWithFood[]>([]),
      flags.workouts
        ? this.prisma.workoutSession.findMany({
            where: { user_id: clientId, created_at: { gte: ninetyDaysAgo } },
            include: { exercises: true },
            orderBy: { created_at: 'desc' },
            take: 100,
            ...(opts.workoutsCursor ? { cursor: { id: opts.workoutsCursor }, skip: 1 } : {}),
          })
        : Promise.resolve<WorkoutSessionWithExercises[]>([]),
      flags.bodyMetrics
        ? this.prisma.weightLog.findMany({
            where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
            orderBy: { date: 'desc' },
            take: 100,
            ...(opts.weightsCursor ? { cursor: { id: opts.weightsCursor }, skip: 1 } : {}),
          })
        : Promise.resolve<WeightLogRow[]>([]),
      flags.habitsProgress
        ? this.prisma.checkIn.findMany({
            where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
            orderBy: { date: 'desc' },
            take: 100,
            ...(opts.checkInsCursor ? { cursor: { id: opts.checkInsCursor }, skip: 1 } : {}),
          })
        : Promise.resolve<CheckInRow[]>([]),
    ]);

    const events: Array<{ type: string; date: Date; ref: unknown }> = [
      // Use `date` (eat date) not `logged_at` (sync timestamp) for timeline
      // event ordering so offline-queued entries sort correctly. See Fix 5.
      ...meals.map((m) => ({ type: 'meal', date: m.date, ref: m })),
      ...workouts.map((w) => ({ type: 'workout', date: w.created_at, ref: w })),
      ...weights.map((w) => ({ type: 'weight', date: w.date, ref: w })),
      ...checkIns.map((c) => ({ type: 'check_in', date: c.date, ref: c })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      client: coachClientRow(client),
      meals,
      workouts,
      weights,
      checkIns,
      events,
      consent: {
        workouts: flags.workouts,
        food_macros: flags.food,
        body_metrics: flags.bodyMetrics,
        habits_progress: flags.habitsProgress,
      },
    };
  }

  // Ownership check helper: throws ForbiddenException if the client is
  // not currently assigned to the given coach. Used by postGuidelines and
  // getGuidelines to prevent cross-coach data access.
  private async assertCoachOwnsClient(coachId: string, clientId: string): Promise<void> {
    const client = await this.prisma.user.findFirst({
      where: {
        id: clientId,
        coach_id: coachId,
        role: 'student',
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!client) throw new ForbiddenException('Client is not assigned to this coach');
  }

  async postGuidelines(coachId: string, clientId: string, guidelines: string) {
    await this.assertCoachOwnsClient(coachId, clientId);
    return this.prisma.coachGuideline.upsert({
      where: {
        CoachGuideline_coach_client_key: { coach_id: coachId, client_id: clientId },
      },
      create: { coach_id: coachId, client_id: clientId, content: guidelines },
      update: { content: guidelines },
    });
  }

  async getGuidelines(coachId: string, clientId: string) {
    await this.assertCoachOwnsClient(coachId, clientId);
    return this.prisma.coachGuideline.findUnique({
      where: {
        CoachGuideline_coach_client_key: {
          coach_id: coachId,
          client_id: clientId,
        },
      },
    });
  }

  // GUIDE-READ-128: the client's own read (GET /coach/my-guidelines,
  // ClientGuidelinesController). Scoped to the one row written for this
  // client by their CURRENT coach, the same pair Roman reads. Returns only
  // the text and its dates, under the field names the app's Coach guidelines
  // screen reads (`description`, `created_at`), so installed builds render it
  // unchanged. null (an empty 200 body) = no coach or nothing written yet,
  // which the screen shows as "No guidelines yet".
  async getClientGuidelines(
    clientId: string,
  ): Promise<{ description: string; created_at: Date; updated_at: Date } | null> {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { coach_id: true },
    });
    if (!client?.coach_id) return null;
    const row = await this.prisma.coachGuideline.findUnique({
      where: {
        CoachGuideline_coach_client_key: { coach_id: client.coach_id, client_id: clientId },
      },
      select: { content: true, created_at: true, updated_at: true },
    });
    if (!row) return null;
    return { description: row.content, created_at: row.created_at, updated_at: row.updated_at };
  }

  async getClientSummary(
    coachId: string,
    clientId: string,
    date?: string,
    callerRole?: string,
    auditCtx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    const scope = await this.scopeClientsBy(coachId, callerRole);
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...scope },
      include: { profile: true },
    });
    if (!client) return { error: 'Client not found' };

    // Audit: log coach data access. Fire-and-forget.
    void this.audit.write({
      action: AuditAction.COACH_VIEWED_CLIENT_DATA,
      actorId: coachId,
      actorRole: callerRole ?? 'coach',
      targetUserId: clientId,
      targetType: 'user',
      targetId: clientId,
      tenantCoachId: coachId,
      ip: auditCtx.ip ?? null,
      userAgent: auditCtx.userAgent ?? null,
      metadata: { view: 'summary', date: date ?? null },
    });

    const today = date || new Date().toISOString().split('T')[0];
    const startOfDay = new Date(today + 'T00:00:00.000Z');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Per-scope consent gating, same shape as getClientTimeline.
    const flags = await this.loadFitnessConsents(coachId, clientId, callerRole);

    const [todayEntries, weightLogs, recentWorkouts, recentAssignments] = await Promise.all([
      flags.food
        ? this.prisma.loggedFoodEntry.findMany({
            // Filter by `date` (eat date) not `logged_at` (server sync time)
            // so offline-queued entries that flush late still show up on the
            // correct day in the coach's daily view. See Fix 5.
            where: { user_id: clientId, date: startOfDay },
            include: { food_item: true },
            orderBy: { logged_at: 'asc' },
          })
        : Promise.resolve<LoggedFoodEntryWithFood[]>([]),
      flags.bodyMetrics
        ? this.prisma.weightLog.findMany({
            where: { user_id: clientId, date: { gte: thirtyDaysAgo } },
            orderBy: { date: 'desc' },
          })
        : Promise.resolve<WeightLogRow[]>([]),
      flags.workouts
        ? this.prisma.workoutSession.findMany({
            where: { user_id: clientId },
            include: { exercises: true },
            orderBy: { created_at: 'desc' },
            take: 10,
          })
        : Promise.resolve<WorkoutSessionWithExercises[]>([]),
      flags.workouts
        ? this.prisma.clientWorkoutAssignment.findMany({
            where: { client_id: clientId },
            include: {
              workout_plan: { include: { exercises: true } },
            },
            orderBy: { scheduled_for: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
    ]);

    let total_calories = 0, total_protein_g = 0, total_carbs_g = 0, total_fat_g = 0;
    for (const entry of todayEntries) {
      const qty = entry.quantity_multiplier || 1;
      const fi = entry.food_item;
      if (fi) {
        total_calories += (fi.calories || 0) * qty;
        total_protein_g += (fi.protein_g || 0) * qty;
        total_carbs_g += (fi.carbs_g || 0) * qty;
        total_fat_g += (fi.fat_g || 0) * qty;
      }
    }

    return {
      profile: flags.bodyMetrics ? client.profile : null,
      client_name: client.name,
      today: {
        entries: todayEntries,
        total_calories: Math.round(total_calories),
        total_protein_g: Math.round(total_protein_g),
        total_carbs_g: Math.round(total_carbs_g),
        total_fat_g: Math.round(total_fat_g),
      },
      weight_logs: weightLogs,
      recent_workouts: recentWorkouts,
      recent_assignments: recentAssignments,
      consent: {
        workouts: flags.workouts,
        food_macros: flags.food,
        body_metrics: flags.bodyMetrics,
        habits_progress: flags.habitsProgress,
      },
    };
  }

  async getDashboard(coachId: string, callerRole?: string) {
    const today = new Date();
    const startOfDay = new Date(today.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const endOfDay = new Date(today.toISOString().split('T')[0] + 'T23:59:59.999Z');

    const scope = await this.scopeClientsBy(coachId, callerRole);
    const clients = await this.prisma.user.findMany({
      where: { ...scope, role: 'student' },
      select: { id: true },
    });

    if (clients.length === 0) {
      return { logs_today: 0, total_kcal: 0, logging_rate: 0 };
    }

    const clientIds = clients.map((c) => c.id);

    // Push aggregation into Postgres: one row per client instead of
    // fetching every food entry + food_item join and summing in JS.
    // This eliminates an O(N × entries) round-trip at the 30-second
    // dashboard polling interval.
    const totals = await this.prisma.$queryRaw<FoodTotalsRow[]>`
      SELECT
        lfe.user_id,
        COALESCE(SUM(fi.calories * lfe.quantity_multiplier), 0)::float   AS total_kcal,
        COALESCE(SUM(fi.protein_g * lfe.quantity_multiplier), 0)::float  AS total_protein_g,
        COALESCE(SUM(fi.carbs_g   * lfe.quantity_multiplier), 0)::float  AS total_carbs_g,
        COALESCE(SUM(fi.fat_g     * lfe.quantity_multiplier), 0)::float  AS total_fat_g
      FROM "LoggedFoodEntry" lfe
      JOIN "FoodItem" fi ON fi.id = lfe.food_item_id
      WHERE lfe.user_id = ANY(${clientIds}::uuid[])
        AND lfe.logged_at BETWEEN ${startOfDay} AND ${endOfDay}
      GROUP BY lfe.user_id
    `;

    // Clients with at least one log entry today have a row in `totals`.
    const logs_today = totals.length;

    // Sum kcal across all clients; default to 0 for clients with no entries.
    const total_kcal = totals.reduce((acc, row) => acc + row.total_kcal, 0);

    const logging_rate = clientIds.length > 0 ? logs_today / clientIds.length : 0;

    return {
      logs_today,
      total_kcal: Math.round(total_kcal),
      logging_rate: Math.round(logging_rate * 100) / 100,
    };
  }

  async getAlerts(coachId: string, callerRole?: string) {
    const scope = await this.scopeClientsBy(coachId, callerRole);
    const clients = await this.prisma.user.findMany({
      where: { ...scope, role: 'student' },
    });

    if (clients.length === 0) return [];

    const clientIds = clients.map((c) => c.id);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [allRecentWeightLogs, workoutGroups] = await Promise.all([
      this.prisma.weightLog.findMany({
        where: { user_id: { in: clientIds }, date: { gte: thirtyDaysAgo } },
        orderBy: [{ user_id: 'asc' }, { date: 'desc' }],
        select: { user_id: true, date: true, weight_lbs: true },
      }),
      this.prisma.workoutSession.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds }, date: { gte: fiveDaysAgo } },
        _count: { _all: true },
      }),
    ]);

    const workedOutRecently = new Set(
      workoutGroups.filter((g) => g._count._all > 0).map((g) => g.user_id),
    );

    const weightLogsByUser = new Map<string, { date: Date; weight_lbs: number }[]>();
    for (const wl of allRecentWeightLogs) {
      const arr = weightLogsByUser.get(wl.user_id) ?? [];
      if (arr.length < 4) arr.push({ date: wl.date, weight_lbs: wl.weight_lbs });
      weightLogsByUser.set(wl.user_id, arr);
    }

    const alerts: Array<{ type: string; client_id: string; client_name: string; message: string }> = [];

    for (const client of clients) {
      const weightLogs = weightLogsByUser.get(client.id) ?? [];
      if (weightLogs.length >= 3) {
        let weightUp = true;
        for (let i = 0; i < weightLogs.length - 1; i++) {
          if (weightLogs[i].weight_lbs <= weightLogs[i + 1].weight_lbs) {
            weightUp = false;
            break;
          }
        }
        if (weightUp) {
          alerts.push({
            type: 'weight_increasing',
            client_id: client.id,
            client_name: client.name,
            message: `${client.name} weight has increased 3+ consecutive days`,
          });
        }
      }

      if (!workedOutRecently.has(client.id)) {
        alerts.push({
          type: 'missed_workouts',
          client_id: client.id,
          client_name: client.name,
          message: `${client.name} has not logged a workout in 5+ days`,
        });
      }
    }

    return alerts;
  }

  /**
   * getDashboardSummary — scalable pre-aggregated dashboard for coaches with 100+ clients.
   *
   * Returns two things in a single compound DB round-trip:
   *   1. `stats`           — simple counts (total clients, active today, unread messages,
   *                          pending check-ins) computed via Prisma aggregations.
   *   2. `attention_needed` — up to 20 clients that need the coach's attention today,
   *                           each tagged with a reason (missed_workout | off_macros |
   *                           no_checkin | weight_flag). Built from the same data as
   *                           getAlerts() but via targeted, index-friendly queries
   *                           rather than loading every client's full record.
   *
   * Performance contract:
   *   - No N+1 queries. Every sub-query is a single aggregation or batch lookup.
   *   - clientIds are resolved once and reused across all sub-queries.
   *   - Results are capped (attention_needed ≤ 20) so payload size is bounded
   *     regardless of roster size.
   */
  async getDashboardSummary(
    coachId: string,
    callerRole?: string,
  ): Promise<{
    stats: {
      total_clients: number;
      active_today: number;
      unread_messages: number;
      pending_checkins: number;
    };
    attention_needed: Array<{
      client_id: string;
      client_name: string;
      reason: 'missed_workout' | 'off_macros' | 'no_checkin' | 'weight_flag';
    }>;
  }> {
    const now = new Date();
    const startOfDay = new Date(now.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const endOfDay = new Date(now.toISOString().split('T')[0] + 'T23:59:59.999Z');
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ── Step 1: Resolve client IDs (single query, indexed) ─────────────────
    const clients = await this.prisma.user.findMany({
      where: { ...this.byCoach(coachId, callerRole), role: 'student' },
      select: { id: true, name: true },
    });

    const totalClients = clients.length;
    if (totalClients === 0) {
      return {
        stats: { total_clients: 0, active_today: 0, unread_messages: 0, pending_checkins: 0 },
        attention_needed: [],
      };
    }

    const clientIds = clients.map((c) => c.id);
    const clientMap = new Map(clients.map((c) => [c.id, c.name]));

    // ── Step 2: Parallel aggregations (all index-friendly, no per-row JS) ──
    const [
      foodLogGroups,      // clients who logged food today
      workoutGroups,      // clients who worked out in the last 5 days
      pendingCheckIns,    // check-ins submitted but not reviewed
      unreadMsgCount,     // messages not yet read by the coach
      recentWeightLogs,   // weight logs for trend detection (last 30 days)
      unreviewedCheckins, // per-client unreviewed check-in groupBy (for no_checkin flag)
    ] = await Promise.all([
      // Active today: clients with at least one food log entry today.
      this.prisma.loggedFoodEntry.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds }, logged_at: { gte: startOfDay, lte: endOfDay } },
        _count: { _all: true },
      }),

      // Missed workouts: clients with a session in the last 5 days.
      this.prisma.workoutSession.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds }, date: { gte: fiveDaysAgo } },
        _count: { _all: true },
      }),

      // Pending check-ins: submitted but not yet reviewed by coach.
      this.prisma.checkIn.count({
        where: {
          user_id: { in: clientIds },
          reviewed_by_coach: false,
        },
      }),

      // Unread messages: messages sent to this coach that are unread.
      this.prisma.message.count({
        where: {
          recipient_id: coachId,
          read: false,
        },
      }),

      // Weight trend flags: last 4 weight entries per client (for 3-day trend).
      this.prisma.weightLog.findMany({
        where: { user_id: { in: clientIds }, date: { gte: thirtyDaysAgo } },
        orderBy: [{ user_id: 'asc' }, { date: 'desc' }],
        select: { user_id: true, weight_lbs: true, date: true },
      }),

      // Unreviewed check-ins: per-client groupBy so we can flag individuals in
      // the attention list. The aggregate count (pendingCheckIns above) is
      // already used for the stats summary; this gives us the per-client Set.
      // (Finding 6 — MEDIUM, audit 2026-05-19: no_checkin reason was declared
      // in the type union but never emitted.)
      this.prisma.checkIn.groupBy({
        by: ['user_id'],
        where: { user_id: { in: clientIds }, reviewed_by_coach: false },
        _count: { _all: true },
      }),
    ]);

    // ── Step 3: Derive attention_needed list from aggregated data ───────────
    const workedOutRecently = new Set(workoutGroups.map((g: { user_id: string }) => g.user_id));
    const loggedToday = new Set(foodLogGroups.map((g: { user_id: string }) => g.user_id));
    // Clients with at least one unreviewed check-in submitted (no_checkin flag).
    // (Finding 6 — MEDIUM, audit 2026-05-19)
    const hasUnreviewedCheckin = new Set(
      unreviewedCheckins.map((r: { user_id: string }) => r.user_id),
    );

    // Group weight logs by client (already sorted desc by date per client).
    const weightLogsByUser = new Map<string, number[]>();
    for (const wl of recentWeightLogs) {
      const arr = weightLogsByUser.get(wl.user_id) ?? [];
      if (arr.length < 4) arr.push(wl.weight_lbs);
      weightLogsByUser.set(wl.user_id, arr);
    }

    const attention: Array<{
      client_id: string;
      client_name: string;
      reason: 'missed_workout' | 'off_macros' | 'no_checkin' | 'weight_flag';
    }> = [];

    for (const id of clientIds) {
      if (attention.length >= 20) break; // cap payload size

      const name = clientMap.get(id) ?? id;

      // Weight increasing 3+ consecutive days.
      const weights = weightLogsByUser.get(id) ?? [];
      if (weights.length >= 3) {
        let weightUp = true;
        for (let i = 0; i < weights.length - 1; i++) {
          if (weights[i] <= weights[i + 1]) {
            weightUp = false;
            break;
          }
        }
        if (weightUp) {
          attention.push({ client_id: id, client_name: name, reason: 'weight_flag' });
          continue;
        }
      }

      // No workout in 5+ days.
      if (!workedOutRecently.has(id)) {
        attention.push({ client_id: id, client_name: name, reason: 'missed_workout' });
        continue;
      }

      // No food log today (off macros signal).
      if (!loggedToday.has(id)) {
        attention.push({ client_id: id, client_name: name, reason: 'off_macros' });
        continue;
      }

      // Unreviewed check-in: client submitted a check-in the coach hasn't seen yet.
      // Priority order: weight_flag > missed_workout > off_macros > no_checkin.
      // We use `continue` above so a client flagged for a higher-priority reason
      // is never double-counted here. (Finding 6 — MEDIUM, audit 2026-05-19)
      //
      // SEMANTIC NOTE (re-audit 2026-05-19 followup B):
      // The reason label 'no_checkin' here means "client has at least one
      // UNREVIEWED check-in" (i.e. a submission is waiting for coach review),
      // NOT "client has not submitted a recent check-in" (absence of any
      // submission). If the product requirement ever changes to the absence
      // semantic, a separate query is needed — e.g. find clients whose latest
      // check-in date is older than a threshold, or who have no check-in rows
      // at all — and this block should be replaced or supplemented.
      if (hasUnreviewedCheckin.has(id)) {
        attention.push({ client_id: id, client_name: name, reason: 'no_checkin' });
      }
    }

    return {
      stats: {
        total_clients: totalClients,
        active_today: foodLogGroups.length,
        unread_messages: unreadMsgCount,
        pending_checkins: pendingCheckIns,
      },
      attention_needed: attention,
    };
  }
}
