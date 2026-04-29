import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ConsentScope, ConsentService } from '../consent/consent.service';

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

  async getClients(
    coachId: string,
    status: 'active' | 'archived' | 'all' = 'active',
    callerRole?: string,
  ) {
    let archiveFilter: object = {};
    if (status === 'active') {
      archiveFilter = { archived_at: null };
    } else if (status === 'archived') {
      archiveFilter = { archived_at: { not: null } };
    }
    return this.prisma.user.findMany({
      where: {
        ...this.byCoach(coachId, callerRole),
        role: 'student',
        ...archiveFilter,
      },
      include: { profile: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async archiveClient(
    coachId: string,
    clientId: string,
    callerRole?: string,
    ctx: AuditContext = {},
  ) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...this.byCoach(coachId, callerRole) },
    });
    if (!client) throw new Error('Client not found');
    if (client.archived_at) {
      // Idempotent — re-archive is a no-op and skips the audit row to
      // avoid polluting the log on a double-tap.
      return client;
    }
    const updated = await this.prisma.user.update({
      where: { id: clientId },
      data: { archived_at: new Date() },
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
    return updated;
  }

  async unarchiveClient(
    coachId: string,
    clientId: string,
    callerRole?: string,
    ctx: AuditContext = {},
  ) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...this.byCoach(coachId, callerRole) },
    });
    if (!client) throw new Error('Client not found');
    if (!client.archived_at) {
      // Idempotent — already active, skip audit.
      return client;
    }
    const updated = await this.prisma.user.update({
      where: { id: clientId },
      data: { archived_at: null },
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
    return updated;
  }

  async getClientTimeline(
    coachId: string,
    clientId: string,
    days: number = 90,
    callerRole?: string,
  ) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...this.byCoach(coachId, callerRole) },
    });
    if (!client) return { error: 'Client not found' };

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - days);

    // Per-scope consent gating. A scope the client has not granted
    // returns an empty slice rather than a 403 — the rest of the
    // timeline still renders. Owners bypass the check.
    const flags = await this.loadFitnessConsents(coachId, clientId, callerRole);

    const [meals, workouts, weights, checkIns] = await Promise.all([
      flags.food
        ? this.prisma.loggedFoodEntry.findMany({
            where: { user_id: clientId, logged_at: { gte: ninetyDaysAgo } },
            include: { food_item: true },
            orderBy: { logged_at: 'desc' },
          })
        : Promise.resolve<LoggedFoodEntryWithFood[]>([]),
      flags.workouts
        ? this.prisma.workoutSession.findMany({
            where: { user_id: clientId, created_at: { gte: ninetyDaysAgo } },
            include: { exercises: true },
            orderBy: { created_at: 'desc' },
          })
        : Promise.resolve<WorkoutSessionWithExercises[]>([]),
      flags.bodyMetrics
        ? this.prisma.weightLog.findMany({
            where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
            orderBy: { date: 'desc' },
          })
        : Promise.resolve<WeightLogRow[]>([]),
      flags.habitsProgress
        ? this.prisma.checkIn.findMany({
            where: { user_id: clientId, date: { gte: ninetyDaysAgo } },
            orderBy: { date: 'desc' },
          })
        : Promise.resolve<CheckInRow[]>([]),
    ]);

    const events: Array<{ type: string; date: Date; ref: unknown }> = [
      ...meals.map((m) => ({ type: 'meal', date: m.logged_at, ref: m })),
      ...workouts.map((w) => ({ type: 'workout', date: w.created_at, ref: w })),
      ...weights.map((w) => ({ type: 'weight', date: w.date, ref: w })),
      ...checkIns.map((c) => ({ type: 'check_in', date: c.date, ref: c })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      client,
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

  async postGuidelines(coachId: string, clientId: string, guidelines: string) {
    return this.prisma.coachGuideline.upsert({
      where: {
        CoachGuideline_coach_client_key: { coach_id: coachId, client_id: clientId },
      },
      create: { coach_id: coachId, client_id: clientId, content: guidelines },
      update: { content: guidelines },
    });
  }

  async getGuidelines(coachOrClientId: string, clientId?: string) {
    if (clientId) {
      return this.prisma.coachGuideline.findUnique({
        where: {
          CoachGuideline_coach_client_key: {
            coach_id: coachOrClientId,
            client_id: clientId,
          },
        },
      });
    }
    return this.prisma.coachGuideline.findFirst({
      where: { client_id: coachOrClientId },
      orderBy: { updated_at: 'desc' },
    });
  }

  async getClientSummary(
    coachId: string,
    clientId: string,
    date?: string,
    callerRole?: string,
  ) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, ...this.byCoach(coachId, callerRole) },
      include: { profile: true },
    });
    if (!client) return { error: 'Client not found' };

    const today = date || new Date().toISOString().split('T')[0];
    const startOfDay = new Date(today + 'T00:00:00.000Z');
    const endOfDay = new Date(today + 'T23:59:59.999Z');
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Per-scope consent gating, same shape as getClientTimeline.
    const flags = await this.loadFitnessConsents(coachId, clientId, callerRole);

    const [todayEntries, weightLogs, recentWorkouts] = await Promise.all([
      flags.food
        ? this.prisma.loggedFoodEntry.findMany({
            where: { user_id: clientId, logged_at: { gte: startOfDay, lte: endOfDay } },
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

    const clients = await this.prisma.user.findMany({
      where: { ...this.byCoach(coachId, callerRole), role: 'student' },
      select: { id: true },
    });

    if (clients.length === 0) {
      return { logs_today: 0, total_kcal: 0, logging_rate: 0 };
    }

    const clientIds = clients.map((c) => c.id);

    const todayEntries = await this.prisma.loggedFoodEntry.findMany({
      where: {
        user_id: { in: clientIds },
        logged_at: { gte: startOfDay, lte: endOfDay },
      },
      include: { food_item: true },
    });

    const clientsLoggedToday = new Set(todayEntries.map((e) => e.user_id));
    const logs_today = clientsLoggedToday.size;

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

  async getAlerts(coachId: string, callerRole?: string) {
    const clients = await this.prisma.user.findMany({
      where: { ...this.byCoach(coachId, callerRole), role: 'student' },
    });

    if (clients.length === 0) return [];

    const clientIds = clients.map((c) => c.id);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    const [allRecentWeightLogs, workoutGroups] = await Promise.all([
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
