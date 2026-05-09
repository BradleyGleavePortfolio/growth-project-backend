import {
  Injectable,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CoachPracticeType } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { FinanceAdminClient } from '../../admin/federation/finance-admin.client';

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
  private readonly logger = new Logger(PracticeTypeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financeClient: FinanceAdminClient,
  ) {}

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

  /**
   * Set or change the practice type.
   *
   * Sprint A — symmetric write. After persisting locally, federate the
   * value to the finance backend by email so a coach picking on the
   * fitness app does not leave the finance row null. If the finance
   * backend is unconfigured, this is best-effort (`finance_status:
   * 'skipped'`); if it is configured but errors out, we throw 503 to
   * avoid leaving asymmetric state and signal the mobile app to retry.
   *
   * `propagate` defaults to true. The federation receiver on the
   * finance side will hit our PUT with `?propagate=false` to break the
   * loop on a finance-originated change.
   */
  async set(
    coachId: string,
    practiceType: CoachPracticeType,
    options: { propagate?: boolean } = {},
  ): Promise<{
    practice_type: CoachPracticeType;
    finance_status: 'ok' | 'skipped' | 'not_found';
  }> {
    const propagate = options.propagate !== false;

    const u = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { role: true, email: true },
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

    let financeStatus: 'ok' | 'skipped' | 'not_found' = 'skipped';
    if (propagate && this.financeClient.isConfigured() && this.financeClient.hasAuth()) {
      const outcome = await this.financeClient.setCoachPracticeByEmail(
        u.email.toLowerCase(),
        practiceType,
      );
      if (outcome.kind === 'ok') {
        financeStatus = 'ok';
      } else if (outcome.kind === 'not_found') {
        financeStatus = 'not_found';
        this.logger.log(
          `Practice federation: no finance coach for ${u.email} - fitness-only mirror`,
        );
      } else {
        this.logger.error(
          `Practice federation failed for coach ${coachId}: ${outcome.reason}`,
        );
        throw new ServiceUnavailableException({
          error:
            'Could not synchronise your practice across both products. Please try again in a moment.',
          code: 'PRACTICE_FEDERATION_FAILED',
          finance_reason: outcome.reason,
        });
      }
    }

    return { practice_type: updated.coach_practice_type!, finance_status: financeStatus };
  }
}
