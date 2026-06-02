import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  PreferenceResponse,
  UpsertPreferenceDto,
} from './dto/upsert-preference.dto';

/**
 * PR-HK-3a — read-time precedence override writes.
 *
 * 50-Failures defenses:
 *  - #5 IDOR: every write/delete is scoped to the authenticated user's id —
 *    there is no path to touch another user's preference.
 *  - #29 idempotency: the write is a Prisma `upsert` on the UNIQUE
 *    (user_id, metric) key, so repeated/concurrent POSTs converge to exactly
 *    one row (no duplicate-row race, #28).
 *  - #36 no silent failure: a DELETE for a non-existent override is a clean
 *    404, not a silent no-op the client mistakes for success.
 *  - #34 logging: structured event log on write/delete (ids + metric +
 *    provider only — no health values are ever involved here).
 */
@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent upsert of the (user, metric) → preferred_provider override.
   * Concurrent writes converge to one row via the unique key (#28/#29).
   */
  async upsert(
    userId: string,
    dto: UpsertPreferenceDto,
  ): Promise<PreferenceResponse> {
    const row = await this.prisma.wearableUserMetricPreference.upsert({
      where: {
        WearablePref_user_metric_key: { user_id: userId, metric: dto.metric },
      },
      create: {
        user_id: userId,
        metric: dto.metric,
        preferred_provider: dto.preferred_provider,
      },
      update: { preferred_provider: dto.preferred_provider },
      select: {
        metric: true,
        preferred_provider: true,
        updated_at: true,
      },
    });

    this.logger.log({
      event: 'wearable_preference_upsert',
      user_id: userId,
      metric: row.metric,
      preferred_provider: row.preferred_provider,
    });

    return {
      metric: row.metric,
      preferred_provider: row.preferred_provider,
      updated_at: row.updated_at.toISOString(),
    };
  }

  /**
   * Remove the (user, metric) override so subsequent reads fall back to
   * recency. A missing override is a 404 (not a silent no-op, #36).
   */
  async remove(userId: string, metric: WearableMetricType): Promise<void> {
    const { count } = await this.prisma.wearableUserMetricPreference.deleteMany({
      where: { user_id: userId, metric },
    });
    if (count === 0) {
      throw new NotFoundException({
        error: 'WEARABLE_PREFERENCE_NOT_FOUND',
        message: `No preferred-source override set for ${metric}`,
      });
    }
    this.logger.log({
      event: 'wearable_preference_delete',
      user_id: userId,
      metric,
    });
  }

  /** Read the caller's current override for a metric, if any. */
  async get(
    userId: string,
    metric: WearableMetricType,
  ): Promise<{ metric: WearableMetricType; preferred_provider: WearableProvider } | null> {
    const row = await this.prisma.wearableUserMetricPreference.findUnique({
      where: {
        WearablePref_user_metric_key: { user_id: userId, metric },
      },
      select: { metric: true, preferred_provider: true },
    });
    return row;
  }
}
