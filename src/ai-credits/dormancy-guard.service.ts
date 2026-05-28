import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// DormancyGuardService — encapsulates the "3 consecutive unread briefs"
// check that gates AI auto-generation crons.
//
// Why it exists as its own service rather than inline in the brief
// scheduler:
//   - The same check is reused by the weekly-insight cron (spec §1 item
//     12), so a single owner of the rule prevents drift.
//   - Test surface stays narrow: T6 in the spec covers it directly here.
//
// The threshold is tunable via COACH_AI_DORMANCY_UNREAD_THRESHOLD (default
// 3). Lower values are more aggressive (more skips, more cost protection,
// more chance of skipping a legitimately-engaged coach). 3 is the
// operator-chosen default from the audit doc.

export const COACH_AI_DORMANCY_UNREAD_THRESHOLD_DEFAULT = 3;

function resolveThreshold(): number {
  const raw = process.env.COACH_AI_DORMANCY_UNREAD_THRESHOLD;
  if (!raw) return COACH_AI_DORMANCY_UNREAD_THRESHOLD_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return COACH_AI_DORMANCY_UNREAD_THRESHOLD_DEFAULT;
  return n;
}

@Injectable()
export class DormancyGuardService {
  private readonly logger = new Logger(DormancyGuardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns true when the coach should be SKIPPED by AI auto-generation
   * (their most recent N briefs are all unread). Returns false when the
   * coach is engaged (at least one of the most recent N briefs has a
   * non-null read_at).
   *
   * If the coach has fewer than N briefs total we return false (engaged):
   * we cannot prove dormancy without a full window of data, and a new
   * coach has not yet had a chance to read a brief.
   */
  async shouldSkipCoach(coachId: string): Promise<boolean> {
    const threshold = resolveThreshold();
    const recent = await this.prisma.coachBrief.findMany({
      where: { coach_id: coachId },
      orderBy: { brief_date: 'desc' },
      take: threshold,
      select: { read_at: true },
    });
    if (recent.length < threshold) return false;
    return recent.every((b) => b.read_at === null);
  }
}
