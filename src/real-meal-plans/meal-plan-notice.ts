import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { NotificationKind } from '../notifications/notification-kind';
import type { NotificationsService } from '../notifications/notifications.service';

/**
 * MEAL-PLAN-NOTICE-BE (owner #203-E45): the one place a client is told their meal plan changed. Every coach or
 * AI write that changes what GET /me/meal-plan/today shows a client today, and every new assignment, calls
 * tellMealPlanChange after its write commits and never waits on it (the class table is in the PR).
 *  - Recipients: only the coach's own clients (coachStudent, the rule of assertClientOfCoach and
 *    listAssignmentsForCoach): never a client who moved, another coach's client or a coach.
 *  - Link: an assignment in force today (inForceWhere, getTodayForClient's own where) opens itself,
 *    tgp://meal-plan/<id>; anything else (a plan that starts later, one the write took off today, two at once)
 *    opens the day, tgp://plan.
 *  - One per burst: no notice while the client has a meal plan notice with the same link from the last
 *    MEAL_PLAN_NOTICE_WINDOW_MS (the first change tells; the tap reads the plan live).
 *  - One inbox row (the fixed title and ids only; the AI draft's own words stay its row body) and one push through
 *    sendPush (Mute all, quiet hours, the fixed lock-screen words). It never throws.
 */
export const MEAL_PLAN_NOTICE_WINDOW_MS = 10 * 60_000;

const WORDS = {
  [NotificationKind.MEAL_PLAN_UPDATED]: { title: 'Meal plan updated', body: 'Your coach updated your meal plan.' },
  [NotificationKind.MEAL_PLAN_ASSIGNED]: { title: 'New meal plan', body: 'Your coach assigned a new meal plan.' },
};

type Assignment = { id: string; client_id: string };

export interface MealPlanChange {
  coachId: string;
  kind: keyof typeof WORDS;
  /** today: only assignments in force today hear; created: new ones, even when they start later; gone: the write took them off today. */
  reach: 'today' | 'created' | 'gone';
  assignments: Assignment[] | (() => Promise<Assignment[]>);
  rowBody?: string;
  payload?: Record<string, string>;
}

const logger = new Logger('MealPlanNotice');

/** The coach's own client. */
export const coachStudent = (coachId: string) => ({ coach_id: coachId, role: 'student' as const });

/** getTodayForClient's day: the server's midnight of ?date, or of now. */
export function planDay(dateIso?: string): Date {
  const day = dateIso ? new Date(dateIso) : new Date();
  day.setHours(0, 0, 0, 0);
  return day;
}

/** A plan applies on `day` if starts_on <= day and (ends_on is null or ends_on >= day). */
export function inForceWhere(clientId: string, day: Date): Prisma.DailyMealPlanAssignmentWhereInput {
  return {
    client_id: clientId,
    starts_on: { lte: day },
    OR: [{ ends_on: null }, { ends_on: { gte: day } }],
    // MEALPLAN-END (OWN-1): an archive hides a plan from its own coach's client, as GET /meal-plans and
    // Roman's context do; a moved client keeps an earlier coach's plan, frozen copy included (owner 4).
    daily_meal_plan: { OR: [{ archived_at: null }, { coach: { students: { none: { id: clientId } } } }] },
  };
}

/** The ones of these assignments their client sees today. */
export async function inForceToday(prisma: PrismaService, assignments: Assignment[]): Promise<Assignment[]> {
  if (assignments.length === 0) return [];
  const day = planDay();
  return prisma.dailyMealPlanAssignment.findMany({
    where: {
      id: { in: assignments.map((a) => a.id) },
      OR: [...new Set(assignments.map((a) => a.client_id))].map((clientId) => inForceWhere(clientId, day)),
    },
    select: { id: true, client_id: true },
  });
}

export async function tellMealPlanChange(
  prisma: PrismaService,
  notifications: NotificationsService | undefined,
  change: MealPlanChange,
): Promise<void> {
  if (!notifications) return;
  try {
    const all = typeof change.assignments === 'function' ? await change.assignments() : change.assignments;
    if (all.length === 0) return;
    const theirs = new Set(
      (
        await prisma.user.findMany({
          where: { id: { in: [...new Set(all.map((a) => a.client_id))] }, ...coachStudent(change.coachId) },
          select: { id: true },
        })
      ).map((u) => u.id),
    );
    const reached = all.filter((a) => theirs.has(a.client_id));
    const today = new Set(change.reach === 'gone' ? [] : (await inForceToday(prisma, reached)).map((a) => a.id));
    const links = new Map<string, Set<string>>();
    for (const a of reached) {
      if (change.reach === 'today' && !today.has(a.id)) continue;
      const link = today.has(a.id) ? `tgp://meal-plan/${a.id}` : 'tgp://plan';
      links.set(a.client_id, (links.get(a.client_id) ?? new Set<string>()).add(link));
    }
    const words = WORDS[change.kind];
    for (const [clientId, set] of links) {
      const deepLink = set.size === 1 ? [...set][0] : 'tgp://plan';
      const told = await prisma.notification.findFirst({
        where: {
          user_id: clientId,
          kind: { in: [NotificationKind.MEAL_PLAN_UPDATED, NotificationKind.MEAL_PLAN_ASSIGNED] },
          deep_link: deepLink,
          created_at: { gte: new Date(Date.now() - MEAL_PLAN_NOTICE_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (told) continue;
      await notifications.createNotification({
        user_id: clientId,
        kind: change.kind,
        body: change.rowBody ?? words.body,
        deep_link: deepLink,
        channel: 'inapp',
        payload: { title: words.title, ...change.payload },
      });
      await notifications.sendPush({ user_id: clientId, kind: change.kind, body: words.body, deep_link: deepLink });
    }
  } catch (err) {
    logger.warn(`meal plan notice skipped: kind=${change.kind} error=${err instanceof Error ? err.name : 'unknown'}`);
  }
}
