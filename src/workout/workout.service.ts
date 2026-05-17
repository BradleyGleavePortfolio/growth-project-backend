import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PtmService } from '../ptm/ptm.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import {
  CreateWorkoutDto,
  CreateRoutineDto,
  UpdateRoutineDto,
  UpdateWorkoutDto,
} from './workout.dto';

@Injectable()
export class WorkoutService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
    // M2 — bust the AI context cache after workout writes.
    private aiContext: ClientAIContextService,
  ) {}

  async createWorkout(userId: string, data: CreateWorkoutDto) {
    // Explicit field mapping — previously `...sessionData` spread the body into
    // Prisma, which (combined with `@Body() body: any` on the controller) would
    // let a client set `user_id`, `id`, etc. See audit C4/H10.
    const created = await this.prisma.workoutSession.create({
      data: {
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
              })),
            }
          : undefined,
      },
      include: { exercises: true },
    });

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

  async getWorkouts(userId: string, limit = 10) {
    return this.prisma.workoutSession.findMany({
      where: { user_id: userId },
      include: { exercises: true },
      orderBy: { date: 'desc' },
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

  async createRoutine(userId: string, data: CreateRoutineDto) {
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
    return this.prisma.workoutRoutine.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
      },
    });
  }

  async deleteRoutine(userId: string, id: string) {
    const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
    if (!routine || routine.creator_id !== userId) throw new NotFoundException('Routine not found');
    return this.prisma.workoutRoutine.delete({ where: { id } });
  }
}
