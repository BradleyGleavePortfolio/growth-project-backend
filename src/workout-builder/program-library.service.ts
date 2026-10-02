/**
 * S-MWB Programs — the coach's master program library (`/v1/coach/programs`).
 *
 * A "program" here is a master WorkoutProgram (is_template = true): weeks x
 * seven day slots, each filled slot a WorkoutPlan (program_id, week_index,
 * day_index) that the existing single-workout builder edits (autosave + undo,
 * MWB-3/MWB-4). Built once, reused for everyone:
 *   - library: search, goal tag, weeks x days, filled days, assigned count,
 *     package count; saved-workouts library (standalone plans);
 *   - edit: metadata (optimistic `version`), fill / clear / copy a day,
 *     duplicate, archive / restore, revision history;
 *   - deliver: bulk assign to many clients from a start date (one by-value copy
 *     per client, exactly once per Idempotency-Key, per-client results) and
 *     unassign; package delivery lives in ProgramDeliveryService.
 *
 * Tenancy: every row carries coach_id = tenant (head coach). A caller may READ
 * masters they own or tenant_shared masters of their tenant, and WRITE only
 * masters they own. Client access for assign / unassign goes through
 * WorkoutBuilderService.assertCanAccessClient (head coach or open sub-coach
 * assignment), the same gate MWB-1/MWB-2 use.
 *
 * Errors carry a stable machine `code` plus a human message (the global
 * filter forwards both with the request_id).
 */
import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Prisma, WorkoutPlanType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { WorkoutBuilderService } from './workout-builder.service';
import { ProgramDeliveryService, ProgramEmptyError } from './program-delivery.service';
import {
  BulkAssignProgramDto,
  CreateProgramDto,
  DuplicateProgramDto,
  PROGRAM_DAYS_PER_WEEK_MAX,
  SetProgramDayDto,
  UpdateProgramDto,
} from './program-library.dto';

/** Advisory-lock namespaces (int4). */
const LOCK_NS_PROGRAM_GRID = 0x4d574247; // 'MWBG' — serialises grid writes per program
const LOCK_NS_PROGRAM_ASSIGN = 0x4d574241; // 'MWBA' — serialises assign per (master, client)

const PAGE_MAX = 50;
const REVISIONS_MAX = 50;
/** Assignee list page size (C-640-10): default and hard cap per request. */
const ASSIGNEES_PAGE_DEFAULT = 50;
const ASSIGNEES_PAGE_MAX = 100;

export interface ProgramActor {
  id: string;
  tenantId: string;
  authorKind: 'coach' | 'sub_coach';
}

export interface ProgramSummary {
  id: string;
  name: string;
  description: string | null;
  goal_tag: string | null;
  weeks: number;
  days_per_week: number;
  filled_days: number;
  assigned_count: number;
  package_count: number;
  is_regime: boolean;
  regime_display_name: string | null;
  version: number;
  can_edit: boolean;
  updated_at: string;
  archived_at: string | null;
}

export interface ProgramDay {
  week_index: number;
  day_index: number;
  plan_id: string;
  name: string;
  type: WorkoutPlanType;
  duration_estimate_minutes: number | null;
  exercise_count: number;
  updated_at: string;
}

export interface ProgramPackageRef {
  content_id: string;
  package_id: string;
  package_name: string;
  cadence_kind: string;
}

export interface ProgramDetail extends ProgramSummary {
  days: ProgramDay[];
  packages: ProgramPackageRef[];
}

export type BulkAssignStatus = 'assigned' | 'already_assigned' | 'failed';

export interface BulkAssignResult {
  client_id: string;
  status: BulkAssignStatus;
  /** true when this Idempotency-Key had already assigned this client. */
  replayed?: boolean;
  program_id?: string;
  workouts?: number;
  first_scheduled_for?: string;
  last_scheduled_for?: string;
  code?: string;
  message?: string;
}

export interface BulkAssignResponse {
  program_id: string;
  start_date: string;
  results: BulkAssignResult[];
  summary: { total: number; assigned: number; already_assigned: number; failed: number };
}

export interface ProgramAssignee {
  client_id: string;
  client_name: string;
  copy_program_id: string;
  start_date: string;
  end_date: string;
  workouts: number;
  completed: number;
}

function err(code: string, message: string) {
  return { code, message };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** YYYY-MM-DD -> Date at 12:00 UTC (keeps the calendar day in UTC-11..UTC+11). */
export function startDateToInstant(date: string): Date {
  const [y, m, d] = date.split('-').map((p) => Number(p));
  const at = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  if (
    Number.isNaN(at.getTime()) ||
    at.getUTCFullYear() !== y ||
    at.getUTCMonth() !== m - 1 ||
    at.getUTCDate() !== d
  ) {
    throw new BadRequestException(
      err('invalid_start_date', `${date} is not a real calendar date.`),
    );
  }
  return at;
}

@Injectable()
export class ProgramLibraryService {
  private readonly logger = new Logger(ProgramLibraryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workoutBuilder: WorkoutBuilderService,
    private readonly delivery: ProgramDeliveryService,
    private readonly subCoachScope: SubCoachScopeService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ─── actor + access ─────────────────────────────────────────────────────

  async resolveActor(userId: string): Promise<ProgramActor> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, coach_id: true },
    });
    if (!user)
      throw new ForbiddenException(
        err('account_not_found', 'Your account could not be found. Sign in again.'),
      );
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new ForbiddenException(err('coach_role_required', 'Programs are for coach accounts.'));
    }
    // Tenant promotion goes through the membership-checked helper (C13 A1): a
    // bare `coach_id` on a coach row (left behind by a guest checkout) is NOT a
    // team seat, so that coach is the head of their own library, never a
    // member of someone else's tenant.
    const headCoachId =
      user.role === 'coach' && user.coach_id
        ? await this.subCoachScope.getHeadCoachIdForSubCoach(user.id)
        : null;
    return {
      id: user.id,
      tenantId: headCoachId ?? user.id,
      authorKind: headCoachId ? 'sub_coach' : 'coach',
    };
  }

  /**
   * Clients this actor may see in assignee lists and counts (B-640-2). Head
   * coaches see their whole tenant (null = no extra filter); a sub-coach sees
   * only the clients delegated to them through SubCoachAssignment, the same
   * scope every other coach surface uses.
   */
  private async visibleClientIds(actor: ProgramActor): Promise<Set<string> | null> {
    if (actor.authorKind !== 'sub_coach') return null;
    return new Set(await this.subCoachScope.getAuthorizedClientIds(actor.id));
  }

  private readableWhere(actor: ProgramActor): Prisma.WorkoutProgramWhereInput {
    return {
      coach_id: actor.tenantId,
      is_template: true,
      OR: [{ owner_user_id: actor.id }, { visibility: 'tenant_shared' }],
    };
  }

  private async loadReadable(actor: ProgramActor, programId: string) {
    const program = await this.prisma.workoutProgram.findFirst({
      where: { id: programId, ...this.readableWhere(actor) },
    });
    if (!program) {
      throw new NotFoundException(err('program_not_found', 'This program is not in your library.'));
    }
    return program;
  }

  private async loadEditable(actor: ProgramActor, programId: string) {
    const program = await this.loadReadable(actor, programId);
    if (program.owner_user_id !== actor.id) {
      throw new ForbiddenException(
        err(
          'program_read_only',
          'This program belongs to another coach on your team. Duplicate it to make your own copy.',
        ),
      );
    }
    if (program.archived_at) {
      throw new ConflictException(
        err('program_archived', 'This program is archived. Restore it to make changes.'),
      );
    }
    return program;
  }

  // ─── library ────────────────────────────────────────────────────────────

  async listPrograms(
    userId: string,
    query: {
      q?: string;
      goal_tag?: string;
      status?: string;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<{ items: ProgramSummary[]; next_cursor: string | null; goal_tags: string[] }> {
    const actor = await this.resolveActor(userId);
    const limit = Math.min(Math.max(Math.floor(query.limit ?? PAGE_MAX), 1), PAGE_MAX);
    const archived = query.status === 'archived';
    const q = query.q?.trim();
    const cursor = this.decodeCursor(query.cursor);
    const where: Prisma.WorkoutProgramWhereInput = {
      ...this.readableWhere(actor),
      archived_at: archived ? { not: null } : null,
      ...(query.goal_tag ? { goal_tag: query.goal_tag } : {}),
      AND: [
        q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { goal_tag: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {},
        cursor
          ? {
              OR: [
                { updated_at: { lt: cursor.at } },
                { updated_at: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.prisma.workoutProgram.findMany({
      where,
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > limit && last ? this.encodeCursor(last.updated_at, last.id) : null;
    const items = await this.summarise(actor, page);
    const tagRows = await this.prisma.workoutProgram.findMany({
      where: { ...this.readableWhere(actor), archived_at: null, goal_tag: { not: null } },
      distinct: ['goal_tag'],
      select: { goal_tag: true },
      orderBy: { goal_tag: 'asc' },
    });
    const goal_tags = tagRows
      .map((t) => t.goal_tag)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    return { items, next_cursor, goal_tags };
  }

  private async summarise(
    actor: ProgramActor,
    programs: Array<{
      id: string;
      name: string;
      description: string | null;
      goal_tag: string | null;
      weeks: number;
      days_per_week: number;
      is_regime: boolean;
      regime_display_name: string | null;
      version: number;
      owner_user_id: string;
      updated_at: Date;
      archived_at: Date | null;
    }>,
  ): Promise<ProgramSummary[]> {
    if (programs.length === 0) return [];
    const ids = programs.map((p) => p.id);
    const filled = await this.prisma.workoutPlan.groupBy({
      by: ['program_id'],
      where: { program_id: { in: ids }, archived_at: null },
      _count: { _all: true },
    });
    const filledBy = new Map(filled.map((f) => [f.program_id ?? '', f._count._all]));
    const assigned = await this.assignedCounts(ids, await this.visibleClientIds(actor));
    const pkgs = await this.prisma.coachPackageContent.groupBy({
      by: ['asset_id'],
      where: {
        asset_type: 'workout_program',
        asset_id: { in: ids },
        removed_at: null,
        package: { archived_at: null },
      },
      _count: { _all: true },
    });
    const pkgBy = new Map(pkgs.map((p) => [p.asset_id, p._count._all]));
    return programs.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      goal_tag: p.goal_tag,
      weeks: p.weeks,
      days_per_week: p.days_per_week,
      filled_days: filledBy.get(p.id) ?? 0,
      assigned_count: assigned.get(p.id) ?? 0,
      package_count: pkgBy.get(p.id) ?? 0,
      is_regime: p.is_regime,
      regime_display_name: p.regime_display_name,
      version: p.version,
      can_edit: p.owner_user_id === actor.id && p.archived_at == null,
      updated_at: p.updated_at.toISOString(),
      archived_at: p.archived_at ? p.archived_at.toISOString() : null,
    }));
  }

  /**
   * Distinct clients holding a live (non-archived) copy of each master. Counted
   * from ClientWorkoutAssignment so copies made before S-MWB (MWB-2 clones,
   * #607 onboarding copies, no client_id column value) count too.
   */
  private async assignedCounts(
    masterIds: string[],
    visible: Set<string> | null,
  ): Promise<Map<string, number>> {
    if (masterIds.length === 0) return new Map();
    if (visible && visible.size === 0) return new Map();
    // Deleted (tombstoned) client accounts never count (B-640-3). A sub-coach
    // counts only their own delegated clients (B-640-2).
    const scope = visible
      ? Prisma.sql`AND a."client_id" IN (${Prisma.join(Array.from(visible))})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ master_id: string; n: number }>>`
      SELECT p."cloned_from_id" AS master_id, COUNT(DISTINCT a."client_id")::int AS n
      FROM "ClientWorkoutAssignment" a
      JOIN "WorkoutPlan" wp ON wp."id" = a."workout_plan_id"
      JOIN "WorkoutProgram" p ON p."id" = wp."program_id"
      JOIN "User" u ON u."id" = a."client_id"
      WHERE p."cloned_from_id" IN (${Prisma.join(masterIds)})
        AND p."is_template" = false
        AND p."archived_at" IS NULL
        AND u."deleted_at" IS NULL
        ${scope}
      GROUP BY p."cloned_from_id"`;
    return new Map(rows.map((r) => [r.master_id, Number(r.n)]));
  }

  async getProgram(userId: string, programId: string): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    const program = await this.loadReadable(actor, programId);
    return this.detail(actor, program.id);
  }

  private async detail(actor: ProgramActor, programId: string): Promise<ProgramDetail> {
    const program = await this.prisma.workoutProgram.findUniqueOrThrow({
      where: { id: programId },
    });
    const [summary] = await this.summarise(actor, [program]);
    const plans = await this.prisma.workoutPlan.findMany({
      where: { program_id: programId, archived_at: null },
      orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
      select: {
        id: true,
        name: true,
        type: true,
        duration_estimate_minutes: true,
        week_index: true,
        day_index: true,
        updated_at: true,
        _count: { select: { exercises: { where: { archived_at: null } } } },
      },
    });
    const contents = await this.prisma.coachPackageContent.findMany({
      where: {
        asset_type: 'workout_program',
        asset_id: programId,
        removed_at: null,
        package: { archived_at: null },
      },
      select: {
        id: true,
        package_id: true,
        cadence_kind: true,
        package: { select: { name: true } },
      },
      orderBy: { created_at: 'asc' },
    });
    return {
      ...summary,
      days: plans.map((p) => ({
        week_index: p.week_index ?? 0,
        day_index: p.day_index ?? 0,
        plan_id: p.id,
        name: p.name,
        type: p.type,
        duration_estimate_minutes: p.duration_estimate_minutes ?? null,
        exercise_count: p._count.exercises,
        updated_at: p.updated_at.toISOString(),
      })),
      packages: contents.map((c) => ({
        content_id: c.id,
        package_id: c.package_id,
        package_name: c.package.name,
        cadence_kind: c.cadence_kind,
      })),
    };
  }

  // ─── create / edit ──────────────────────────────────────────────────────

  async createProgram(
    userId: string,
    dto: CreateProgramDto,
    idempotencyKey: string,
  ): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    const result = await this.workoutBuilder.withIdempotency(
      userId,
      'programs:create',
      idempotencyKey,
      async () => {
        const id = randomUUID();
        const revisionId = randomUUID();
        await this.prisma.$transaction(async (tx) => {
          await tx.workoutProgram.create({
            data: {
              id,
              coach_id: actor.tenantId,
              owner_user_id: actor.id,
              visibility: 'owner_only',
              name: dto.name.trim(),
              description: dto.description?.trim() || null,
              goal_tag: dto.goal_tag?.trim() || null,
              weeks: dto.weeks,
              days_per_week: dto.days_per_week,
              is_template: true,
              version: 1,
              head_revision_id: revisionId,
            },
          });
          await tx.workoutProgramRevision.create({
            data: {
              id: revisionId,
              program_id: id,
              revision_index: 0,
              structure_json: toJson({
                weeks: dto.weeks,
                days_per_week: dto.days_per_week,
                days: [],
              }),
              author_id: actor.id,
              author_kind: actor.authorKind,
              cause: 'initial',
            },
          });
        });
        return { id };
      },
    );
    return this.detail(actor, result.id);
  }

  async updateProgram(
    userId: string,
    programId: string,
    dto: UpdateProgramDto,
    idempotencyKey: string,
  ): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    await this.workoutBuilder.withIdempotency(
      userId,
      `programs:update:${programId}`,
      idempotencyKey,
      async () => {
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_PROGRAM_GRID}::int4, hashtext(${programId}))`;
          const program = await this.loadEditableTx(tx, actor, programId);
          if (program.version !== dto.expected_version) {
            throw new ConflictException(
              err(
                'program_version_conflict',
                'This program changed on another device. Reload it to see the latest version.',
              ),
            );
          }
          if (dto.weeks !== undefined && dto.weeks < program.weeks) {
            const outside = await tx.workoutPlan.count({
              where: { program_id: programId, archived_at: null, week_index: { gte: dto.weeks } },
            });
            if (outside > 0) {
              throw new ConflictException(
                err(
                  'program_days_out_of_range',
                  `${outside} workout${outside === 1 ? '' : 's'} sit after week ${dto.weeks}. Clear those days first, then shorten the program.`,
                ),
              );
            }
          }
          await tx.workoutProgram.update({
            where: { id: programId },
            data: {
              ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
              ...(dto.description !== undefined
                ? { description: dto.description?.trim() || null }
                : {}),
              ...(dto.goal_tag !== undefined ? { goal_tag: dto.goal_tag?.trim() || null } : {}),
              ...(dto.weeks !== undefined ? { weeks: dto.weeks } : {}),
              ...(dto.days_per_week !== undefined ? { days_per_week: dto.days_per_week } : {}),
            },
          });
          await this.bumpRevision(tx, actor, programId, 'manual_edit');
        });
        return { ok: true };
      },
    );
    return this.detail(actor, programId);
  }

  private async loadEditableTx(
    tx: Prisma.TransactionClient,
    actor: ProgramActor,
    programId: string,
  ) {
    const program = await tx.workoutProgram.findFirst({
      where: { id: programId, ...this.readableWhere(actor) },
    });
    if (!program)
      throw new NotFoundException(err('program_not_found', 'This program is not in your library.'));
    if (program.owner_user_id !== actor.id) {
      throw new ForbiddenException(
        err(
          'program_read_only',
          'This program belongs to another coach on your team. Duplicate it to make your own copy.',
        ),
      );
    }
    if (program.archived_at) {
      throw new ConflictException(
        err('program_archived', 'This program is archived. Restore it to make changes.'),
      );
    }
    return program;
  }

  /** version + 1 and a new program-level revision snapshotting the grid. */
  private async bumpRevision(
    tx: Prisma.TransactionClient,
    actor: ProgramActor,
    programId: string,
    cause: 'manual_edit' | 'initial' | 'clone',
  ): Promise<void> {
    const program = await tx.workoutProgram.findUniqueOrThrow({ where: { id: programId } });
    const plans = await tx.workoutPlan.findMany({
      where: { program_id: programId, archived_at: null },
      orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
      select: { id: true, name: true, week_index: true, day_index: true },
    });
    const head = await tx.workoutProgramRevision.findFirst({
      where: { program_id: programId },
      orderBy: { revision_index: 'desc' },
      select: { revision_index: true },
    });
    const revisionId = randomUUID();
    await tx.workoutProgramRevision.create({
      data: {
        id: revisionId,
        program_id: programId,
        revision_index: (head?.revision_index ?? -1) + 1,
        structure_json: toJson({
          name: program.name,
          goal_tag: program.goal_tag,
          weeks: program.weeks,
          days_per_week: program.days_per_week,
          days: plans.map((p) => ({
            plan_id: p.id,
            name: p.name,
            week_index: p.week_index,
            day_index: p.day_index,
          })),
        }),
        author_id: actor.id,
        author_kind: actor.authorKind,
        cause,
      },
    });
    await tx.workoutProgram.update({
      where: { id: programId },
      data: { version: { increment: 1 }, head_revision_id: revisionId },
    });
  }

  private assertSlot(program: { weeks: number }, week: number, day: number): void {
    if (!Number.isInteger(week) || week < 0 || week >= program.weeks) {
      throw new BadRequestException(
        err(
          'program_day_out_of_range',
          `Week ${week + 1} is outside this ${program.weeks}-week program.`,
        ),
      );
    }
    if (!Number.isInteger(day) || day < 0 || day >= PROGRAM_DAYS_PER_WEEK_MAX) {
      throw new BadRequestException(err('program_day_out_of_range', 'A week has days 1 to 7.'));
    }
  }

  async setDay(
    userId: string,
    programId: string,
    week: number,
    day: number,
    dto: SetProgramDayDto,
    idempotencyKey: string,
  ): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    await this.workoutBuilder.withIdempotency(
      userId,
      `programs:setDay:${programId}:${week}:${day}`,
      idempotencyKey,
      async () => {
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_PROGRAM_GRID}::int4, hashtext(${programId}))`;
          const program = await this.loadEditableTx(tx, actor, programId);
          this.assertSlot(program, week, day);
          const taken = await tx.workoutPlan.findFirst({
            where: { program_id: programId, week_index: week, day_index: day, archived_at: null },
            select: { id: true },
          });
          if (taken) {
            throw new ConflictException(
              err(
                'program_day_filled',
                `Week ${week + 1}, day ${day + 1} already has a workout. Open it to edit, or clear it first.`,
              ),
            );
          }
          const source = await this.resolveDaySource(tx, actor, programId, dto);
          await this.writeDayPlan(tx, actor, programId, week, day, source);
          await this.bumpRevision(tx, actor, programId, 'manual_edit');
        });
        return { ok: true };
      },
    );
    return this.detail(actor, programId);
  }

  private async resolveDaySource(
    tx: Prisma.TransactionClient,
    actor: ProgramActor,
    programId: string,
    dto: SetProgramDayDto,
  ): Promise<{
    name: string | null;
    type: WorkoutPlanType;
    duration: number | null;
    sourcePlanId: string | null;
    exercises: Array<{
      exercise_external_id: string;
      order: number;
      sets: number;
      reps_or_duration_seconds: number;
      weight_lbs: number | null;
      rest_seconds: number | null;
      superset_group_id: string | null;
      notes: string | null;
    }>;
  }> {
    if (dto.source === 'blank') {
      return {
        name: dto.name?.trim() || null,
        type: (dto.type ?? 'strength') as WorkoutPlanType,
        duration: null,
        sourcePlanId: null,
        exercises: [],
      };
    }
    let src;
    if (dto.source === 'saved_workout') {
      if (!dto.plan_id) {
        throw new BadRequestException(
          err('saved_workout_required', 'Choose a saved workout to copy into this day.'),
        );
      }
      src = await tx.workoutPlan.findFirst({
        where: { id: dto.plan_id, ...this.savedWorkoutWhere(actor) },
        include: { exercises: { where: { archived_at: null }, orderBy: { order: 'asc' } } },
      });
      if (!src) {
        throw new NotFoundException(
          err('saved_workout_not_found', 'That saved workout is no longer in your library.'),
        );
      }
    } else {
      if (dto.from_week_index === undefined || dto.from_day_index === undefined) {
        throw new BadRequestException(err('copy_day_required', 'Choose the day to copy from.'));
      }
      src = await tx.workoutPlan.findFirst({
        where: {
          program_id: programId,
          week_index: dto.from_week_index,
          day_index: dto.from_day_index,
          archived_at: null,
        },
        include: { exercises: { where: { archived_at: null }, orderBy: { order: 'asc' } } },
      });
      if (!src) {
        throw new NotFoundException(
          err(
            'copy_day_empty',
            `Week ${dto.from_week_index + 1}, day ${dto.from_day_index + 1} has no workout to copy.`,
          ),
        );
      }
    }
    return {
      name: src.name,
      type: src.type,
      duration: src.duration_estimate_minutes ?? null,
      sourcePlanId: src.id,
      exercises: src.exercises.map((e) => ({
        exercise_external_id: e.exercise_external_id,
        order: e.order,
        sets: e.sets,
        reps_or_duration_seconds: e.reps_or_duration_seconds,
        weight_lbs: e.weight_lbs ?? null,
        rest_seconds: e.rest_seconds ?? null,
        superset_group_id: e.superset_group_id ?? null,
        notes: e.notes ?? null,
      })),
    };
  }

  private async writeDayPlan(
    tx: Prisma.TransactionClient,
    actor: ProgramActor,
    programId: string,
    week: number,
    day: number,
    source: Awaited<ReturnType<ProgramLibraryService['resolveDaySource']>>,
  ): Promise<string> {
    const planId = randomUUID();
    const revisionId = randomUUID();
    const groupRemap = new Map<string, string>();
    const rows = source.exercises.map((e) => {
      let g: string | null = null;
      if (e.superset_group_id) {
        g = groupRemap.get(e.superset_group_id) ?? `${planId}:${groupRemap.size}`;
        groupRemap.set(e.superset_group_id, g);
      }
      return { ...e, superset_group_id: g };
    });
    const name = source.name ?? `Week ${week + 1}, Day ${day + 1}`;
    await tx.workoutPlan.create({
      data: {
        id: planId,
        coach_id: actor.tenantId,
        name,
        type: source.type,
        duration_estimate_minutes: source.duration,
        program_id: programId,
        week_index: week,
        day_index: day,
        is_template: true,
        version: 1,
        head_revision_id: revisionId,
        cloned_from_plan_id: source.sourcePlanId,
      },
    });
    if (rows.length > 0) {
      await tx.workoutPlanExercise.createMany({
        data: rows.map((r) => ({ ...r, workout_plan_id: planId })),
      });
    }
    await tx.workoutPlanRevision.create({
      data: {
        id: revisionId,
        workout_plan_id: planId,
        revision_index: 0,
        exercises_json: toJson(rows),
        plan_meta_json: toJson({
          name,
          type: source.type,
          duration_estimate_minutes: source.duration,
          week_index: week,
          day_index: day,
        }),
        author_id: actor.id,
        author_kind: actor.authorKind,
        cause: source.sourcePlanId ? 'clone' : 'initial',
      },
    });
    return planId;
  }

  async clearDay(
    userId: string,
    programId: string,
    week: number,
    day: number,
  ): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_PROGRAM_GRID}::int4, hashtext(${programId}))`;
      const program = await this.loadEditableTx(tx, actor, programId);
      this.assertSlot(program, week, day);
      const plan = await tx.workoutPlan.findFirst({
        where: { program_id: programId, week_index: week, day_index: day, archived_at: null },
        select: { id: true },
      });
      if (!plan) return; // already empty: idempotent
      const remaining = await tx.workoutPlan.count({
        where: { program_id: programId, archived_at: null },
      });
      if (remaining <= 1) {
        const inPackage = await tx.coachPackageContent.count({
          where: {
            asset_type: 'workout_program',
            asset_id: programId,
            removed_at: null,
            package: { archived_at: null },
          },
        });
        if (inPackage > 0) {
          throw new ConflictException(
            err(
              'program_in_package_needs_a_day',
              'This is the last workout in a program that a package delivers. Add another day first, or remove the program from the package.',
            ),
          );
        }
      }
      await tx.workoutPlan.update({ where: { id: plan.id }, data: { archived_at: new Date() } });
      await this.bumpRevision(tx, actor, programId, 'manual_edit');
    });
    return this.detail(actor, programId);
  }

  async duplicateProgram(
    userId: string,
    programId: string,
    dto: DuplicateProgramDto,
    idempotencyKey: string,
  ): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    const source = await this.loadReadable(actor, programId);
    const result = await this.workoutBuilder.withIdempotency(
      userId,
      `programs:duplicate:${programId}`,
      idempotencyKey,
      async () => {
        const id = randomUUID();
        await this.prisma.$transaction(async (tx) => {
          await tx.workoutProgram.create({
            data: {
              id,
              coach_id: actor.tenantId,
              owner_user_id: actor.id,
              visibility: 'owner_only',
              forked_from_id: source.id,
              name: (dto.name?.trim() || `${source.name} (copy)`).slice(0, 120),
              description: source.description,
              goal_tag: source.goal_tag,
              weeks: source.weeks,
              days_per_week: source.days_per_week,
              is_template: true,
              version: 0,
            },
          });
          const plans = await tx.workoutPlan.findMany({
            where: { program_id: source.id, archived_at: null },
            orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
            include: { exercises: { where: { archived_at: null }, orderBy: { order: 'asc' } } },
          });
          for (const p of plans) {
            await this.writeDayPlan(tx, actor, id, p.week_index ?? 0, p.day_index ?? 0, {
              name: p.name,
              type: p.type,
              duration: p.duration_estimate_minutes ?? null,
              sourcePlanId: p.id,
              exercises: p.exercises.map((e) => ({
                exercise_external_id: e.exercise_external_id,
                order: e.order,
                sets: e.sets,
                reps_or_duration_seconds: e.reps_or_duration_seconds,
                weight_lbs: e.weight_lbs ?? null,
                rest_seconds: e.rest_seconds ?? null,
                superset_group_id: e.superset_group_id ?? null,
                notes: e.notes ?? null,
              })),
            });
          }
          await this.bumpRevision(tx, actor, id, 'clone');
        });
        return { id };
      },
    );
    return this.detail(actor, result.id);
  }

  async archiveProgram(userId: string, programId: string): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    const program = await this.loadReadable(actor, programId);
    if (program.owner_user_id !== actor.id) {
      throw new ForbiddenException(
        err('program_read_only', 'Only the coach who made this program can archive it.'),
      );
    }
    if (program.archived_at) return this.detail(actor, programId);
    // One transaction holding the master's row lock (C-640-9): an "Add to
    // package" takes the same FOR UPDATE lock before it inserts, so either the
    // attach commits first and is seen here, or it waits and then sees the
    // archive.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "WorkoutProgram" WHERE "id" = ${programId} FOR UPDATE`;
      const contents = await tx.coachPackageContent.findMany({
        where: {
          asset_type: 'workout_program',
          asset_id: programId,
          removed_at: null,
          package: { archived_at: null },
        },
        select: { package: { select: { name: true } } },
      });
      if (contents.length > 0) {
        const names = Array.from(new Set(contents.map((c) => c.package.name))).join(', ');
        throw new ConflictException(
          err(
            'program_in_package',
            `New clients of ${names} receive this program. Remove it from ${contents.length === 1 ? 'that package' : 'those packages'} first, then archive it.`,
          ),
        );
      }
      await tx.workoutProgram.updateMany({
        where: { id: programId, owner_user_id: actor.id, archived_at: null },
        data: { archived_at: new Date() },
      });
    });
    return this.detail(actor, programId);
  }

  async restoreProgram(userId: string, programId: string): Promise<ProgramDetail> {
    const actor = await this.resolveActor(userId);
    const program = await this.loadReadable(actor, programId);
    if (program.owner_user_id !== actor.id) {
      throw new ForbiddenException(
        err('program_read_only', 'Only the coach who made this program can restore it.'),
      );
    }
    await this.prisma.workoutProgram.updateMany({
      where: { id: programId, owner_user_id: actor.id, archived_at: { not: null } },
      data: { archived_at: null },
    });
    return this.detail(actor, programId);
  }

  async listRevisions(userId: string, programId: string) {
    const actor = await this.resolveActor(userId);
    await this.loadReadable(actor, programId);
    const rows = await this.prisma.workoutProgramRevision.findMany({
      where: { program_id: programId },
      orderBy: { revision_index: 'desc' },
      take: REVISIONS_MAX,
      select: {
        revision_index: true,
        cause: true,
        author_kind: true,
        created_at: true,
        structure_json: true,
      },
    });
    return {
      items: rows.map((r) => {
        const s = (r.structure_json ?? {}) as {
          weeks?: unknown;
          days_per_week?: unknown;
          days?: unknown;
          plan_ids?: unknown;
          name?: unknown;
        };
        const dayCount = Array.isArray(s.days)
          ? s.days.length
          : Array.isArray(s.plan_ids)
            ? s.plan_ids.length
            : null;
        return {
          revision_index: r.revision_index,
          cause: r.cause,
          author_kind: r.author_kind,
          created_at: r.created_at.toISOString(),
          name: typeof s.name === 'string' ? s.name : null,
          weeks: typeof s.weeks === 'number' ? s.weeks : null,
          days_per_week: typeof s.days_per_week === 'number' ? s.days_per_week : null,
          day_count: dayCount,
        };
      }),
    };
  }

  // ─── saved workouts ─────────────────────────────────────────────────────

  /**
   * The saved-workouts library: the actor's own standalone plans (not a program
   * day, not archived). ONE predicate for both the list and the "copy a saved
   * workout into a day" source (C-640-9), so a day can only be filled from a
   * workout the coach can see in the picker.
   */
  private savedWorkoutWhere(actor: ProgramActor): Prisma.WorkoutPlanWhereInput {
    return { coach_id: actor.id, program_id: null, archived_at: null };
  }

  async listSavedWorkouts(
    userId: string,
    query: { q?: string; limit?: number; cursor?: string | null },
  ) {
    const actor = await this.resolveActor(userId);
    const limit = Math.min(Math.max(Math.floor(query.limit ?? PAGE_MAX), 1), PAGE_MAX);
    const q = query.q?.trim();
    const cursor = this.decodeCursor(query.cursor);
    const rows = await this.prisma.workoutPlan.findMany({
      where: {
        ...this.savedWorkoutWhere(actor),
        AND: [
          q ? { name: { contains: q, mode: 'insensitive' } } : {},
          cursor
            ? {
                OR: [
                  { updated_at: { lt: cursor.at } },
                  { updated_at: cursor.at, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        name: true,
        type: true,
        duration_estimate_minutes: true,
        updated_at: true,
        _count: { select: { exercises: { where: { archived_at: null } } } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        duration_estimate_minutes: p.duration_estimate_minutes ?? null,
        exercise_count: p._count.exercises,
        updated_at: p.updated_at.toISOString(),
      })),
      next_cursor: rows.length > limit && last ? this.encodeCursor(last.updated_at, last.id) : null,
    };
  }

  // ─── assignees / bulk assign / unassign ─────────────────────────────────

  /** Live copies of `masterId` for one client (new client_id link or legacy assignment link). */
  private copiesForClientWhere(
    masterId: string,
    clientId: string,
  ): Prisma.WorkoutProgramWhereInput {
    return {
      cloned_from_id: masterId,
      is_template: false,
      archived_at: null,
      OR: [
        { client_id: clientId },
        { client_id: null, plans: { some: { assignments: { some: { client_id: clientId } } } } },
      ],
    };
  }

  /**
   * Clients on this program, newest copy first, keyset-paginated over the copy
   * rows (C-640-10). A sub-coach sees only their delegated clients (B-640-2);
   * deleted accounts never appear (B-640-3).
   */
  async listAssignees(
    userId: string,
    programId: string,
    query: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ items: ProgramAssignee[]; next_cursor: string | null }> {
    const actor = await this.resolveActor(userId);
    await this.loadReadable(actor, programId);
    const visible = await this.visibleClientIds(actor);
    if (visible && visible.size === 0) return { items: [], next_cursor: null };
    const limit = Math.min(
      Math.max(Math.floor(query.limit ?? ASSIGNEES_PAGE_DEFAULT), 1),
      ASSIGNEES_PAGE_MAX,
    );
    const cursor = this.decodeCursor(query.cursor);
    const clientScope: Prisma.ClientWorkoutAssignmentWhereInput = {
      client: { deleted_at: null },
      ...(visible ? { client_id: { in: Array.from(visible) } } : {}),
    };
    const copies = await this.prisma.workoutProgram.findMany({
      where: {
        cloned_from_id: programId,
        is_template: false,
        archived_at: null,
        coach_id: actor.tenantId,
        plans: { some: { assignments: { some: clientScope } } },
        ...(cursor
          ? {
              OR: [
                { created_at: { lt: cursor.at } },
                { created_at: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        created_at: true,
        plans: {
          select: {
            assignments: {
              where: clientScope,
              select: { client_id: true, scheduled_for: true, completed_at: true },
            },
          },
        },
      },
    });
    const page = copies.slice(0, limit);
    const lastCopy = page[page.length - 1];
    const byKey = new Map<
      string,
      { client_id: string; copy: string; dates: Date[]; completed: number }
    >();
    for (const c of page) {
      for (const p of c.plans) {
        for (const a of p.assignments) {
          const key = `${c.id}:${a.client_id}`;
          const entry = byKey.get(key) ?? {
            client_id: a.client_id,
            copy: c.id,
            dates: [],
            completed: 0,
          };
          entry.dates.push(a.scheduled_for);
          if (a.completed_at) entry.completed += 1;
          byKey.set(key, entry);
        }
      }
    }
    const clientIds = Array.from(new Set(Array.from(byKey.values()).map((e) => e.client_id)));
    const users = clientIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: clientIds }, deleted_at: null },
          select: { id: true, name: true },
        })
      : [];
    const nameBy = new Map(users.map((u) => [u.id, u.name]));
    const items = Array.from(byKey.values())
      .filter((e) => nameBy.has(e.client_id))
      .map((e) => {
        const sorted = e.dates.slice().sort((a, b) => a.getTime() - b.getTime());
        return {
          client_id: e.client_id,
          client_name: nameBy.get(e.client_id) ?? 'Client',
          copy_program_id: e.copy,
          start_date: sorted[0].toISOString(),
          end_date: sorted[sorted.length - 1].toISOString(),
          workouts: sorted.length,
          completed: e.completed,
        };
      })
      .sort((a, b) => b.start_date.localeCompare(a.start_date));
    return {
      items,
      next_cursor:
        copies.length > limit && lastCopy
          ? this.encodeCursor(lastCopy.created_at, lastCopy.id)
          : null,
    };
  }

  async bulkAssign(
    userId: string,
    programId: string,
    dto: BulkAssignProgramDto,
    idempotencyKey: string,
  ): Promise<BulkAssignResponse> {
    const actor = await this.resolveActor(userId);
    const master = await this.loadReadable(actor, programId);
    if (master.archived_at) {
      throw new ConflictException(
        err('program_archived', 'This program is archived. Restore it before assigning it.'),
      );
    }
    const days = await this.prisma.workoutPlan.count({
      where: { program_id: programId, archived_at: null },
    });
    if (days === 0) {
      throw new UnprocessableEntityException(
        err(
          'program_empty',
          'This program has no workouts yet. Add at least one day before assigning it.',
        ),
      );
    }
    const startAt = startDateToInstant(dto.start_date);
    const results: BulkAssignResult[] = [];
    for (const clientId of dto.client_ids) {
      results.push(
        await this.assignOne(
          actor,
          master.id,
          clientId,
          startAt,
          dto.allow_repeat === true,
          idempotencyKey,
        ),
      );
    }
    for (const r of results) {
      if (r.status === 'assigned' && !r.replayed)
        this.pushProgramAssigned(r.client_id, master.name);
    }
    return {
      program_id: master.id,
      start_date: dto.start_date,
      results,
      summary: {
        total: results.length,
        assigned: results.filter((r) => r.status === 'assigned').length,
        already_assigned: results.filter((r) => r.status === 'already_assigned').length,
        failed: results.filter((r) => r.status === 'failed').length,
      },
    };
  }

  private async assignOne(
    actor: ProgramActor,
    masterId: string,
    clientId: string,
    startAt: Date,
    allowRepeat: boolean,
    idempotencyKey: string,
  ): Promise<BulkAssignResult> {
    try {
      await this.workoutBuilder.assertCanAccessClient(actor.id, clientId);
    } catch (e) {
      if (e instanceof NotFoundException) {
        return {
          client_id: clientId,
          status: 'failed',
          code: 'client_not_found',
          message: 'This client account no longer exists.',
        };
      }
      if (e instanceof ForbiddenException) {
        return {
          client_id: clientId,
          status: 'failed',
          code: 'not_your_client',
          message: 'This person is not on your client list, so the program was not assigned.',
        };
      }
      return this.unexpectedFailure(clientId, masterId, e);
    }
    // A deleted (tombstoned) account keeps its User row, so the access check
    // above can still pass for it; never copy a program onto it (B-640-3).
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { deleted_at: true },
    });
    if (!client || client.deleted_at) {
      return {
        client_id: clientId,
        status: 'failed',
        code: 'client_not_found',
        message: 'This client account no longer exists.',
      };
    }
    // The key is the whole logical intent (C-640-8): master, start date and the
    // repeat choice. Reusing one Idempotency-Key for a different program or a
    // different start date is a NEW intent, never a silent replay of the first
    // result; it then meets the already-assigned guard below like any request.
    const intent = `${masterId}:${startAt.toISOString().slice(0, 10)}:${allowRepeat ? 'repeat' : 'once'}`;
    const deliveryKey = `bulk:${actor.id}:${intent}:${idempotencyKey}:${clientId}`;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_PROGRAM_ASSIGN}::int4, hashtext(${`${masterId}:${clientId}`}))`;
          const replay = await tx.workoutProgram.findUnique({
            where: { delivery_key: deliveryKey },
            select: { id: true },
          });
          if (!replay && !allowRepeat) {
            const active = await tx.workoutProgram.findFirst({
              where: {
                ...this.copiesForClientWhere(masterId, clientId),
                plans: {
                  some: { assignments: { some: { client_id: clientId, completed_at: null } } },
                },
              },
              select: { id: true },
            });
            if (active) {
              return {
                client_id: clientId,
                status: 'already_assigned' as const,
                program_id: active.id,
                code: 'program_already_assigned',
                message:
                  'This client already has this program in progress. Assign again to start a second run.',
              };
            }
          }
          const delivered = await this.delivery.deliverInTx(tx, {
            masterProgramId: masterId,
            tenantCoachId: actor.tenantId,
            actingUserId: actor.id,
            authorKind: actor.authorKind,
            clientId,
            startAt,
            deliveryKey,
            source: 'bulk_assign',
          });
          return {
            client_id: clientId,
            status: 'assigned' as const,
            replayed: delivered.replayed,
            program_id: delivered.program_id,
            workouts: delivered.assignment_ids.length,
            first_scheduled_for: delivered.first_scheduled_for,
            last_scheduled_for: delivered.last_scheduled_for,
          };
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (e) {
      if (e instanceof ProgramEmptyError) {
        return {
          client_id: clientId,
          status: 'failed',
          code: 'program_empty',
          message: 'This program has no workouts yet. Add at least one day before assigning it.',
        };
      }
      if (e instanceof HttpException) {
        const body = e.getResponse();
        const code =
          typeof body === 'object' && body && 'code' in body
            ? String((body as { code: unknown }).code)
            : 'assign_failed';
        const message =
          typeof body === 'object' &&
          body &&
          'message' in body &&
          typeof (body as { message: unknown }).message === 'string'
            ? String((body as { message: string }).message)
            : 'The program could not be assigned to this client. Try again.';
        return { client_id: clientId, status: 'failed', code, message };
      }
      return this.unexpectedFailure(clientId, masterId, e);
    }
  }

  private unexpectedFailure(clientId: string, masterId: string, e: unknown): BulkAssignResult {
    const reference = randomUUID();
    this.logger.error(
      `bulkAssign: master=${masterId} client=${clientId} reference=${reference} failed: ${(e as Error)?.message ?? String(e)}`,
    );
    Sentry.withScope((scope) => {
      scope.setTag('mwb.bulk_assign_reference', reference);
      Sentry.captureException(e);
    });
    return {
      client_id: clientId,
      status: 'failed',
      code: 'assign_failed',
      message: `This client was not assigned because of a server problem. Try again, or contact support with reference ${reference}.`,
    };
  }

  private pushProgramAssigned(clientId: string, programName: string): void {
    if (!this.notifications) return;
    void this.notifications
      .createNotification({
        user_id: clientId,
        kind: NotificationKind.WORKOUT_ASSIGNED,
        body: `Your coach added the program ${programName} to your plan.`,
        deep_link: 'tgp://workouts',
        channel: 'push',
        payload: { kind: 'program_assigned' },
      })
      .catch((e: unknown) => {
        this.logger.warn(
          `bulkAssign: push failed for client=${clientId} (assignment stands): ${(e as Error)?.message}`,
        );
      });
  }

  async unassignClient(userId: string, programId: string, clientId: string) {
    const actor = await this.resolveActor(userId);
    await this.loadReadable(actor, programId);
    await this.workoutBuilder.assertCanAccessClient(actor.id, clientId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_PROGRAM_ASSIGN}::int4, hashtext(${`${programId}:${clientId}`}))`;
      const copies = await tx.workoutProgram.findMany({
        where: { ...this.copiesForClientWhere(programId, clientId), coach_id: actor.tenantId },
        select: { id: true },
      });
      if (copies.length === 0) {
        throw new NotFoundException(
          err('program_not_assigned', 'This client does not have this program.'),
        );
      }
      const copyIds = copies.map((c) => c.id);
      const removed = await tx.clientWorkoutAssignment.deleteMany({
        where: {
          client_id: clientId,
          completed_at: null,
          started_at: null,
          workout_plan: { program_id: { in: copyIds } },
        },
      });
      const kept = await tx.clientWorkoutAssignment.count({
        where: { client_id: clientId, workout_plan: { program_id: { in: copyIds } } },
      });
      await tx.workoutProgram.updateMany({
        where: { id: { in: copyIds } },
        data: { archived_at: new Date() },
      });
      return {
        program_id: programId,
        client_id: clientId,
        removed_workouts: removed.count,
        kept_workouts: kept,
      };
    });
  }

  // ─── cursor ─────────────────────────────────────────────────────────────

  private encodeCursor(at: Date, id: string): string {
    return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64');
  }

  private decodeCursor(cursor: string | null | undefined): { at: Date; id: string } | null {
    if (!cursor) return null;
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const at = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(at.getTime()) || !id) return null;
    return { at, id };
  }
}
