/**
 * S-MWB Programs — copy a master program onto ONE client, exactly once.
 *
 * Shared by the two "everyone gets it" paths of the coach Programs library:
 *   - bulk assign  (ProgramLibraryService.bulkAssign), and
 *   - package delivery (WorkoutAssetResolver, asset_type `workout_program`),
 *     which PurchaseFanoutService runs for paid checkouts AND for $0 invite
 *     grants / free-package claims (#595).
 *
 * What one delivery writes, in ONE transaction:
 *   WorkoutProgram (is_template=false, cloned_from_id=master, client_id,
 *   delivery_key) -> WorkoutPlan per master day (+ exercise rows, revision 0,
 *   head pointer) -> WorkoutProgramRevision 0 -> ClientWorkoutAssignment per
 *   day scheduled at start + (week*7 + day) days, each with its immutable
 *   ClientWorkoutAssignmentSnapshot.
 *
 * Exactly-once: `delivery_key` is UNIQUE (migration 20270223000000). A
 * transaction-scoped advisory lock on the key serialises two workers racing on
 * the same key (inline fan-out vs. drip cron, a double-tapped bulk assign); the
 * loser waits, then finds the winner's committed row and replays it. Because
 * the copy is written in the caller's transaction when one is supplied, a
 * rolled-back purchase/grant transaction rolls the copy back too, and the retry
 * writes it again (no ledger row can claim a copy that does not exist).
 *
 * Masters are copied BY VALUE: later edits to the master never change a
 * client's copy (the same rule MWB-1 snapshots enforce for assignments).
 * Ids are generated here so every level is written with createMany (a few
 * statements per client rather than several per day), which keeps a 50-client
 * bulk assign of a 12-week program inside one request.
 */
import { randomUUID } from 'crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/** Advisory-lock namespace (int4) for program delivery keys. */
export const ADVISORY_LOCK_NAMESPACE_MWB_DELIVERY = 0x4d574244; // 'MWBD'

const DAY_MS = 24 * 60 * 60 * 1000;

export type ProgramDeliverySource = 'bulk_assign' | 'package';

export interface DeliverProgramInput {
  masterProgramId: string;
  /** Tenant (head coach) id: the coach_id written on every copied row. */
  tenantCoachId: string;
  /** The coach (or sub-coach) the copy is attributed to (owner + assigned_by). */
  actingUserId: string;
  authorKind: 'coach' | 'sub_coach';
  clientId: string;
  /** Instant of day 0 (week 0 / day 0). */
  startAt: Date;
  deliveryKey: string;
  source: ProgramDeliverySource;
}

export interface DeliveredProgram {
  program_id: string;
  assignment_ids: string[];
  first_assignment_id: string;
  first_plan_id: string;
  first_scheduled_for: string;
  last_scheduled_for: string;
  /** true when the key had already been delivered (nothing new written). */
  replayed: boolean;
}

/** The master has no live days; nothing can be delivered. */
export class ProgramEmptyError extends Error {
  constructor(public readonly programId: string) {
    super(`Program ${programId} has no workouts to deliver`);
    this.name = 'ProgramEmptyError';
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class ProgramDeliveryService {
  private readonly logger = new Logger(ProgramDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Is `programId` a master program of `tenantCoachId` that a package may
   * deliver? Archived masters still deliver (a package that already contains a
   * program keeps honouring it; new attachments are refused at authoring time).
   */
  async findDeliverableMaster(
    tenantCoachId: string,
    programId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ id: string; name: string } | null> {
    return db.workoutProgram.findFirst({
      where: { id: programId, coach_id: tenantCoachId, is_template: true },
      select: { id: true, name: true },
    });
  }

  /**
   * Is `assetId` any master program (no tenancy filter: this only decides
   * whether the inline fan-out defers the drop to the dispatcher, which runs
   * the full tenant + client checks when it delivers).
   */
  async isProgramMaster(
    assetId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const row = await db.workoutProgram.findFirst({
      where: { id: assetId, is_template: true },
      select: { id: true },
    });
    return row != null;
  }

  /** Deliver in a NEW transaction (cron path, bulk assign). */
  async deliver(input: DeliverProgramInput): Promise<DeliveredProgram> {
    return this.prisma.$transaction((tx) => this.deliverInTx(tx, input), {
      maxWait: 10_000,
      timeout: 30_000,
    });
  }

  /** Deliver inside the caller's transaction (inline purchase / grant fan-out). */
  async deliverInTx(
    tx: Prisma.TransactionClient,
    input: DeliverProgramInput,
  ): Promise<DeliveredProgram> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE_MWB_DELIVERY}::int4, hashtext(${input.deliveryKey}))`;

    const existing = await tx.workoutProgram.findUnique({
      where: { delivery_key: input.deliveryKey },
      select: { id: true },
    });
    if (existing) return this.replay(tx, existing.id);

    const master = await tx.workoutProgram.findFirst({
      where: { id: input.masterProgramId, coach_id: input.tenantCoachId, is_template: true },
    });
    if (!master) {
      throw new NotFoundException({
        code: 'program_not_found',
        message: 'This program no longer exists in your library.',
      });
    }
    const masterPlans = await tx.workoutPlan.findMany({
      where: { program_id: master.id, archived_at: null },
      orderBy: [{ week_index: 'asc' }, { day_index: 'asc' }],
      include: { exercises: { where: { archived_at: null }, orderBy: { order: 'asc' } } },
    });
    if (masterPlans.length === 0) throw new ProgramEmptyError(master.id);

    const programId = randomUUID();
    const programRevisionId = randomUUID();
    const planRows: Prisma.WorkoutPlanCreateManyInput[] = [];
    const exerciseRows: Prisma.WorkoutPlanExerciseCreateManyInput[] = [];
    const planRevisionRows: Prisma.WorkoutPlanRevisionCreateManyInput[] = [];
    const assignmentRows: Prisma.ClientWorkoutAssignmentCreateManyInput[] = [];
    const snapshotRows: Prisma.ClientWorkoutAssignmentSnapshotCreateManyInput[] = [];
    const scheduled: Date[] = [];

    for (const src of masterPlans) {
      const planId = randomUUID();
      const planRevisionId = randomUUID();
      const groupRemap = new Map<string, string>();
      const remap = (g: string | null): string | null => {
        if (g == null) return null;
        const hit = groupRemap.get(g);
        if (hit) return hit;
        const fresh = `${planId}:${groupRemap.size}`;
        groupRemap.set(g, fresh);
        return fresh;
      };
      const rows = src.exercises.map((e) => ({
        exercise_external_id: e.exercise_external_id,
        order: e.order,
        sets: e.sets,
        reps_or_duration_seconds: e.reps_or_duration_seconds,
        weight_lbs: e.weight_lbs ?? null,
        rest_seconds: e.rest_seconds ?? null,
        superset_group_id: remap(e.superset_group_id ?? null),
        notes: e.notes ?? null,
      }));
      planRows.push({
        id: planId,
        coach_id: input.tenantCoachId,
        name: src.name,
        type: src.type,
        duration_estimate_minutes: src.duration_estimate_minutes,
        program_id: programId,
        week_index: src.week_index,
        day_index: src.day_index,
        is_template: false,
        version: 1,
        head_revision_id: planRevisionId,
        cloned_from_plan_id: src.id,
      });
      for (const r of rows) exerciseRows.push({ ...r, workout_plan_id: planId });
      planRevisionRows.push({
        id: planRevisionId,
        workout_plan_id: planId,
        revision_index: 0,
        exercises_json: toJson(rows),
        plan_meta_json: toJson({
          name: src.name,
          type: src.type,
          duration_estimate_minutes: src.duration_estimate_minutes ?? null,
          week_index: src.week_index ?? null,
          day_index: src.day_index ?? null,
        }),
        author_id: input.actingUserId,
        author_kind: input.authorKind,
        cause: 'clone',
      });
      const offsetDays = (src.week_index ?? 0) * 7 + (src.day_index ?? 0);
      const scheduledFor = new Date(input.startAt.getTime() + offsetDays * DAY_MS);
      scheduled.push(scheduledFor);
      const assignmentId = randomUUID();
      assignmentRows.push({
        id: assignmentId,
        workout_plan_id: planId,
        client_id: input.clientId,
        assigned_by_coach_id: input.actingUserId,
        scheduled_for: scheduledFor,
      });
      snapshotRows.push({
        assignment_id: assignmentId,
        plan_name: src.name,
        plan_type: src.type,
        exercises_json: toJson(rows),
        source_plan_id: planId,
        source_version: 1,
      });
    }

    try {
      await tx.workoutProgram.create({
        data: {
          id: programId,
          coach_id: input.tenantCoachId,
          owner_user_id: input.actingUserId,
          visibility: 'owner_only',
          name: master.name,
          description: master.description,
          weeks: master.weeks,
          days_per_week: master.days_per_week,
          is_template: false,
          cloned_from_id: master.id,
          goal_tag: master.goal_tag,
          version: 1,
          head_revision_id: programRevisionId,
          client_id: input.clientId,
          delivery_key: input.deliveryKey,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique delivery_key: another worker committed this delivery between
        // our lock wait and the insert (only possible across isolation levels
        // that pin the snapshot). Never a second copy; the caller retries and
        // replays the winner.
        throw new ConflictException({
          code: 'program_delivery_in_progress',
          message: 'This program is being delivered right now. Try again in a moment.',
        });
      }
      throw err;
    }
    await tx.workoutPlan.createMany({ data: planRows });
    if (exerciseRows.length > 0) await tx.workoutPlanExercise.createMany({ data: exerciseRows });
    await tx.workoutPlanRevision.createMany({ data: planRevisionRows });
    await tx.workoutProgramRevision.create({
      data: {
        id: programRevisionId,
        program_id: programId,
        revision_index: 0,
        structure_json: toJson({
          program_id: programId,
          weeks: master.weeks,
          days_per_week: master.days_per_week,
          cloned_from_id: master.id,
          plan_ids: planRows.map((p) => p.id),
          client_id: input.clientId,
          source: input.source,
        }),
        author_id: input.actingUserId,
        author_kind: input.authorKind,
        cause: 'clone',
      },
    });
    await tx.clientWorkoutAssignment.createMany({ data: assignmentRows });
    await tx.clientWorkoutAssignmentSnapshot.createMany({ data: snapshotRows });

    this.logger.log(
      `deliver: master=${master.id} copy=${programId} client=${input.clientId} days=${planRows.length} source=${input.source}`,
    );
    const first = assignmentRows[0];
    return {
      program_id: programId,
      assignment_ids: assignmentRows.map((a) => String(a.id)),
      first_assignment_id: String(first.id),
      first_plan_id: String(first.workout_plan_id),
      first_scheduled_for: scheduled[0].toISOString(),
      last_scheduled_for: scheduled[scheduled.length - 1].toISOString(),
      replayed: false,
    };
  }

  private async replay(tx: Prisma.TransactionClient, programId: string): Promise<DeliveredProgram> {
    const assignments = await tx.clientWorkoutAssignment.findMany({
      where: { workout_plan: { program_id: programId } },
      orderBy: [{ scheduled_for: 'asc' }, { id: 'asc' }],
      select: { id: true, workout_plan_id: true, scheduled_for: true },
    });
    if (assignments.length === 0) {
      // A delivered copy whose assignments were all removed (coach unassigned
      // the client). The key stays spent: a replay must never resurrect it.
      throw new ConflictException({
        code: 'program_delivery_removed',
        message: 'This program was removed from this client after it was delivered.',
      });
    }
    const first = assignments[0];
    const last = assignments[assignments.length - 1];
    return {
      program_id: programId,
      assignment_ids: assignments.map((a) => a.id),
      first_assignment_id: first.id,
      first_plan_id: first.workout_plan_id,
      first_scheduled_for: first.scheduled_for.toISOString(),
      last_scheduled_for: last.scheduled_for.toISOString(),
      replayed: true,
    };
  }
}
