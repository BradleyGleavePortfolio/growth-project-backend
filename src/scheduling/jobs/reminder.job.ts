import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CoachingSession } from '@prisma/client';
import { BookingEmitter } from '../../notifications/emitters/booking.emitter';
import { NotificationKind } from '../../notifications/notification-kind';
import { PrismaService } from '../../prisma.service';

// Session reminder sweep. Two cron handlers:
//
//   1h reminder  — runs every 5 minutes, sweeps [now+55m, now+65m].
//   24h reminder — runs every 15 minutes, sweeps [now+23h45m, now+24h15m].
//
// Idempotency: every fan-out INSERTs a NotificationDeliveryLog row first,
// keyed (session_id, user_id, kind). A unique-constraint violation means
// the reminder already went out for this (session, user, kind); the
// dispatcher then skips. This means two replicas can run the cron in
// parallel without double-sending.
//
// The sweeps are deliberately wider than the cron interval so a missed
// tick from a redeploy still catches every session.
//
// Status filter: only `scheduled` sessions are eligible. Sessions in any
// terminal status (`declined`, `canceled`, `no_show`, `completed`) or in
// `requested` / `pending_provider` are skipped — the test suite asserts
// this.
//
// The reminder body always names the OTHER party: clients see "session
// with $coach", coaches see "session with $client".

@Injectable()
export class SessionReminderJob {
  private readonly logger = new Logger(SessionReminderJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingEmitter: BookingEmitter,
  ) {}

  // Returns the sessions that fall in the [now, now + windowMinutes]
  // band and are still in `scheduled` state.
  async findDueReminders(windowMinutes = 60): Promise<CoachingSession[]> {
    const now = new Date();
    const upper = new Date(now.getTime() + windowMinutes * 60 * 1000);
    return this.prisma.coachingSession.findMany({
      where: {
        status: 'scheduled',
        start_at: { gte: now, lte: upper },
      },
      orderBy: { start_at: 'asc' },
    });
  }

  // 1h reminder cron — runs every 5 minutes.
  @Cron(process.env.BOOKING_REMINDER_1H_CRON ?? '*/5 * * * *', {
    name: 'booking-reminder-1h',
    timeZone: 'UTC',
  })
  async runOneHourReminderSweep(): Promise<void> {
    const enabled =
      (process.env.BOOKING_REMINDERS_ENABLED ?? 'on') !== 'off';
    if (!enabled) {
      this.logger.debug('1h reminder cron skipped — BOOKING_REMINDERS_ENABLED=off');
      return;
    }
    await this.dispatchWindow({
      lowerOffsetMinutes: 55,
      upperOffsetMinutes: 65,
      kind: NotificationKind.BOOKING_REMINDER_1H,
      emit: (recipient, otherName, session) =>
        this.bookingEmitter.emitReminder1h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: session.id,
          scheduledAt: session.start_at,
        }),
    });
  }

  // 24h reminder cron — runs every 15 minutes.
  @Cron(process.env.BOOKING_REMINDER_24H_CRON ?? '*/15 * * * *', {
    name: 'booking-reminder-24h',
    timeZone: 'UTC',
  })
  async runTwentyFourHourReminderSweep(): Promise<void> {
    const enabled =
      (process.env.BOOKING_REMINDERS_ENABLED ?? 'on') !== 'off';
    if (!enabled) {
      this.logger.debug('24h reminder cron skipped — BOOKING_REMINDERS_ENABLED=off');
      return;
    }
    await this.dispatchWindow({
      lowerOffsetMinutes: 60 * 24 - 15,
      upperOffsetMinutes: 60 * 24 + 15,
      kind: NotificationKind.BOOKING_REMINDER_24H,
      emit: (recipient, otherName, session) =>
        this.bookingEmitter.emitReminder24h({
          recipientUserId: recipient,
          otherPartyDisplayName: otherName,
          sessionId: session.id,
          scheduledAt: session.start_at,
        }),
    });
  }

  // Shared sweep helper. Public so tests can drive it deterministically
  // without faking the cron clock.
  async dispatchWindow(args: {
    lowerOffsetMinutes: number;
    upperOffsetMinutes: number;
    kind: string;
    emit: (
      recipientUserId: string,
      otherPartyDisplayName: string,
      session: CoachingSession,
    ) => Promise<void>;
  }): Promise<{ scanned: number; dispatched: number; skipped: number }> {
    const now = new Date();
    const lower = new Date(now.getTime() + args.lowerOffsetMinutes * 60 * 1000);
    const upper = new Date(now.getTime() + args.upperOffsetMinutes * 60 * 1000);
    const due = await this.prisma.coachingSession.findMany({
      where: {
        status: 'scheduled',
        start_at: { gte: lower, lte: upper },
      },
      orderBy: { start_at: 'asc' },
    });

    let dispatched = 0;
    let skipped = 0;
    for (const session of due) {
      const participants: Array<{ userId: string; otherUserId: string | null }> = [];
      if (session.client_id) {
        participants.push({
          userId: session.client_id,
          otherUserId: session.coach_id,
        });
      }
      participants.push({
        userId: session.coach_id,
        otherUserId: session.client_id,
      });

      for (const p of participants) {
        const claimed = await this.claimDelivery(session.id, p.userId, args.kind);
        if (!claimed) {
          skipped += 1;
          continue;
        }
        const otherName = await this.resolveDisplayName(p.otherUserId);
        try {
          await args.emit(p.userId, otherName, session);
          dispatched += 1;
        } catch (err) {
          this.logger.warn(
            `reminder dispatch failed: session=${session.id} user=${p.userId} kind=${args.kind} err=${(err as Error).message}`,
          );
        }
      }
    }

    if (due.length > 0) {
      this.logger.log(
        `reminder sweep kind=${args.kind} scanned=${due.length} dispatched=${dispatched} skipped=${skipped}`,
      );
    }
    return { scanned: due.length, dispatched, skipped };
  }

  // Returns true when the claim row was inserted (caller should
  // dispatch). Returns false when a duplicate already exists
  // (idempotent skip).
  private async claimDelivery(
    sessionId: string,
    userId: string,
    kind: string,
  ): Promise<boolean> {
    try {
      await this.prisma.notificationDeliveryLog.create({
        data: { session_id: sessionId, user_id: userId, kind },
      });
      return true;
    } catch {
      // Unique-violation = already claimed by an earlier sweep or a
      // concurrent replica.
      return false;
    }
  }

  private async resolveDisplayName(userId: string | null): Promise<string> {
    if (!userId) return 'Someone';
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    if (!u || !u.name) return 'Someone';
    return u.name.slice(0, 32);
  }
}
