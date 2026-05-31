import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WearableMetricBucket } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import {
  AnyInsight,
  CoachInsight,
  ClientInsight,
  InsightAudience,
} from './insight-output.schema';

// PR-HK-4 — read/write façade over the WearableInsightCache table.
//
// Schema note (PR-HK-0): the persisted table keys on
// (user_id, side, bucket, window_days) and tracks freshness via
// `generated_at` + `expires_at` (generated_at + 6h, unless a new sync
// arrives — in which case PR-HK-0's IngestionService DELETES the row via
// invalidateInsightCache). There is no soft `invalidated_at` column: a
// sync-driven invalidation is a row delete, so "invalidated" and "missing"
// collapse to the same observable state — `get` returns null. We model the
// task's "treat as stale if invalidated" requirement by honouring
// `expires_at` (TTL) AND treating an absent row as a miss; the
// IngestionService's delete-on-sync is what makes a sync invalidate the
// cache without this service editing IngestionService.

// All insight windows use a fixed 14-day trend window (the service fetches
// last-14d samples). Stored on the row so a future multi-window design can
// coexist without a key collision.
export const INSIGHT_WINDOW_DAYS = 14;

// 6-hour TTL per the locked decision.
export const INSIGHT_TTL_MS = 6 * 60 * 60 * 1000;

// Map the public audience label to the persisted `side` discriminator.
function audienceToSide(audience: InsightAudience): string {
  return audience; // 'coach' | 'client' map 1:1 to the side column
}

@Injectable()
export class InsightCacheService {
  private readonly logger = new Logger(InsightCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Cache-key helper, exposed for the service + tests. The logical key is
  // `${audience}:${userId}:${bucket}` per the spec; the physical key adds
  // the window. Returned as the Prisma compound-unique selector shape.
  buildWhere(
    audience: InsightAudience,
    userId: string,
    bucket: WearableMetricBucket,
  ): Prisma.WearableInsightCacheWhereUniqueInput {
    return {
      WearableInsight_subject_side_bucket_window_key: {
        user_id: userId,
        side: audienceToSide(audience),
        bucket,
        window_days: INSIGHT_WINDOW_DAYS,
      },
    };
  }

  // Return the cached insight ONLY if a row exists AND it has not expired.
  // A missing row (cache miss, or a sync-driven delete = invalidation) and
  // an expired row both return null so the service regenerates.
  async get(
    audience: InsightAudience,
    userId: string,
    bucket: WearableMetricBucket,
  ): Promise<AnyInsight | null> {
    const row = await this.prisma.wearableInsightCache.findUnique({
      where: this.buildWhere(audience, userId, bucket),
    });
    if (!row) return null;
    if (row.expires_at.getTime() <= Date.now()) {
      // Expired — treat as a miss. We do not delete here (cheap to leave;
      // the next set() upserts over it, and the sync path prunes).
      return null;
    }
    return row.payload as unknown as AnyInsight;
  }

  // Return the most recent cached payload REGARDLESS of expiry. Used by the
  // timeout fallback path: "on timeout → return last cached version (even
  // if stale)". Returns null only when no row exists at all.
  async getEvenIfStale(
    audience: InsightAudience,
    userId: string,
    bucket: WearableMetricBucket,
  ): Promise<AnyInsight | null> {
    const row = await this.prisma.wearableInsightCache.findUnique({
      where: this.buildWhere(audience, userId, bucket),
    });
    if (!row) return null;
    return row.payload as unknown as AnyInsight;
  }

  // Upsert the payload, stamping a fresh 6h expiry. model_used +
  // prompt_version are recorded for audit/replay.
  async set(
    audience: InsightAudience,
    userId: string,
    bucket: WearableMetricBucket,
    payload: CoachInsight | ClientInsight,
    meta: { modelUsed: string; promptVersion: string },
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INSIGHT_TTL_MS);
    const side = audienceToSide(audience);
    await this.prisma.wearableInsightCache.upsert({
      where: this.buildWhere(audience, userId, bucket),
      create: {
        user_id: userId,
        side,
        bucket,
        window_days: INSIGHT_WINDOW_DAYS,
        payload: payload as unknown as Prisma.InputJsonValue,
        model_used: meta.modelUsed,
        prompt_version: meta.promptVersion,
        generated_at: now,
        expires_at: expiresAt,
      },
      update: {
        payload: payload as unknown as Prisma.InputJsonValue,
        model_used: meta.modelUsed,
        prompt_version: meta.promptVersion,
        generated_at: now,
        expires_at: expiresAt,
      },
    });
  }

  // Invalidate ALL cache rows for a user (both sides, all buckets). In the
  // PR-HK-0 schema this is a hard delete (there is no invalidated_at
  // column), which makes a subsequent get() return null — exactly the
  // "stale → regenerate" behaviour the spec asks for. IngestionService
  // already performs the per-(user,bucket) delete on new sync from PR-HK-0;
  // this method is the explicit user-wide variant the service exposes.
  async invalidate(userId: string): Promise<void> {
    const res = await this.prisma.wearableInsightCache.deleteMany({
      where: { user_id: userId },
    });
    this.logger.debug(
      `Invalidated ${res.count} wearable insight cache row(s) for user ${userId}`,
    );
  }
}
