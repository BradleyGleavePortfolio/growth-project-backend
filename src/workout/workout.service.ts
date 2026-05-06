import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PtmService } from '../ptm/ptm.service';
import { CreateWorkoutDto, CreateRoutineDto, UpdateRoutineDto } from './workout.dto';

@Injectable()
export class WorkoutService {
  constructor(
    private prisma: PrismaService,
    private ptm: PtmService,
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
