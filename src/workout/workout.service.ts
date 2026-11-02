import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PtmService } from '../ptm/ptm.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { summarizeExerciseSet } from '../roman/tools/roman-exercise-history';
import {
  ExerciseHistoryQueryDto,
  CreateWorkoutDto,
  CreateRoutineDto,
  CreateRoutineExerciseDto,
  UpdateRoutineDto,
  UpdateWorkoutDto,
} from './workout.dto';

/** TRAIN-BE2: Your history lists at most this many sessions, newest first; Best ever and Since week 1 read them all. */
const HISTORY_SESSIONS = 100;

/**
 * WK-1-BE: the optional Idempotency-Key on POST /workouts. Same rule as
 * packages (IDEMPOTENCY_KEY_PATTERN): 8–128 letters, digits, dots, colons,
 * dashes, underscores. The phone's queue key `${userId}:${sessionStartMs}` fits.
 */
const WORKOUT_CLIENT_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

type TopSet = { weight_lbs: number; reps: number };
const heavier = (a: TopSet, b: TopSet | null | undefined) =>
  !b || a.weight_lbs > b.weight_lbs || (a.weight_lbs === b.weight_lbs && a.reps > b.reps);

@Injectable()
export class WorkoutService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
    // M2 — bust the AI context cache after workout writes.
    private aiContext: ClientAIContextService,
  ) {}

  async createWorkout(userId: string, data: CreateWorkoutDto, clientKey?: string) {
    // WK-1-BE: a resend after a lost answer carries the same key and gets the
    // stored workout back (same shape, nothing created, no second signal).
    // No key (or a blank header) is exactly the pre-WK-1 path.
    const key = clientKey?.trim() || undefined;
    if (key !== undefined && !WORKOUT_CLIENT_KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        error: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -',
      });
    }
    if (key !== undefined) {
      const stored = await this.findByClientKey(userId, key);
      if (stored) return stored;
    }
    // Explicit field mapping — previously `...sessionData` spread the body into
    // Prisma, which (combined with `@Body() body: any` on the controller) would
    // let a client set `user_id`, `id`, etc. See audit C4/H10.
    let created;
    try {
      created = await this.prisma.workoutSession.create({
        data: {
          ...(key !== undefined ? { client_key: key } : {}),
          user_id: userId,
          date: data.date ? new Date(data.date) : new Date(),
          workout_name: data.workout_name,
          workout_type: data.workout_type,
          duration_minutes: data.duration_minutes,
          intensity: data.intensity ?? 'moderate',
          notes: data.notes,
          exercises: data.exercises
            ? {
                create: data.exercises.map((e) => ({
                  exercise_name: e.exercise_name,
                  muscle_group: e.muscle_group,
                  sets_completed: e.sets_completed,
                  reps_per_set: e.reps_per_set,
                  weight_per_set: e.weight_per_set,
                  rpe: e.rpe,
                  notes: e.notes,
                  video_url: e.video_url,
                  exercise_external_id: e.exercise_external_id,
                })),
              }
            : undefined,
        },
        include: { exercises: true },
      });
    } catch (err) {
      // Two sends of one key raced past the lookup: the unique (user_id,
      // client_key) index kept one; answer with it.
      if (key !== undefined && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const stored = await this.findByClientKey(userId, key);
        if (stored) return stored;
      }
      throw err;
    }

    // Sum weight*reps across every set on every exercise. Mirrors the
    // per-muscle-group aggregation in getVolume but flattened to a single
    // number for the PTM signal.
    let totalVolume = 0;
    for (const ex of created.exercises) {
      const reps = ex.reps_per_set;
      const weights = ex.weight_per_set;
      for (let i = 0; i < weights.length; i++) {
        totalVolume += weights[i] * (reps[i] ?? 0);
      }
    }
    this.ptm.emit(userId, 'workout_logged', Math.round(totalVolume), {
      exercise_count: created.exercises.length,
      duration_min: created.duration_minutes,
    });
    // M2 — bust AI context cache so next chat sees the new workout.
    this.aiContext.invalidateForUser(userId);

    return created;
  }

  private findByClientKey(userId: string, clientKey: string) {
    return this.prisma.workoutSession.findUnique({
      where: { user_id_client_key: { user_id: userId, client_key: clientKey } },
      include: { exercises: true },
    });
  }

  async getWorkouts(userId: string, limit = 10) {
    return this.prisma.workoutSession.findMany({
      where: { user_id: userId },
      include: { exercises: true },
      // FU-WORKLOG2-126: `date` is a calendar day, so two workouts on the
      // same day tied and came back in any order. The client's Recent
      // Workouts (and the "previous sets" hint) could show the morning
      // session above the one just finished. Newest saved first within a day.
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
      take: limit,
    });
  }

  async getVolume(userId: string, period: 'week' | 'month' = 'week') {
    const start = new Date();
    if (period === 'week') start.setDate(start.getDate() - 7);
    else start.setMonth(start.getMonth() - 1);

    const sessions = await this.prisma.workoutSession.findMany({
      where: { user_id: userId, date: { gte: start } },
      include: { exercises: true },
    });

    // Group volume by muscle group: sets * reps * weight
    const volumeMap: Record<string, number> = {};
    sessions.forEach(s => {
      s.exercises.forEach(e => {
        const vol = e.sets_completed > 0
          ? e.weight_per_set.reduce((acc, w, i) => acc + w * (e.reps_per_set[i] || 0), 0)
          : 0;
        volumeMap[e.muscle_group] = (volumeMap[e.muscle_group] || 0) + vol;
      });
    });

    return Object.entries(volumeMap).map(([muscle_group, total_volume]) => ({
      muscle_group,
      total_volume: Math.round(total_volume),
      period,
    }));
  }

  /**
   * TRAIN-BE2 (Coach's page, plan C2): each time the caller logged one exercise, over all their
   * history, for the exercise detail's Best ever, Since week 1 and Your history. Sets logged under
   * the catalog id match by id; sets logged without one (before the column, or by an older app)
   * match by name, case-insensitive. Each session carries every coach comment on its workout, a
   * former coach's included: history follows the client.
   */
  async getExerciseHistory(userId: string, q: ExerciseHistoryQueryDto) {
    const byName = { exercise_name: { equals: q.name ?? '', mode: 'insensitive' as const } };
    const legacy = q.name ? [{ exercise_external_id: null, ...byName }] : [];
    const match: Prisma.ExerciseSetWhereInput = q.exercise_id
      ? { OR: [{ exercise_external_id: q.exercise_id }, ...legacy] }
      : byName;
    const comments = {
      orderBy: { created_at: 'asc' },
      select: { body: true, coach: { select: { name: true } } },
    } as const;
    const rows = await this.prisma.exerciseSet.findMany({
      where: { ...match, workout: { user_id: userId } },
      orderBy: [{ workout: { date: 'asc' } }, { workout: { created_at: 'asc' } }, { id: 'asc' }],
      select: {
        exercise_name: true, sets_completed: true, reps_per_set: true, weight_per_set: true, rpe: true,
        workout: { select: { id: true, date: true, comments } },
      },
    });
    const sessions = rows.map((r) => {
      const { exercise: _name, ...set } = summarizeExerciseSet(r);
      const coach_comments = r.workout.comments.map((c) => ({ coach_name: c.coach.name, body: c.body }));
      return { workout_id: r.workout.id, ...set, coach_comments };
    });
    type Session = (typeof sessions)[number];
    // Oldest first, so a tie keeps the day the best top set was first lifted.
    let best: Session | null = null;
    for (const s of sessions) if (s.top_set && heavier(s.top_set, best?.top_set)) best = s;
    const point = (s: Session | null | undefined) => (s ? { date: s.date, top_set: s.top_set } : null);
    const first = point(sessions[0]);
    return { best: point(best), first, sessions: sessions.reverse().slice(0, HISTORY_SESSIONS) };
  }

  // QA P0-W1. The workout instance had no edit/delete surface — a coach
  // or client could log a workout but never correct a mistyped set,
  // remove a duplicate-submission, or fix a wrong weight/reps. Both
  // endpoints are guarded by ownership against `WorkoutSession.user_id`
  // (the participating user); coach-edits-on-behalf-of-client is out of
  // scope here and ships separately.
  async updateWorkout(userId: string, id: string, data: UpdateWorkoutDto) {
    const existing = await this.prisma.workoutSession.findUnique({
      where: { id },
      select: { id: true, user_id: true },
    });
    if (!existing || existing.user_id !== userId) {
      throw new NotFoundException('Workout not found');
    }
    // Replace-all on `exercises` so the mobile client can send the
    // corrected canonical list without per-row id bookkeeping. Wrapped
    // in a single transaction so a partial failure cannot leave the
    // session half-rewritten.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.workoutSession.update({
        where: { id },
        data: {
          date: data.date ? new Date(data.date) : undefined,
          workout_name: data.workout_name,
          workout_type: data.workout_type,
          duration_minutes: data.duration_minutes,
          intensity: data.intensity,
          notes: data.notes,
        },
      });
      if (data.exercises) {
        await tx.exerciseSet.deleteMany({ where: { workout_id: id } });
        if (data.exercises.length > 0) {
          await tx.exerciseSet.createMany({
            data: data.exercises.map((e) => ({
              workout_id: id,
              exercise_name: e.exercise_name,
              muscle_group: e.muscle_group,
              sets_completed: e.sets_completed,
              reps_per_set: e.reps_per_set,
              weight_per_set: e.weight_per_set,
              rpe: e.rpe,
              notes: e.notes,
              video_url: e.video_url,
              exercise_external_id: e.exercise_external_id,
            })),
          });
        }
      }
      return tx.workoutSession.findUnique({
        where: { id },
        include: { exercises: true },
      });
    });
    return updated;
  }

  async deleteWorkout(userId: string, id: string) {
    const existing = await this.prisma.workoutSession.findUnique({
      where: { id },
      select: { id: true, user_id: true },
    });
    if (!existing || existing.user_id !== userId) {
      throw new NotFoundException('Workout not found');
    }
    // Cascade is declared on ExerciseSet → WorkoutSession in schema, but
    // we delete the children explicitly so the audit log carries both
    // counts if/when that's added.
    await this.prisma.$transaction([
      this.prisma.exerciseSet.deleteMany({
        where: { workout_id: id },
      }),
      this.prisma.workoutSession.delete({ where: { id } }),
    ]);
    return { id, deleted: true };
  }

  async getRoutines(userId: string) {
    return this.prisma.workoutRoutine.findMany({
      where: { OR: [{ creator_id: userId }, { is_template: true }] },
      include: { exercises: { orderBy: { order_index: 'asc' } } },
    });
  }

  /**
   * EXID-BE (#189-D4 op 1): keeps a routine exercise's catalog_exercise_id only when it is the id of a
   * library row (ExerciseCatalogItem) that exists; any other id saves as null, so a stale id on a phone
   * never blocks the save. One read per save for the distinct ids sent; none when no id is sent.
   */
  private async libraryIdOf(exercises: CreateRoutineExerciseDto[] = []) {
    const sent = [
      ...new Set(exercises.map((e) => e.catalog_exercise_id).filter((id): id is string => !!id)),
    ];
    const rows = sent.length
      ? await this.prisma.exerciseCatalogItem.findMany({
          where: { id: { in: sent } },
          select: { id: true },
        })
      : [];
    const known = new Set(rows.map((r) => r.id));
    return (id?: string | null) => (id && known.has(id) ? id : null);
  }

  async createRoutine(userId: string, data: CreateRoutineDto) {
    const libraryId = await this.libraryIdOf(data.exercises);
    // Explicit field mapping — previously `...routineData` spread the body into
    // Prisma. creator_id is ALWAYS userId; `is_template` is deliberately NOT
    // exposed in the DTO (would let a client publish routines to every user).
    return this.prisma.workoutRoutine.create({
      data: {
        creator_id: userId,
        name: data.name,
        description: data.description,
        exercises: data.exercises
          ? {
              create: data.exercises.map((e) => ({
                exercise_name: e.exercise_name,
                muscle_group: e.muscle_group,
                default_sets: e.default_sets,
                default_reps: e.default_reps,
                default_rest_seconds: e.default_rest_seconds ?? 90,
                video_url: e.video_url,
                order_index: e.order_index,
                catalog_exercise_id: libraryId(e.catalog_exercise_id),
              })),
            }
          : undefined,
      },
      include: { exercises: true },
    });
  }

  async updateRoutine(userId: string, id: string, data: UpdateRoutineDto) {
    const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
    if (!routine || routine.creator_id !== userId) throw new NotFoundException('Routine not found');
    const libraryId = await this.libraryIdOf(data.exercises);
    // UX-WORKOUT-124: `exercises` (when sent) replaces the routine's list in
    // the same transaction as the name change, so an edit never leaves the
    // routine half-written.
    return this.prisma.$transaction(async (tx) => {
      await tx.workoutRoutine.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
        },
      });
      if (data.exercises) {
        await tx.routineExercise.deleteMany({ where: { routine_id: id } });
        if (data.exercises.length > 0) {
          await tx.routineExercise.createMany({
            data: data.exercises.map((e) => ({
              routine_id: id,
              exercise_name: e.exercise_name,
              muscle_group: e.muscle_group,
              default_sets: e.default_sets,
              default_reps: e.default_reps,
              default_rest_seconds: e.default_rest_seconds ?? 90,
              video_url: e.video_url,
              order_index: e.order_index,
              catalog_exercise_id: libraryId(e.catalog_exercise_id),
            })),
          });
        }
      }
      return tx.workoutRoutine.findUnique({
        where: { id },
        include: { exercises: { orderBy: { order_index: 'asc' } } },
      });
    });
  }

  async deleteRoutine(userId: string, id: string) {
    const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
    if (!routine || routine.creator_id !== userId) throw new NotFoundException('Routine not found');
    // RoutineExercise.routine_id is ON DELETE RESTRICT, so deleting a routine
    // that has exercises failed with a 500. Remove the children first.
    const [, deleted] = await this.prisma.$transaction([
      this.prisma.routineExercise.deleteMany({ where: { routine_id: id } }),
      this.prisma.workoutRoutine.delete({ where: { id } }),
    ]);
    return deleted;
  }
}
