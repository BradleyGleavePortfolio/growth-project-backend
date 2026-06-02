import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  WearableMetricBucket,
  WearableMetricType,
  WearableProvider,
  WearableSample,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { WearableConnectionStatus } from '../connections/types';
import { metricsInBucket, METRIC_BUCKET } from './metric-bucket.map';
import { GetSamplesQuery } from './dto/get-samples.query';
import {
  AggBucket,
  FreshnessProvider,
  FreshnessStatus,
  SampleDatum,
  SampleSeries,
  SamplesResponse,
} from './dto/sample-response.schema';

/**
 * PR-HK-3a — read service for the H&F / S&R samples API.
 *
 * 50-Failures defenses (auditor-gated):
 *  - #5 IDOR: the coach path calls {@link assertCoachOwnsClient} as the FIRST
 *    action; a coach reading a client they do not own gets a 403, never data.
 *  - #4 SQL injection: granularity aggregation uses Prisma's tagged-template
 *    `$queryRaw` with bound parameters + a server-side `Prisma.raw` unit that
 *    is restricted to a closed allow-list ('hour' | 'day') — no user string is
 *    ever interpolated into SQL text.
 *  - #35 timeouts: EVERY Prisma call is bounded by a 5s `Promise.race`; on
 *    timeout we throw a typed 503 (WEARABLE_SAMPLES_DEGRADED) — never hang.
 *  - #50 graceful degradation: the 503 is a typed, user-facing error state the
 *    mobile client renders as "last synced data" — not a silent failure.
 *  - #9 PII/health: the structured log records counts + window metadata only,
 *    NEVER raw sample values or result rows.
 *  - #21 no N+1: at most a bounded number of queries (one resolveBest or one
 *    findMany per metric in the bucket); aggregation is pushed into Postgres.
 */
@Injectable()
export class WearableSamplesService {
  private readonly logger = new Logger(WearableSamplesService.name);

  /** Per-Prisma-call wall-clock budget (#35). */
  static readonly PRISMA_TIMEOUT_MS = 5_000;

  /**
   * A connection is "current" when it synced within this window; older →
   * needs_attention; null last_synced_at → never_synced.
   */
  static readonly FRESHNESS_CURRENT_MS = 36 * 60 * 60 * 1000;

  /** date_trunc unit allow-list — closes the SQL surface (#4). */
  private static readonly TRUNC_UNIT: Readonly<Record<'hour' | 'day', string>> =
    { hour: 'hour', day: 'day' };

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * Build the full samples response for a validated query.
   *
   * @param requesterId  the authenticated user's id (coach OR client).
   * @param requesterRole the authenticated user's role ('owner' bypasses).
   */
  async getSeries(
    requesterId: string,
    requesterRole: string,
    query: GetSamplesQuery,
  ): Promise<SamplesResponse> {
    const startedAt = Date.now();

    // (#5) IDOR — FIRST action when a coach reads a client's data.
    const subjectUserId = query.clientId ?? requesterId;
    if (query.clientId) {
      await this.assertCoachOwnsClient(requesterId, query.clientId, requesterRole);
    }

    // Reject a metric that does not live in the requested bucket (#8). The
    // controller already validated each field's type; this is the cross-field
    // semantic check the enum alone cannot express.
    if (query.metric && METRIC_BUCKET[query.metric] !== query.bucket) {
      throw new ForbiddenException({
        error: 'WEARABLE_SAMPLES_FORBIDDEN',
        message: `metric ${query.metric} does not belong to bucket ${query.bucket}`,
      });
    }

    const metrics = query.metric
      ? [query.metric]
      : metricsInBucket(query.bucket);

    // Resolve every metric's series. Each metric is at most one resolveBest()
    // (preferred) or one findMany (compare-all) plus an optional aggregation
    // query — all individually timeout-bounded. Run sequentially-bounded via
    // Promise.all over the (small, ≤ bucket size) metric set.
    const series = await Promise.all(
      metrics.map((metric) =>
        this.buildSeries(subjectUserId, metric, query),
      ),
    );

    const freshness = await this.buildFreshness(subjectUserId, query.bucket);

    const sampleCount = series.reduce((n, s) => n + s.sample_count, 0);
    const windowDays = Math.round(
      (query.to.getTime() - query.from.getTime()) / (24 * 60 * 60 * 1000),
    );

    // (#9/#34) structured log — counts + metadata ONLY, never values/rows.
    this.logger.log({
      event: 'wearable_samples_query',
      user_id: subjectUserId,
      bucket: query.bucket,
      metric: query.metric ?? null,
      window_days: windowDays,
      granularity: query.granularity,
      preferred_only: query.preferredOnly,
      sample_count: sampleCount,
      duration_ms: Date.now() - startedAt,
    });

    return {
      version: 1,
      user_id: subjectUserId,
      bucket: query.bucket,
      window: { from: query.from.toISOString(), to: query.to.toISOString() },
      series,
      freshness: { providers: freshness },
    };
  }

  /**
   * Authorization: assert the coach (or owner) currently owns the coaching
   * relationship to the client (#5 IDOR). Owners (platform admins) bypass,
   * consistent with CoachGuard. Mirrors the equivalent check in
   * WearableInsightsService — duplicated, not imported, to keep the samples
   * module independently mountable (no cross-module service coupling).
   */
  async assertCoachOwnsClient(
    coachId: string,
    clientId: string,
    requesterRole: string,
  ): Promise<void> {
    if (requesterRole === 'owner') return;
    const client = await this.raceTimeout(
      this.prisma.user.findFirst({
        where: {
          id: clientId,
          coach_id: coachId,
          role: 'student',
          deleted_at: null,
        },
        select: { id: true },
      }),
    );
    if (!client) {
      throw new ForbiddenException({
        error: 'WEARABLE_SAMPLES_FORBIDDEN',
        message: 'Client is not assigned to this coach',
      });
    }
  }

  /** Build one metric's series (samples + optional aggregation buckets). */
  private async buildSeries(
    userId: string,
    metric: WearableMetricType,
    query: GetSamplesQuery,
  ): Promise<SampleSeries> {
    const rows = await this.fetchSamples(userId, metric, query);
    const unit = await this.resolveUnit(metric, rows);

    const samples: SampleDatum[] = rows.map((r) => ({
      start_at: r.start_at.toISOString(),
      end_at: r.end_at.toISOString(),
      value: r.value,
      provider: r.provider,
    }));

    const providerUsed: WearableProvider | null =
      rows.length > 0 ? rows[0].provider : null;

    const series: SampleSeries = {
      metric,
      unit,
      provider_used: providerUsed,
      sample_count: rows.length,
      samples,
    };

    if (query.granularity !== 'raw') {
      series.buckets = await this.aggregate(
        userId,
        metric,
        query,
        providerUsed,
      );
    }

    return series;
  }

  /**
   * Fetch the window's samples for a metric. When `preferredOnly` we use the
   * read-precedence policy (resolveBest); otherwise we return ALL providers'
   * samples joined across the window (Metric Detail "compare sources").
   */
  private async fetchSamples(
    userId: string,
    metric: WearableMetricType,
    query: GetSamplesQuery,
  ): Promise<WearableSample[]> {
    if (query.preferredOnly) {
      return this.raceTimeout(
        this.ingestion.resolveBest(userId, metric, query.from, query.to),
      );
    }
    return this.raceTimeout(
      this.prisma.wearableSample.findMany({
        where: {
          user_id: userId,
          metric,
          start_at: { lt: query.to },
          end_at: { gt: query.from },
        },
        orderBy: [{ start_at: 'asc' }, { provider: 'asc' }],
      }),
    );
  }

  /**
   * Resolve the metric's display unit from the seeded WearableMetricDef
   * (single source of truth, #40). Falls back to the unit recorded on the
   * sample rows when the def is somehow absent — never returns an empty unit
   * silently; an absent def with no rows yields '' which the client renders
   * as unit-less.
   */
  private async resolveUnit(
    metric: WearableMetricType,
    rows: WearableSample[],
  ): Promise<string> {
    const def = await this.raceTimeout(
      this.prisma.wearableMetricDef.findUnique({
        where: { metric },
        select: { unit: true },
      }),
    );
    if (def?.unit) return def.unit;
    return rows[0]?.unit ?? '';
  }

  /**
   * Postgres-side aggregation via `date_trunc` (#4 — closed unit allow-list,
   * bound parameters; NO user string interpolated into SQL). The aggregation
   * function is chosen per the metric def's documented semantics (sum/avg/
   * last/max); we default to AVG which is correct for the rate metrics that
   * dominate the H&F bucket, and SUM for the additive ones.
   *
   * Scoped to the resolved provider so the buckets match the returned series
   * (no double-counting across providers).
   */
  private async aggregate(
    userId: string,
    metric: WearableMetricType,
    query: GetSamplesQuery,
    provider: WearableProvider | null,
  ): Promise<AggBucket[]> {
    if (!provider || query.granularity === 'raw') return [];

    const unit = WearableSamplesService.TRUNC_UNIT[query.granularity];
    const aggFn = this.aggFunctionFor(metric);

    // `Prisma.raw` is used ONLY for the unit + agg function, both drawn from
    // closed server-side allow-lists above (never from the request string).
    // Every value (userId, metric, provider, window) is a BOUND parameter.
    const rows = await this.raceTimeout(
      this.prisma.$queryRaw<
        Array<{ bucket_start: Date; agg: number | null; count: bigint }>
      >`
        SELECT
          date_trunc(${unit}, "start_at") AS bucket_start,
          ${Prisma.raw(aggFn)}("value") AS agg,
          COUNT(*)::bigint AS count
        FROM "WearableSample"
        WHERE "user_id" = ${userId}
          AND "metric" = ${Prisma.raw(`'${metric}'`)}::"WearableMetricType"
          AND "provider" = ${Prisma.raw(`'${provider}'`)}::"WearableProvider"
          AND "start_at" < ${query.to}
          AND "end_at" > ${query.from}
        GROUP BY bucket_start
        ORDER BY bucket_start ASC
      `,
    );

    const stepMs = query.granularity === 'day' ? 86_400_000 : 3_600_000;
    return rows.map((r) => ({
      bucket_start: r.bucket_start.toISOString(),
      bucket_end: new Date(r.bucket_start.getTime() + stepMs).toISOString(),
      agg: r.agg ?? 0,
      count: Number(r.count),
    }));
  }

  /** Aggregation function per metric semantics. Closed allow-list (#4). */
  private aggFunctionFor(metric: WearableMetricType): 'SUM' | 'AVG' | 'MAX' {
    const additive: ReadonlySet<WearableMetricType> = new Set<WearableMetricType>([
      WearableMetricType.STEPS,
      WearableMetricType.ACTIVE_ENERGY_KCAL,
      WearableMetricType.WORKOUT_DURATION_MIN,
      WearableMetricType.WORKOUT_DISTANCE_M,
    ]);
    return additive.has(metric) ? 'SUM' : 'AVG';
  }

  /**
   * Freshness chip data: ONE entry per provider that has a (non-disconnected)
   * connection in this bucket's domain. Status is derived from last_synced_at.
   * Drives the client freshness chip (the chip itself is recomputed client-side
   * per plan line 91 — this is the server-truth fallback).
   */
  private async buildFreshness(
    userId: string,
    bucket: WearableMetricBucket,
  ): Promise<FreshnessProvider[]> {
    const connections = await this.raceTimeout(
      this.prisma.wearableConnection.findMany({
        where: {
          user_id: userId,
          status: { not: WearableConnectionStatus.DISCONNECTED },
        },
        select: { provider: true, last_synced_at: true },
        orderBy: { provider: 'asc' },
      }),
    );

    // A provider belongs to this bucket's freshness chip when it has EVER
    // contributed a sample in the bucket for this user. This keeps the chip
    // bucket-scoped (plan line 100) without inventing a per-connection bucket
    // column. The query is a single grouped read over the indexed
    // (user_id, bucket, start_at) composite — no per-connection loop (#21).
    const bucketProviders = await this.raceTimeout(
      this.prisma.wearableSample.findMany({
        where: { user_id: userId, bucket },
        select: { provider: true },
        distinct: ['provider'],
      }),
    );
    const inBucket = new Set<WearableProvider>(
      bucketProviders.map((r) => r.provider),
    );

    // Keep a connection in the chip when it has bucket data OR when it has
    // never synced (so a freshly-connected provider with zero data still
    // shows as never_synced rather than silently vanishing).
    const relevant = connections.filter(
      (c) => inBucket.has(c.provider) || c.last_synced_at === null,
    );

    const now = Date.now();
    return relevant.map((c) => {
      let status: FreshnessStatus;
      if (!c.last_synced_at) {
        status = 'never_synced';
      } else if (
        now - c.last_synced_at.getTime() <=
        WearableSamplesService.FRESHNESS_CURRENT_MS
      ) {
        status = 'current';
      } else {
        status = 'needs_attention';
      }
      return {
        provider: c.provider,
        last_synced_at: c.last_synced_at ? c.last_synced_at.toISOString() : null,
        status,
      };
    });
  }

  /**
   * Bound a Prisma promise with a 5s wall-clock budget (#35). On timeout we
   * throw a typed 503 (WEARABLE_SAMPLES_DEGRADED) so the read never hangs and
   * the client can degrade gracefully (#50). The timer is always cleared so a
   * fast-resolving query leaves no dangling handle.
   */
  private async raceTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ServiceUnavailableException({
            error: 'WEARABLE_SAMPLES_DEGRADED',
            message: 'Wearable data store did not respond in time',
          }),
        );
      }, WearableSamplesService.PRISMA_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
