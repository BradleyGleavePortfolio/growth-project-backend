import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

// Reminder job seam. The real implementation will iterate sessions
// starting in (now, now + window) and fan out push / email reminders
// per the user's notification preferences. For this PR it is a no-op
// scaffold so the rest of the module can call into it without coupling
// to the notifications module.
//
// The runtime cron registration is deliberately not done here yet —
// once notifications are wired in we will register a @Cron handler in
// SchedulingModule. For now, this class can be invoked manually from a
// script or from a unit test, and it returns the candidate sessions it
// *would* notify so tests can assert behaviour.
@Injectable()
export class SessionReminderJob {
  private readonly logger = new Logger(SessionReminderJob.name);

  constructor(private readonly prisma: PrismaService) {}

  // Returns the sessions that fall in the [now, now + windowMinutes]
  // band and are still in `scheduled` state. The caller is expected to
  // dispatch reminders for each — but this PR ships no dispatcher.
  async findDueReminders(windowMinutes = 60) {
    const now = new Date();
    const upper = new Date(now.getTime() + windowMinutes * 60 * 1000);
    const due = await this.prisma.coachingSession.findMany({
      where: {
        status: 'scheduled',
        start_at: { gte: now, lte: upper },
      },
      orderBy: { start_at: 'asc' },
    });
    if (due.length > 0) {
      this.logger.debug(
        `findDueReminders: ${due.length} session(s) in next ${windowMinutes}m (no dispatch yet — scaffold)`,
      );
    }
    return due;
  }
}
