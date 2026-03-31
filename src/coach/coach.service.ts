import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CoachService {
  constructor(private prisma: PrismaService) {}

  async getClients(coachId: string) {
    return this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
      include: { profile: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async getClientTimeline(coachId: string, clientId: string, days: number = 90) {
    // Verify this client belongs to this coach
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId },
    });
    if (!client) return { error: 'Client not found' };

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - days);

    const [meals, workouts, weights, checkIns] = await Promise.all([
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: clientId, logged_at: { gte: ninetyDaysAgo } },
        include: { food_item: true },
        orderBy: { logged_at: 'desc' },
      }),
      this.prisma.workoutSession.findMany({
        where: { user_id: clientId, created_at: { gte: ninetyDaysAgo } },
        include: { exercises: true },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.weightLog.findMany({
        where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
        orderBy: { date: 'desc' },
      }),
      this.prisma.checkIn.findMany({
        where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
        orderBy: { date: 'desc' },
      }),
    ]);

    return { client, meals, workouts, weights, checkIns };
  }

  async postGuidelines(coachId: string, clientId: string, guidelines: string) {
    // Store as a lesson with coach_id and tag for this specific client
    return this.prisma.lesson.create({
      data: {
        coach_id: coachId,
        title: `Guidelines for Client`,
        description: guidelines,
        tags: [`client:${clientId}`],
        goal_tags: [],
      },
    });
  }

  async getAlerts(coachId: string) {
    const clients = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
    });

    const alerts = [];

    for (const client of clients) {
      // Red flag 1: weight up 3+ consecutive days
      const weightLogs = await this.prisma.weightLog.findMany({
        where: { user_id: client.id },
        orderBy: { date: 'desc' },
        take: 4,
      });

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

      // Red flag 2: missed workouts 5+ days
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
      const recentWorkout = await this.prisma.workoutSession.findFirst({
        where: { user_id: client.id, date: { gte: fiveDaysAgo } },
      });

      if (!recentWorkout) {
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
}
