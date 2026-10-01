import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationKind } from '../notifications/notification-kind';
import {
  dateFromKey,
  dateKey,
  decideReminder,
  reminderCopy,
  resolveTimezone,
} from './workout-reminder.policy';

// C05 item 7 — workout reminders.
//
// MECHANISM: a five-minute @Cron (same claim-by-write pattern as the session
// reminder job and the drip dispatcher). Each tick walks clients who finished
// onboarding and, per client:
//   1. opt-out: NotificationPreferences.muted or workout_reminder_push=false
//      -> nothing (Settings > Notifications > Workout reminders, default on);
//   2. decideReminder(): client-local date/time (NotificationPreferences.timezone)
//      is the first session day (C1) or a day with a scheduled plan workout,
//      and local time is inside [slot, slot + 3h] for their S2 answer;
//   3. skip when that day's session is already logged (assignment completed
//      or a WorkoutSession on that date);
//   4. claim WorkoutReminderDelivery (client_id, local_date) @unique, THEN
//      send. A lost claim (another replica, a retry, a restart) sends nothing,
//      so a client gets at most one reminder per local day. A crash between
//      claim and push loses that day's reminder rather than risk a second one.

const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;

export interface ReminderTickStats {
  considered: number;
  sent: number;
  opted_out: number;
  already_logged: number;
  already_sent: number;
  not_due: number;
  failed: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class WorkoutReminderService {
  private readonly logger = new Logger(WorkoutReminderService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(process.env.WORKOUT_REMINDER_CRON ?? '*/5 * * * *', {
    name: 'workout-reminders',
    timeZone: 'UTC',
  })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.WORKOUT_REMINDERS_ENABLED === 'false') return;
    if (this.running) return;
    this.running = true;
    try {
      const s = await this.runOnce();
      if (s.sent + s.failed > 0) {
        this.logger.log(
          `workout-reminders tick: considered=${s.considered} sent=${s.sent} failed=${s.failed} opted_out=${s.opted_out} already_logged=${s.already_logged}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `workout-reminders tick crashed: ${err instanceof Error ? err.name : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }

  async runOnce(now: Date = new Date()): Promise<ReminderTickStats> {
    const stats: ReminderTickStats = {
      considered: 0,
      sent: 0,
      opted_out: 0,
      already_logged: 0,
      already_sent: 0,
      not_due: 0,
      failed: 0,
    };
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.clientOnboardingIntake.findMany({
        where: {
          completed_at: { not: null },
          client: { deleted_at: null, deletion_scheduled_at: null, role: 'student' },
        },
        select: {
          id: true,
          client_id: true,
          first_session_date: true,
          preferred_training_time: true,
        },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      for (const row of page) {
        stats.considered += 1;
        try {
          const outcome = await this.processClient(
            row.client_id,
            row.first_session_date ? dateKey(row.first_session_date) : null,
            row.preferred_training_time,
            now,
          );
          stats[outcome] += 1;
        } catch (err) {
          stats.failed += 1;
          this.logger.warn(
            `workout-reminders client=${row.client_id} failed (${err instanceof Error ? err.name : 'unknown'})`,
          );
        }
      }
      if (page.length < PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }
    return stats;
  }

  async processClient(
    clientId: string,
    firstSessionDate: string | null,
    preferredTime: string | null,
    now: Date,
  ): Promise<Exclude<keyof ReminderTickStats, 'considered'>> {
    const prefs = await this.notifications.getPreferences(clientId);
    const p: Record<string, unknown> = { ...prefs };
    if (p.muted === true || p.workout_reminder_push === false) return 'opted_out';
    const timezone = resolveTimezone(p.timezone);

    // Pass 1: which local day is it, and does it carry a plan workout?
    const probe = decideReminder({
      now,
      timezone,
      preferredTime,
      firstSessionDate,
      planDates: new Set<string>(),
    });
    const dayStart = dateFromKey(probe.localDate);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const assignments = await this.prisma.clientWorkoutAssignment.findMany({
      where: { client_id: clientId, scheduled_for: { gte: dayStart, lt: dayEnd } },
      select: { id: true, completed_at: true },
      orderBy: { scheduled_for: 'asc' },
    });
    const decision = decideReminder({
      now,
      timezone,
      preferredTime,
      firstSessionDate,
      planDates: new Set(assignments.length > 0 ? [probe.localDate] : []),
    });
    if (!decision.send) return 'not_due';

    // Already trained today -> no reminder.
    if (assignments.some((a) => a.completed_at !== null)) return 'already_logged';
    const logged = await this.prisma.workoutSession.findFirst({
      where: { user_id: clientId, date: dayStart },
      select: { id: true },
    });
    if (logged) return 'already_logged';

    // Claim the day before anything goes out.
    let deliveryId: string;
    try {
      const created = await this.prisma.workoutReminderDelivery.create({
        data: {
          client_id: clientId,
          local_date: dayStart,
          timezone,
          slot: decision.slot,
          first_day: decision.firstDay,
          status: 'sending',
        },
        select: { id: true },
      });
      deliveryId = created.id;
    } catch (err) {
      if (isUniqueViolation(err)) return 'already_sent';
      throw err;
    }

    const { title, body } = reminderCopy(decision.localDate, decision.firstDay);
    const deepLink = assignments[0] ? `tgp://workouts/${assignments[0].id}` : 'tgp://workouts';
    const payload = {
      local_date: decision.localDate,
      first_day: decision.firstDay,
      assignment_id: assignments[0]?.id ?? null,
    };
    try {
      await this.notifications.createNotification({
        user_id: clientId,
        kind: NotificationKind.WORKOUT_REMINDER,
        body,
        payload,
        deep_link: deepLink,
        channel: 'inapp',
      });
    } catch (err) {
      this.logger.warn(
        `workout-reminders in-app row failed client=${clientId} (${err instanceof Error ? err.name : 'unknown'})`,
      );
    }
    const push = await this.notifications.pushToUser(clientId, title, body, {
      kind: NotificationKind.WORKOUT_REMINDER,
      deep_link: deepLink,
      ...payload,
    });
    await this.prisma.workoutReminderDelivery.update({
      where: { id: deliveryId },
      data: push.delivered ? { status: 'sent', sent_at: now } : { status: 'failed' },
    });
    return push.delivered ? 'sent' : 'failed';
  }
}
