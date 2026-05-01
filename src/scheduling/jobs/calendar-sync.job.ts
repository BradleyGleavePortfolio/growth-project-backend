import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

// Calendar-sync job seam. Future shape:
//
//   1. For each CalendarConnection where disconnected_at IS NULL,
//      pull recent events from the provider since last_synced_at.
//   2. Reconcile against CoachingSession rows by calendar_event_id.
//   3. Update last_synced_at; the provider-side cancel/reschedule
//      operations show up as audit entries scoped tenant-wide.
//
// In this PR the job exists only so the scheduling service can
// reference a typed dependency; no real sync is performed.
@Injectable()
export class CalendarSyncJob {
  private readonly logger = new Logger(CalendarSyncJob.name);

  constructor(private readonly prisma: PrismaService) {}

  async listSyncCandidates() {
    return this.prisma.calendarConnection.findMany({
      where: { disconnected_at: null },
      orderBy: { last_synced_at: 'asc' },
    });
  }
}
