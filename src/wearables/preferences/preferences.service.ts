import { Injectable, Logger } from '@nestjs/common';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  PreferenceResponse,
  UpsertPreferenceDto,
} from './dto/upsert-preference.dto';

/**
 * PR-HK-3a / HK-6b — read-time precedence override writes.
 *
 * This service is a PURE persistence + structured-log layer. It performs NO
 * authorization (mirroring how `WearableInsightsService` factors it) — the
 * controller decides whose row may be written (caller's own, or an assigned
 * client for a coach-on-behalf write) BEFORE calling in. The service simply
 * writes the `effectiveUserId` row and records WHO initiated it (`callerId`)
 * for the audit trail.
 *
 * 50-Failures defenses:
 *  - #5 IDOR: the controller authorizes the (caller, effectiveUserId) pair
 *    against the coach→client assignment relation before this layer runs, so
 *    there is no path for an unauthorized caller to touch another user's row.
 *  - #29 idempotency: the write is a Prisma `upsert` on the UNIQUE
 *    (user_id, metric) key, so repeated/concurrent POSTs converge to exactly
 *    one row (no duplicate-row race, #28).
 *  - #29 idempotency (DELETE): removing an override is idempotent — a delete
 *    for an already-absent override returns 204 No Content, matching the
 *    builder brief ("Removes override; subsequent reads fall back") and REST
 *    semantics for an idempotent verb (R0 Notion test). The no-op is logged
 *    with an `existed:false` flag so it is observable, NOT silent (#36).
 *  - #34 logging: structured event log on write/delete captures BOTH the
 *    `subject_user_id` (the row owner = effectiveUserId) and the
 *    `actor_user_id` (who initiated = callerId). When they differ, that is a
 *    coach-on-behalf write and the log captures it explicitly for an
 *    auditable trail. Only ids + metric + provider are logged — no health
 *    values are ever involved here.
 */
@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent upsert of the (effectiveUserId, metric) → preferred_provider
   * override. Concurrent writes converge to one row via the unique key
   * (#28/#29).
   *
   * @param effectiveUserId whose preference row to write (the caller's own id,
   *   or an assigned client's id for an authorized coach-on-behalf write).
   * @param callerId who initiated the write (audit identity). Equal to
   *   `effectiveUserId` for a self-write; different for a coach-on-behalf
   *   write — the log captures both distinctly (#34).
   * @param dto the validated metric + preferred_provider.
   */
  async upsert(
    effectiveUserId: string,
    callerId: string,
    dto: UpsertPreferenceDto,
  ): Promise<PreferenceResponse> {
    const row = await this.prisma.wearableUserMetricPreference.upsert({
      where: {
        WearablePref_user_metric_key: {
          user_id: effectiveUserId,
          metric: dto.metric,
        },
      },
      create: {
        user_id: effectiveUserId,
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
      subject_user_id: effectiveUserId,
      actor_user_id: callerId,
      on_behalf_of: effectiveUserId !== callerId,
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
   * Remove the (effectiveUserId, metric) override so subsequent reads fall
   * back to recency. IDEMPOTENT (P2 #2): deleting an already-absent override
   * is a successful no-op (the controller returns 204) — DELETE is an
   * idempotent verb and the desired end-state (no override) is reached either
   * way. The no-op is logged with `existed:false` so it is observable, not
   * silent (#36).
   *
   * @param effectiveUserId whose row to delete (caller's own, or an assigned
   *   client's row for an authorized coach-on-behalf delete).
   * @param callerId who initiated the delete (audit identity — logged
   *   distinctly from the subject, #34).
   * @param metric the override metric to remove.
   */
  async remove(
    effectiveUserId: string,
    callerId: string,
    metric: WearableMetricType,
  ): Promise<void> {
    const { count } = await this.prisma.wearableUserMetricPreference.deleteMany({
      where: { user_id: effectiveUserId, metric },
    });
    this.logger.log({
      event: 'wearable_preference_delete',
      subject_user_id: effectiveUserId,
      actor_user_id: callerId,
      on_behalf_of: effectiveUserId !== callerId,
      metric,
      existed: count > 0,
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
