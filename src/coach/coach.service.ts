import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CoachService {
  constructor(private prisma: PrismaService) {}

  async getClients(coachId: string, status: 'active' | 'archived' | 'all' = 'active') {
    let archiveFilter: object = {};
    if (status === 'active') {
      archiveFilter = { archived_at: null };
    } else if (status === 'archived') {
      archiveFilter = { archived_at: { not: null } };
    }
    // 'all' — no filter
    return this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', ...archiveFilter },
      include: { profile: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async archiveClient(coachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId },
    });
    if (!client) throw new Error('Client not found');
    return this.prisma.user.update({
      where: { id: clientId },
      data: { archived_at: new Date() },
    });
  }

  async unarchiveClient(coachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId },
    });
    if (!client) throw new Error('Client not found');
    return this.prisma.user.update({
      where: { id: clientId },
      data: { archived_at: null },
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

    // Tier-2: merged `events` stream so the mobile coach UI can render a
    // single chronological feed. Existing consumers that read
    // `meals`/`workouts`/`weights`/`checkIns` directly are untouched — we
    // only ADD the new `events` field so the shape stays backwards-compatible.
    // Event shape is `{ type, date, ref }` where `ref` points back at the
    // original row so callers can pull details without re-fetching.
    const events: Array<{ type: string; date: Date; ref: unknown }> = [
      ...meals.map((m) => ({ type: 'meal', date: m.logged_at, ref: m })),
      ...workouts.map((w) => ({ type: 'workout', date: w.created_at, ref: w })),
      ...weights.map((w) => ({ type: 'weight', date: w.date, ref: w })),
      ...checkIns.map((c) => ({ type: 'check_in', date: c.date, ref: c })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    return { client, meals, workouts, weights, checkIns, events };
  }

  // Tier-2 (Fix #9): real per-(coach, client) guidelines table. Replaces
  // the prior hack of inserting a Lesson row tagged `client:<id>` and
  // filtering Lessons by that tag. The unique (coach_id, client_id) makes
  // the write an idempotent upsert: each coach has exactly one guidelines
  // doc per client, and re-posting overwrites the content + bumps
  // updated_at automatically.
  async postGuidelines(coachId: string, clientId: string, guidelines: string) {
    return this.prisma.coachGuideline.upsert({
      where: {
        CoachGuideline_coach_client_key: { coach_id: coachId, client_id: clientId },
      },
      create: { coach_id: coachId, client_id: clientId, content: guidelines },
      update: { content: guidelines },
    });
  }

  // Two call shapes are preserved for API back-compat:
  //   getGuidelines(coachId, clientId) — coach reads guidelines they wrote for a client
  //   getGuidelines(clientId)          — client reads guidelines their coach wrote for them
  // The CoachController exposes both routes; the legacy one-arg call hits
  // `/coach/my-guidelines` and (because the controller is gated by CoachGuard)
  // is effectively only reachable by coaches today. We still implement it
  // correctly here so the moment that endpoint is moved off CoachGuard the
  // semantics are right.
  async getGuidelines(coachOrClientId: string, clientId?: string) {
    if (clientId) {
      // Coach asking for what they wrote for a specific client.
      return this.prisma.coachGuideline.findUnique({
        where: {
          CoachGuideline_coach_client_key: {
            coach_id: coachOrClientId,
            client_id: clientId,
          },
        },
      });
    }
    // Client asking for the guidelines their coach wrote for them.
    return this.prisma.coachGuideline.findFirst({
      where: { client_id: coachOrClientId },
      orderBy: { updated_at: 'desc' },
    });
  }

  async getClientSummary(coachId: string, clientId: string, date?: string) {
    // Verify this client belongs to this coach
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId },
      include: { profile: true },
    });
    if (!client) return { error: 'Client not found' };

    const today = date || new Date().toISOString().split('T')[0];
    const startOfDay = new Date(today + 'T00:00:00.000Z');
    const endOfDay = new Date(today + 'T23:59:59.999Z');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [todayEntries, weightLogs, recentWorkouts] = await Promise.all([
      this.prisma.loggedFoodEntry.findMany({
        where: { user_id: clientId, logged_at: { gte: startOfDay, lte: endOfDay } },
        include: { food_item: true },
        orderBy: { logged_at: 'asc' },
      }),
      this.prisma.weightLog.findMany({
        where: { user_id: clientId, date: { gte: thirtyDaysAgo } },
        orderBy: { date: 'desc' },
      }),
      this.prisma.workoutSession.findMany({
        where: { user_id: clientId },
        include: { exercises: true },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
    ]);

    // Calculate daily totals
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
      profile: client.profile,
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
    };
  }

  async getDashboard(coachId: string) {
    const today = new Date();
    const startOfDay = new Date(today.toISOString().split('T')[0] + 'T00:00:00.000Z');
    const endOfDay = new Date(today.toISOString().split('T')[0] + 'T23:59:59.999Z');

    // All active clients for this coach
    const clients = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
      select: { id: true },
    });

    if (clients.length === 0) {
      return { logs_today: 0, total_kcal: 0, logging_rate: 0 };
    }

    const clientIds = clients.map((c) => c.id);

    // All food entries logged today across all clients
    const todayEntries = await this.prisma.loggedFoodEntry.findMany({
      where: {
        user_id: { in: clientIds },
        logged_at: { gte: startOfDay, lte: endOfDay },
      },
      include: { food_item: true },
    });

    // Distinct clients who logged at least one meal today
    const clientsLoggedToday = new Set(todayEntries.map((e) => e.user_id));
    const logs_today = clientsLoggedToday.size;

    // Sum kcal across all entries
    let total_kcal = 0;
    for (const entry of todayEntries) {
      const qty = entry.quantity_multiplier || 1;
      const fi = entry.food_item;
      if (fi) total_kcal += (fi.calories || 0) * qty;
    }

    const logging_rate = clientIds.length > 0 ? logs_today / clientIds.length : 0;

    return {
      logs_today,
      total_kcal: Math.round(total_kcal),
      logging_rate: Math.round(logging_rate * 100) / 100,
    };
  }

  async getAlerts(coachId: string) {
    // Before: 1 + 2N queries (findMany clients, then per client: weightLog.findMany +
    //   workoutSession.findFirst). With 50 clients that's 101 sequential round-trips.
    // After: 3 queries total — one client list, one batched weight-log fetch (walked in
    //   memory), and one groupBy of recent workouts. Response shape unchanged.
    const clients = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student' },
    });

    if (clients.length === 0) return [];

    const clientIds = clients.map((c) => c.id);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const [allRecentWeightLogs, workoutGroups] = await Promise.all([
      // Pull the most recent weight logs per client in a single query. We over-fetch
      // up to 4 per client by ordering and then slicing in memory — we can't LIMIT
      // per group in Prisma, but 4*N rows is still far smaller than N round-trips.
      this.prisma.weightLog.findMany({
        where: { user_id: { in: clientIds } },
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

    // Group weight logs per-user and keep the 4 most recent for the streak check.
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
}
