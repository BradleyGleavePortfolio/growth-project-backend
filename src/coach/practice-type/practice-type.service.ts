import { Injectable, ForbiddenException } from '@nestjs/common';
import { CoachPracticeType } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * PracticeTypeService — Stage-3 coach practice selection.
 *
 * Backs the `/api/coach/practice` endpoint pair used by the mobile
 * practice-selection flow on coach signup and the Settings → Practice
 * change row. Source of truth is the `User.coach_practice_type` enum
 * column added by `20260509120000_coach_practice_type_stage3`.
 *
 * Concurrency note: this is a simple field write. We do not need a
 * transaction — the only concurrent-edit risk would be two devices
 * for the same coach changing practice type simultaneously, in which
 * case the last write wins, which is the right semantics for a user-
 * authored preference.
 */
@Injectable()
export class PracticeTypeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fetch the current practice type for a coach. `null` = not selected. */
  async get(coachId: string): Promise<{ practice_type: CoachPracticeType | null }> {
    const u = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { coach_practice_type: true, role: true },
    });
    if (!u) {
      // Should never happen — the JWT guard already verified the user.
      // Return a typed shape rather than 404 to avoid a misleading
      // "user not found" UX on a logged-in coach.
      return { practice_type: null };
    }
    if (u.role !== 'coach' && u.role !== 'owner') {
      throw new ForbiddenException({
        error: 'Practice type is only meaningful for coach or owner roles',
        code: 'NOT_A_COACH',
      });
    }
    return { practice_type: u.coach_practice_type };
  }

  /** Set or change the practice type. */
  async set(
    coachId: string,
    practiceType: CoachPracticeType,
  ): Promise<{ practice_type: CoachPracticeType }> {
    const u = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { role: true },
    });
    if (!u || (u.role !== 'coach' && u.role !== 'owner')) {
      throw new ForbiddenException({
        error: 'Only coaches or owners can set a practice type',
        code: 'NOT_A_COACH',
      });
    }
    const updated = await this.prisma.user.update({
      where: { id: coachId },
      data: { coach_practice_type: practiceType },
      select: { coach_practice_type: true },
    });
    return { practice_type: updated.coach_practice_type! };
  }
}
