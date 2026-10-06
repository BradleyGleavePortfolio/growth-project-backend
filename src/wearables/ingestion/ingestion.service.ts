import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  WearableMetricType,
  WearableProvider,
  WearableSample,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { NormalizedSample } from '../normalization/normalizer.types';
import { computeDedupKey } from './dedup.util';

/**
 * PR-HK-0 — canonical ingestion lane.
 *
 * One service handles BOTH cloud-webhook/backfill and on-device POST paths;
 * they converge at the {@link NormalizedSample}[] boundary (Agent 2 §3.2).
 *
 * RLS posture (documented per task requirement): ingestion runs under the
 * Supabase `service_role`, which has Postgres `BYPASSRLS`. Webhook/sync jobs
 * are NOT user-authenticated, so the client/coach RLS policies on
 * WearableSample do not (and must not) block writes here. The client/coach
 * policies govern only authenticated READ paths via the app. This is why
 * `ingest()` can write rows for any subject user without an `app.current_*`
 * context — the trust boundary is the connector + the validated payload,
 * not row-level policy.
 *
 * 50-Failures defenses:
 *  - #8  validation — every sample is validated before it touches the DB;
 *    an invalid batch is rejected loud (no partial silent drops).
 *  - #21 no N+1 — inserts are a SINGLE createMany; the connection update is
 *    a SINGLE updateMany; cache invalidation is a SINGLE deleteMany per
 *    affected (user, bucket) — never a per-row loop.
 *  - #28/#29 dedup — createMany(skipDuplicates) keyed on the UNIQUE
 *    dedup_key makes re-ingestion idempotent.
 *  - #36 no silent catch — failures are LOGGED (redacted) then re-thrown;
 *    they never propagate unobserved.
 *  - atomicity — the insert + connection bump + cache invalidation run in a
 *    SINGLE Prisma transaction, so a mid-sequence failure can never leave
 *    partial state (samples inserted but connection/cache not updated).
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batch-ingest normalized samples.
   *
   * Steps (all batched — no per-row queries):
   *  1. Validate the batch (#8). Logs a redacted validation_failure then
   *     throws on the first invalid sample.
   *  2. Compute dedup_key for each sample (shared util).
   *  3-5. Inside a SINGLE Prisma transaction (ReadCommitted, 10s timeout):
   *     2b. SINGLE deleteMany replacing the stored version of each incoming
   *        source record id (#732; see buildSourceRecordReplaceWhere).
   *     3. SINGLE createMany(skipDuplicates) on dedup_key (idempotent,
   *        #21/#28).
   *     4. SINGLE updateMany bumping each touched connection's last_synced_at.
   *     5. SINGLE deleteMany per affected (user, bucket) to invalidate stale
   *        WearableInsightCache rows so the next read regenerates insights.
   *  On success: redacted success log. On failure: redacted error log then
   *  re-throw (fail-loud, #36).
   *
   * @returns counts of newly inserted vs skipped (already-present) rows.
   */
  async ingest(
    samples: NormalizedSample[],
  ): Promise<{ inserted: number; skipped: number }> {
    if (!Array.isArray(samples)) {
      throw new TypeError('ingest: samples must be an array');
    }
    if (samples.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    // (1) Validate the batch (#8). Log a redacted validation_failure (counts
    // + provider + user, NEVER raw payloads) before rethrowing so an invalid
    // batch is observable, not just uncaught.
    try {
      samples.forEach((s, i) => this.validateSample(s, i));
    } catch (err) {
      this.logger.error({
        msg: 'wearables.ingest.validation_failure',
        user_id: samples[0]?.userId,
        provider: samples[0]?.provider,
        submitted_count: samples.length,
        error_message: (err as Error)?.message ?? String(err),
      });
      throw err;
    }

    const rows: Prisma.WearableSampleCreateManyInput[] = samples.map((s) => ({
      user_id: s.userId,
      connection_id: s.connectionId,
      provider: s.provider,
      metric: s.metric,
      bucket: s.bucket,
      value: s.value,
      unit: s.unit,
      start_at: s.startAt,
      end_at: s.endAt,
      source_tz: s.sourceTz ?? null,
      dedup_key: computeDedupKey({
        userId: s.userId,
        provider: s.provider,
        metric: s.metric,
        startAt: s.startAt,
        endAt: s.endAt,
      }),
      source_record_id: s.sourceRecordId ?? null,
      raw_ref: s.rawRef ?? null,
    }));

    const connectionIds = [...new Set(samples.map((s) => s.connectionId))];
    const now = new Date();

    // (3)+(4)+(5) Atomic post-validation side effects. All three batched
    // writes — sample insert, connection bump, and cache invalidation — run
    // inside a SINGLE Prisma transaction so a failure between them can never
    // leave partial state (e.g. inserted samples with a stale connection /
    // un-invalidated cache). Wrapped in try/catch so DB failures are logged
    // (redacted) BEFORE the fail-loud rethrow (#36).
    const replaceWhere = buildSourceRecordReplaceWhere(samples);

    try {
      const { inserted, skipped } = await this.prisma.$transaction(
        async (tx) => {
          // (2b) #732 — a provider can rewrite a record it wrote earlier
          // (same source record id, new interval or value, e.g. a Health
          // Connect sleep session corrected in the morning). The interval
          // hash alone would keep the old row next to the new one and the
          // value would count twice. Replace the stored version first: ONE
          // deleteMany over every incoming record identity, then the
          // createMany below inserts the complete incoming sample set.
          if (replaceWhere) {
            await tx.wearableSample.deleteMany({ where: replaceWhere });
          }

          // (3) Single batch insert; skipDuplicates makes re-ingestion
          // idempotent.
          const { count } = await tx.wearableSample.createMany({
            data: rows,
            skipDuplicates: true,
          });

          // (4) Bump last_synced_at on every connection these samples arrived
          // through — a SINGLE updateMany over the distinct connection ids.
          await tx.wearableConnection.updateMany({
            where: { id: { in: connectionIds } },
            data: {
              last_synced_at: now,
              status: 'connected',
              last_error: null,
            },
          });

          // (5) Invalidate cached insights for each affected (user, bucket).
          // One deleteMany per distinct pair — bounded by the
          // (≤2 buckets × #users) pairs in the batch, not by row count.
          await this.invalidateInsightCache(samples, tx);

          return { inserted: count, skipped: rows.length - count };
        },
        {
          timeout: 10_000, // 10s — generous for batch upserts
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        },
      );

      this.logger.log({
        msg: 'wearables.ingest.success',
        user_id: samples[0]?.userId,
        provider: samples[0]?.provider,
        inserted_count: inserted,
        skipped_count: skipped,
        submitted_count: samples.length,
        connection_count: connectionIds.length,
      });

      return { inserted, skipped };
    } catch (err) {
      this.logger.error({
        msg: 'wearables.ingest.failure',
        user_id: samples[0]?.userId,
        provider: samples[0]?.provider,
        submitted_count: samples.length,
        connection_count: connectionIds.length,
        error_code: (err as { code?: string })?.code ?? 'unknown',
        error_message: (err as Error)?.message ?? String(err),
      });
      throw err;
    }
  }

  /**
   * Resolve the best samples for a (user, metric) window using the read-time
   * precedence policy (UNIFIED_BUILD_PLAN §3.1):
   *  1. If a WearableUserMetricPreference row exists for (user, metric),
   *     return ONLY that preferred provider's samples in the window.
   *  2. Otherwise, fall back to the MOST-RECENTLY-RECORDED provider's samples
   *     for that (user, metric) window.
   *
   * Overlapping windows from the window endpoints are inclusive: a sample is
   * in-window when start_at < endAt AND end_at > startAt (any overlap).
   *
   * No N+1: at most two queries — the preference lookup, then one sample
   * query scoped to the resolved provider.
   */
  async resolveBest(
    userId: string,
    metric: WearableMetricType,
    startAt: Date,
    endAt: Date,
  ): Promise<WearableSample[]> {
    if (!userId) {
      throw new TypeError('resolveBest: userId is required');
    }
    if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
      throw new TypeError('resolveBest: startAt must be a valid Date');
    }
    if (!(endAt instanceof Date) || Number.isNaN(endAt.getTime())) {
      throw new TypeError('resolveBest: endAt must be a valid Date');
    }
    if (startAt.getTime() > endAt.getTime()) {
      throw new RangeError('resolveBest: startAt must be <= endAt');
    }

    const windowFilter = {
      user_id: userId,
      metric,
      start_at: { lt: endAt },
      end_at: { gt: startAt },
    } satisfies Prisma.WearableSampleWhereInput;

    // (1) Preference precedence.
    const preference =
      await this.prisma.wearableUserMetricPreference.findUnique({
        where: { WearablePref_user_metric_key: { user_id: userId, metric } },
      });

    if (preference) {
      return this.prisma.wearableSample.findMany({
        where: { ...windowFilter, provider: preference.preferred_provider },
        orderBy: { start_at: 'asc' },
      });
    }

    // (2) Fallback: most-recently-recorded provider in the window.
    const newest = await this.prisma.wearableSample.findFirst({
      where: windowFilter,
      orderBy: { recorded_at: 'desc' },
      select: { provider: true },
    });

    if (!newest) {
      return [];
    }

    return this.prisma.wearableSample.findMany({
      where: { ...windowFilter, provider: newest.provider },
      orderBy: { start_at: 'asc' },
    });
  }

  /**
   * Delete stale insight-cache rows for each affected (user, bucket). Batched
   * per distinct pair so cost is bounded by pairs, not samples (#21).
   */
  private async invalidateInsightCache(
    samples: NormalizedSample[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const pairs = new Map<string, { userId: string; bucket: NormalizedSample['bucket'] }>();
    for (const s of samples) {
      pairs.set(`${s.userId}::${s.bucket}`, {
        userId: s.userId,
        bucket: s.bucket,
      });
    }

    await Promise.all(
      [...pairs.values()].map(({ userId, bucket }) =>
        tx.wearableInsightCache.deleteMany({
          where: { user_id: userId, bucket },
        }),
      ),
    );
  }

  /**
   * Runtime validation of a single normalized sample (#8). Throws with the
   * batch index so a bad connector is easy to pinpoint.
   */
  private validateSample(s: NormalizedSample, index: number): void {
    const fail = (reason: string): never => {
      throw new Error(`ingest: invalid sample at index ${index}: ${reason}`);
    };

    if (!s || typeof s !== 'object') fail('not an object');
    if (!s.userId) fail('missing userId');
    if (!s.connectionId) fail('missing connectionId');
    if (!s.provider) fail('missing provider');
    if (!s.metric) fail('missing metric');
    if (!s.bucket) fail('missing bucket');
    if (typeof s.value !== 'number' || !Number.isFinite(s.value)) {
      fail(`value must be a finite number (got ${String(s.value)})`);
    }
    if (!s.unit) fail('missing unit');
    if (!(s.startAt instanceof Date) || Number.isNaN(s.startAt.getTime())) {
      fail('startAt must be a valid Date');
    }
    if (!(s.endAt instanceof Date) || Number.isNaN(s.endAt.getTime())) {
      fail('endAt must be a valid Date');
    }
    if (s.startAt.getTime() > s.endAt.getTime()) {
      fail('startAt must be <= endAt');
    }
  }
}

/**
 * #732 — build the single delete filter that removes the stored version of
 * every incoming record identity (user_id, provider, metric,
 * source_record_id) with a non-null source record id. Rows without a source
 * record id are never touched (interval-hash dedup only, as before).
 *
 * Samples are grouped by identity first, so a series record (a Health
 * Connect heart-rate record carries many samples under one id) is replaced
 * as a whole set and then re-inserted in full by the createMany.
 *
 * The delete is bounded to the time span the incoming samples of that
 * identity cover (overlapping or contained rows). The phone splits a sync
 * into requests of at most 250 samples, so one heart-rate record can arrive
 * in two consecutive requests; the second request must not delete the
 * first request's earlier samples. A rewritten interval record (sleep
 * 22:00-06:00 corrected to 22:30-06:00) always overlaps its old row, so it
 * is replaced.
 */
export function buildSourceRecordReplaceWhere(
  samples: NormalizedSample[],
): Prisma.WearableSampleWhereInput | null {
  const spans = new Map<
    string,
    {
      user_id: string;
      provider: WearableProvider;
      metric: WearableMetricType;
      source_record_id: string;
      from: Date;
      to: Date;
    }
  >();
  for (const s of samples) {
    if (!s.sourceRecordId) continue;
    const key = JSON.stringify([s.userId, s.provider, s.metric, s.sourceRecordId]);
    const span = spans.get(key);
    if (!span) {
      spans.set(key, {
        user_id: s.userId,
        provider: s.provider,
        metric: s.metric,
        source_record_id: s.sourceRecordId,
        from: s.startAt,
        to: s.endAt,
      });
      continue;
    }
    if (s.startAt < span.from) span.from = s.startAt;
    if (s.endAt > span.to) span.to = s.endAt;
  }
  if (spans.size === 0) return null;

  return {
    OR: [...spans.values()].map(({ from, to, ...identity }) => ({
      ...identity,
      OR: [
        // Stored interval overlaps the incoming span (strict, so a row that
        // only touches the span edge is kept).
        { start_at: { lt: to }, end_at: { gt: from } },
        // Stored row lies inside the incoming span (instantaneous samples,
        // identical intervals).
        {
          start_at: { gte: from, lte: to },
          end_at: { gte: from, lte: to },
        },
      ],
    })),
  };
}
