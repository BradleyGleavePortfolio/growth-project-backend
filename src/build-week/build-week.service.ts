import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { PtmService } from '../ptm/ptm.service';
import { MilestoneService } from '../packages/milestone.service';
import type {
  BuildWeekActionItemDto,
  BuildWeekDayCompletionDto,
  BuildWeekDayDto,
  BuildWeekEnrollmentDto,
  BuildWeekFunnelDto,
  CompleteDayDto,
} from './build-week.dto';

// Total days in a Build Week. The catalog is seeded 1..7 by the migration;
// the service treats 7 as the milestone day that fires the PTM signal.
const TOTAL_DAYS = 7;

// PTM signal type emitted on Day 7 completion. Matches the PtmSignalTypeT
// enum in src/ptm/ptm.types.ts. Keep the metadata.source string stable —
// the heuristic engine and the funnel report both filter on it.
const PTM_BUILD_WEEK_SIGNAL = 'finance_milestone' as const;

/**
 * BuildWeekService — Phase 4.
 *
 * Tenancy:
 *   * Catalog reads (`getDays`, `getDayDetail`) are global — anyone with a
 *     valid JWT can read the day catalog. The catalog is product copy.
 *   * Enrollment / completion writes are user-scoped. The controller pulls
 *     the user id from the JWT; this service never trusts a body-supplied
 *     userId.
 *   * Coach reads of a client's enrollment go through the dedicated
 *     coach-build-week controller, which calls `getEnrollmentForCoach()`
 *     after asserting the client belongs to the coach.
 *
 * Sequential ordering:
 *   * `completeDay(N)` requires `enrollment.current_day === N`. We do NOT
 *     auto-skip ahead, even if the catalog row exists. Skipping is a
 *     coaching-doctrine violation (every day is a deliberate beat) and
 *     ConflictException is the contract — the mobile UI surfaces a clean
 *     "wait, you're on day X" message.
 */
@Injectable()
export class BuildWeekService {
  private readonly logger = new Logger(BuildWeekService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ptm: PtmService,
    // PR-11 — optional injection so pre-existing build-week unit tests
    // (test/build-week.service.spec.ts) that pass three constructor
    // arguments continue to work. In production wiring (BuildWeekModule
    // imports PackagesModule), MilestoneService is always present.
    @Optional() private readonly milestones?: MilestoneService,
  ) {}

  // PR-11 — live milestone keys emitted from this module. The string
  // value is what coaches put in cadence_payload.milestone_key when
  // attaching an on_milestone CoachPackageContent. Stable: never rename
  // without coordinating with already-purchased ScheduledDrop snapshots.
  public static readonly BUILD_WEEK_COMPLETE_KEY = 'build_week_complete';

  // ---- catalog reads --------------------------------------------------

  async getDays(): Promise<BuildWeekDayDto[]> {
    const rows = await this.prisma.buildWeekDay.findMany({
      orderBy: { day_number: 'asc' },
    });
    return rows.map((row) => this.toDayDto(row));
  }

  async getDayDetail(
    userId: string,
    dayNumber: number,
  ): Promise<{ day: BuildWeekDayDto; completion: BuildWeekDayCompletionDto | null }> {
    this.assertDayNumber(dayNumber);
    const day = await this.prisma.buildWeekDay.findUnique({
      where: { day_number: dayNumber },
    });
    if (!day) throw new NotFoundException('Day not found');

    const enrollment = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: userId },
      include: {
        completions: { where: { day_number: dayNumber }, take: 1 },
      },
    });

    const completionRow = enrollment?.completions[0] ?? null;
    return {
      day: this.toDayDto(day),
      completion: completionRow ? this.toCompletionDto(completionRow) : null,
    };
  }

  // ---- enrollment -----------------------------------------------------

  /**
   * Idempotent. If the user already has an enrollment row, returns it
   * unchanged when status==='active'; resets it to a fresh active state
   * (status='active', current_day=1, started_at=now, completed_at=null,
   * existing completions cleared) when prior status is 'completed' or
   * 'abandoned'. Either way the audit log records the transition.
   */
  async enroll(userId: string): Promise<BuildWeekEnrollmentDto> {
    const existing = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: userId },
      include: { completions: { orderBy: { day_number: 'asc' } } },
    });
    if (existing && existing.status === 'active') {
      return this.toEnrollmentDto(existing);
    }

    if (existing) {
      // Re-enroll: collapse the same row in place. Wipe prior completions
      // so the user genuinely starts over from day 1; the AuditLog entry
      // below captures that the prior cycle existed and was reset.
      const prior = {
        prior_status: existing.status,
        prior_current_day: existing.current_day,
        prior_completed_at: existing.completed_at?.toISOString() ?? null,
      };
      const reset = await this.prisma.$transaction(async (tx) => {
        await tx.buildWeekDayCompletion.deleteMany({
          where: { enrollment_id: existing.id },
        });
        return tx.buildWeekEnrollment.update({
          where: { id: existing.id },
          data: {
            started_at: new Date(),
            current_day: 1,
            status: 'active',
            completed_at: null,
          },
          include: { completions: true },
        });
      });
      await this.audit.write({
        action: 'build_week.enrolled',
        actorId: userId,
        targetUserId: userId,
        targetType: 'build_week_enrollment',
        targetId: reset.id,
        metadata: { reenroll: true, ...prior },
      });
      return this.toEnrollmentDto(reset);
    }

    const created = await this.prisma.buildWeekEnrollment.create({
      data: {
        user_id: userId,
        current_day: 1,
        status: 'active',
      },
      include: { completions: true },
    });
    await this.audit.write({
      action: 'build_week.enrolled',
      actorId: userId,
      targetUserId: userId,
      targetType: 'build_week_enrollment',
      targetId: created.id,
      metadata: { reenroll: false },
    });
    return this.toEnrollmentDto(created);
  }

  async getMyEnrollment(userId: string): Promise<BuildWeekEnrollmentDto | null> {
    const row = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: userId },
      include: { completions: { orderBy: { day_number: 'asc' } } },
    });
    return row ? this.toEnrollmentDto(row) : null;
  }

  // ---- day completion -------------------------------------------------

  async completeDay(
    userId: string,
    dayNumber: number,
    dto: CompleteDayDto,
  ): Promise<BuildWeekEnrollmentDto> {
    this.assertDayNumber(dayNumber);
    const enrollment = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: userId },
    });
    if (!enrollment) {
      throw new NotFoundException('No active Build Week enrollment');
    }
    if (enrollment.status !== 'active') {
      throw new ConflictException(
        `Enrollment is ${enrollment.status}; re-enroll to start over`,
      );
    }
    if (enrollment.current_day !== dayNumber) {
      throw new ConflictException(
        `Day ${dayNumber} is not the current day (currently on day ${enrollment.current_day})`,
      );
    }

    const isFinalDay = dayNumber === TOTAL_DAYS;
    const updated = await this.prisma.$transaction(async (tx) => {
      // Idempotency: if a completion row already exists for this day,
      // upsert keeps the original `completed_at` and overwrites the body.
      // current_day still advances; the unique constraint guarantees we
      // never create a duplicate.
      await tx.buildWeekDayCompletion.upsert({
        where: {
          BuildWeekDayCompletion_enrollment_day_key: {
            enrollment_id: enrollment.id,
            day_number: dayNumber,
          },
        },
        create: {
          enrollment_id: enrollment.id,
          day_number: dayNumber,
          responses: dto.responses as Prisma.InputJsonValue,
          artifact_text: dto.artifact_text ?? null,
        },
        update: {
          responses: dto.responses as Prisma.InputJsonValue,
          artifact_text: dto.artifact_text ?? null,
        },
      });
      return tx.buildWeekEnrollment.update({
        where: { id: enrollment.id },
        data: {
          current_day: isFinalDay ? TOTAL_DAYS : dayNumber + 1,
          status: isFinalDay ? 'completed' : 'active',
          completed_at: isFinalDay ? new Date() : null,
        },
        include: { completions: { orderBy: { day_number: 'asc' } } },
      });
    });

    await this.audit.write({
      action: 'build_week.day_completed',
      actorId: userId,
      targetUserId: userId,
      targetType: 'build_week_enrollment',
      targetId: enrollment.id,
      metadata: { day_number: dayNumber, total_days: TOTAL_DAYS },
    });

    // PTM signal: only on the milestone day. Days 1–6 are tracked in the
    // catalog itself; emitting on every day would drown the heuristic
    // engine in noise that does not match the `finance_milestone`
    // signal's meaning.
    if (isFinalDay) {
      this.ptm.emit(userId, PTM_BUILD_WEEK_SIGNAL, 1, {
        source: 'build_week',
        day_number: dayNumber,
        total_days: TOTAL_DAYS,
      });
      // PR-11 — also emit the 'build_week_complete' named milestone so
      // any matching on_milestone drip drops the buyer has waiting in
      // a purchased package fire on the next DripDispatcherCron tick.
      // MilestoneService.emit is fire-and-forget and never throws; we
      // explicitly do NOT await its result in a way that would gate
      // the completion response, but we do await it inside this branch
      // because a failure path in the trigger still must not surface
      // to the caller (the service swallows it).
      if (this.milestones) {
        await this.milestones.emit(
          userId,
          BuildWeekService.BUILD_WEEK_COMPLETE_KEY,
        );
      }
    }

    return this.toEnrollmentDto(updated);
  }

  // ---- coach + admin reads --------------------------------------------

  /**
   * Returns the enrollment + completions for a client. Caller is
   * responsible for tenancy assertion (see CoachBuildWeekController).
   * Returns null when the client has never enrolled.
   */
  async getEnrollmentForCoach(
    clientId: string,
  ): Promise<BuildWeekEnrollmentDto | null> {
    const row = await this.prisma.buildWeekEnrollment.findUnique({
      where: { user_id: clientId },
      include: { completions: { orderBy: { day_number: 'asc' } } },
    });
    return row ? this.toEnrollmentDto(row) : null;
  }

  async listEnrollments(params: {
    status?: string;
    completedAfter?: Date;
    before?: Date;
    limit?: number;
  }): Promise<{ items: BuildWeekEnrollmentDto[]; next_cursor: string | null }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const where: Prisma.BuildWeekEnrollmentWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.completedAfter) where.completed_at = { gte: params.completedAfter };
    if (params.before) where.started_at = { lt: params.before };
    const rows = await this.prisma.buildWeekEnrollment.findMany({
      where,
      orderBy: { started_at: 'desc' },
      take: limit,
      include: { completions: { orderBy: { day_number: 'asc' } } },
    });
    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => this.toEnrollmentDto(r)),
      next_cursor: rows.length === limit && last ? last.started_at.toISOString() : null,
    };
  }

  /**
   * Aggregate funnel. `reached[N]` = number of enrollments whose
   * current_day passed through day N (i.e. has a completion for day N
   * or current_day > N). `dropped[N]` = reached[N] minus reached[N+1]
   * — the count of users stuck at day N. Day 7's `dropped` is anyone
   * who reached 7 without completing it (status !== 'completed').
   */
  async funnel(): Promise<BuildWeekFunnelDto> {
    const enrollments = await this.prisma.buildWeekEnrollment.findMany({
      select: { id: true, current_day: true, status: true },
    });
    const completionsByDay = await this.prisma.buildWeekDayCompletion.groupBy({
      by: ['day_number'],
      _count: { _all: true },
    });
    const reachedByDay = new Map<number, number>();
    for (const c of completionsByDay) {
      reachedByDay.set(c.day_number, c._count._all);
    }

    const total = enrollments.length;
    const completed = enrollments.filter((e) => e.status === 'completed').length;

    const dropoff: BuildWeekFunnelDto['dropoff_per_day'] = [];
    for (let d = 1; d <= TOTAL_DAYS; d++) {
      const reached = reachedByDay.get(d) ?? 0;
      const reachedNext = d === TOTAL_DAYS ? completed : (reachedByDay.get(d + 1) ?? 0);
      dropoff.push({
        day_number: d,
        reached,
        dropped: Math.max(0, reached - reachedNext),
      });
    }

    return {
      total_enrolled: total,
      total_completed: completed,
      completion_rate: total === 0 ? 0 : completed / total,
      dropoff_per_day: dropoff,
    };
  }

  // ---- mappers --------------------------------------------------------

  private assertDayNumber(dayNumber: number): void {
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > TOTAL_DAYS) {
      throw new BadRequestException(`day_number must be an integer in 1..${TOTAL_DAYS}`);
    }
  }

  private toDayDto(row: {
    id: string;
    day_number: number;
    title: string;
    focus_area: string;
    narrative: string;
    prompt_questions: Prisma.JsonValue;
    action_items: Prisma.JsonValue;
    expected_artifact: string;
  }): BuildWeekDayDto {
    return {
      id: row.id,
      day_number: row.day_number,
      title: row.title,
      focus_area: row.focus_area,
      narrative: row.narrative,
      prompt_questions: Array.isArray(row.prompt_questions)
        ? (row.prompt_questions as unknown as string[])
        : [],
      action_items: Array.isArray(row.action_items)
        ? (row.action_items as unknown as BuildWeekActionItemDto[])
        : [],
      expected_artifact: row.expected_artifact,
    };
  }

  private toCompletionDto(row: {
    id: string;
    day_number: number;
    completed_at: Date;
    responses: Prisma.JsonValue;
    artifact_text: string | null;
  }): BuildWeekDayCompletionDto {
    return {
      id: row.id,
      day_number: row.day_number,
      completed_at: row.completed_at.toISOString(),
      responses:
        row.responses && typeof row.responses === 'object' && !Array.isArray(row.responses)
          ? (row.responses as Record<string, unknown>)
          : {},
      artifact_text: row.artifact_text,
    };
  }

  private toEnrollmentDto(row: {
    id: string;
    user_id: string;
    started_at: Date;
    current_day: number;
    status: string;
    completed_at: Date | null;
    completions: {
      id: string;
      day_number: number;
      completed_at: Date;
      responses: Prisma.JsonValue;
      artifact_text: string | null;
    }[];
  }): BuildWeekEnrollmentDto {
    return {
      id: row.id,
      user_id: row.user_id,
      started_at: row.started_at.toISOString(),
      current_day: row.current_day,
      status: row.status,
      completed_at: row.completed_at?.toISOString() ?? null,
      completions: row.completions.map((c) => this.toCompletionDto(c)),
    };
  }
}
