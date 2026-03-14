import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class WorkoutService {
  constructor(private prisma: PrismaService) {}

  async createWorkout(userId: string, data: any) {
    const { exercises, ...sessionData } = data;
    return this.prisma.workoutSession.create({
      data: {
        ...sessionData,
        user_id: userId,
        date: new Date(sessionData.date || new Date()),
        exercises: exercises ? { create: exercises } : undefined,
      },
      include: { exercises: true },
    });
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

  async createRoutine(userId: string, data: any) {
    const { exercises, ...routineData } = data;
    return this.prisma.workoutRoutine.create({
      data: {
        ...routineData,
        creator_id: userId,
        exercises: exercises ? { create: exercises } : undefined,
      },
      include: { exercises: true },
    });
  }

  async updateRoutine(userId: string, id: string, data: any) {
    const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
    if (!routine || routine.creator_id !== userId) throw new NotFoundException('Routine not found');
    return this.prisma.workoutRoutine.update({ where: { id }, data });
  }

  async deleteRoutine(userId: string, id: string) {
    const routine = await this.prisma.workoutRoutine.findUnique({ where: { id } });
    if (!routine || routine.creator_id !== userId) throw new NotFoundException('Routine not found');
    return this.prisma.workoutRoutine.delete({ where: { id } });
  }
}
