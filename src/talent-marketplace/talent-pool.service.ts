/**
 * TalentPoolService — Phase 11 / Track 8
 *
 * Provides talent-pool search for Scale+ tier head-coaches. Returns
 * CoachApplication rows with status in ['approved', 'pool'].
 *
 * Access control: only Scale+ tier head-coaches may browse the pool.
 * The tier check uses `TALENT_POOL_PRICE_ID` (env var) matched against
 * CoachSubscription.stripe_price_id. If the env var is unset, access is
 * granted to any coach with an active subscription (permissive fallback for
 * development; set the env var in production).
 *
 * FOLLOW-UP NOTE (Track 8.5): replace the stripe_price_id check with a proper
 * `BillingService.hasFeature(userId, 'talent_pool')` helper once the entitlements
 * module exposes that API. The boolean `canViewTalentPool` guard pattern is
 * intentionally isolated here so refactoring it requires touching only this file.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { SearchPoolQueryDto } from './coach-offer.dto';
import { buildTupleCursor, parseTupleCursor } from './coach-application.service';

@Injectable()
export class TalentPoolService {
  private readonly logger = new Logger(TalentPoolService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search the talent pool. Throws ForbiddenException if the requesting
   * user does not have an active Scale+ subscription.
   *
   * canViewTalentPool logic:
   *   1. User must have an active CoachSubscription row (status === 'active').
   *   2. If TALENT_POOL_PRICE_ID env var is set, stripe_price_id must match.
   *      If unset, any active subscription passes (dev/staging fallback).
   *
   * TODO (Track 8.5): replace with BillingService.hasFeature(userId, 'talent_pool').
   */
  async searchPool(
    query: SearchPoolQueryDto,
    requestingUserId: string,
  ) {
    const canView = await this.canViewTalentPool(requestingUserId);
    if (!canView) {
      throw new ForbiddenException(
        'Talent pool access requires an active Scale+ subscription.',
      );
    }

    const take = query.take ?? 20;
    const cursor = parseTupleCursor(query.cursor);

    const rows = await this.prisma.coachApplication.findMany({
      where: {
        status: { in: ['approved', 'pool'] },
        ...(query.specialty
          ? {
              specializations: {
                hasSome: [query.specialty],
              },
            }
          : {}),
        ...(query.min_availability !== undefined
          ? { availability_hours_per_week: { gte: query.min_availability } }
          : {}),
        ...(query.work_type
          ? {
              preferences: {
                // work_type is validated against WorkTypeEnum at the DTO layer,
                // so this JSON path is always one of the closed-set keys.
                path: [query.work_type],
                equals: true,
              },
            }
          : {}),
        ...(cursor
          ? {
              OR: [
                { created_at: { lt: cursor.createdAt } },
                {
                  AND: [
                    { created_at: cursor.createdAt },
                    { id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      take,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        first_name: true,
        last_name: true,
        certifications: true,
        specializations: true,
        years_experience: true,
        availability_hours_per_week: true,
        preferred_client_type: true,
        preferences: true,
        background_verified: true,
        status: true,
        created_at: true,
        // PII fields (email, sample_program_url) are omitted from pool browse.
        // Full details are shared only after an offer is accepted.
      },
    });

    this.logger.debug(
      `Pool search for user ${requestingUserId}: ${rows.length} results`,
    );

    const last = rows.length === take ? rows[rows.length - 1] : undefined;
    return {
      data: rows,
      next_cursor: last ? buildTupleCursor(last) : null,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Determines whether a user may view the talent pool.
   * Exposed for testability.
   */
  async canViewTalentPool(userId: string): Promise<boolean> {
    const subscription = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: userId },
      select: { status: true, stripe_price_id: true },
    });

    if (!subscription || subscription.status !== 'active') {
      return false;
    }

    const requiredPriceId = process.env['TALENT_POOL_PRICE_ID'];
    if (requiredPriceId) {
      return subscription.stripe_price_id === requiredPriceId;
    }

    // No price ID configured: allow any active subscription (dev/staging).
    this.logger.warn(
      'TALENT_POOL_PRICE_ID is not set — talent pool is open to all active subscribers.',
    );
    return true;
  }
}
