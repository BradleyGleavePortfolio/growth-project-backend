import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
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
import {
  metricsInBucket,
  METRIC_BUCKET,
  METRIC_AGGREGATION,
  MetricAggregation,
  isMetricAggregation,
} from './metric-bucket.map';
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

/**
 * Prisma error codes that signify the database was UNREACHABLE (connectivity),
 * as opposed to a query/schema/permission fault. These are the only conditions
 * under which the boot-time `WearableMetricDef` cross-check is allowed to be
 * skipped (fail-open onto the compile-time mirrors). Sourced from Prisma's
 * common-error reference:
 *   P1001 can't reach DB server, P1002 server timed out (TLS handshake),
 *   P1008 operation timed out, P1011 TLS connection error,
 *   P1017 server has closed the connection.
 */
const PRISMA_CONNECTIVITY_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1011',
  'P1017',
]);

/**
 * True ONLY for errors that mean the database could not be reached at boot:
 * a `PrismaClientInitializationError` (engine could not connect), or a
 * `PrismaClientKnownRequestError` carrying one of {@link PRISMA_CONNECTIVITY_CODES}.
 * Everything else (empty table, schema/permission faults, malformed enum, seed
 * drift, timeouts) returns false so the caller fails LOUD rather than silently
 * masking a real configuration bug.
 */
export function isConnectivityError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return PRISMA_CONNECTIVITY_CODES.has(err.code);
  }
  return false;
}

@Injectable()
export class WearableSamplesService implements OnModuleInit {
  private readonly logger = new Logger(WearableSamplesService.name);

  /** Per-Prisma-call wall-clock budget (#35). */
  static readonly PRISMA_TIMEOUT_MS = 5_000;

  /**
   * Working metric → aggregation map. Seeded at module init from the live
   * `WearableMetricDef` table (the #40 single source of truth) so the read path
   * never hits the DB to learn a metric's aggregation. Initialised to the
   * compile-time mirror {@link METRIC_AGGREGATION} so the read path is correct
   * even before {@link onModuleInit} runs (cold start / unit tests that never
   * boot the Nest lifecycle).
   */
  private aggregationByMetric: Readonly<Record<WearableMetricType, MetricAggregation>> =
    METRIC_AGGREGATION;

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
   * Bootstrap the in-memory metric metadata from the seeded `WearableMetricDef`
   * (the #40 single source of truth) and assert the compile-time mirrors match
   * it. Two drift classes are guarded:
   *
   *  1. bucket drift — the compile-time {@link METRIC_BUCKET} (which the Zod
   *     query validator and `metricsInBucket` both read) must agree with the
   *     seed's `bucket` column. A mismatch (e.g. RESTING_HEART_RATE_BPM landing
   *     in the wrong bucket) would silently route a metric to the wrong UX tab.
   *  2. aggregation drift — the seed's `aggregation` value for each metric is
   *     loaded into {@link aggregationByMetric}; if a row carries a value that
   *     is not one of the four canonical aggregations it is a seed/data bug we
   *     surface LOUD rather than silently defaulting.
   *
   * On ANY drift we log an error and THROW so the mismatch fails the boot
   * (never a silent wrong-bucket / wrong-aggregation read). The boot catch is
   * narrowed to connectivity-class Prisma errors (see {@link isConnectivityError}):
   * only when the database is unreachable at boot (e.g. a unit context with no
   * DB) do we keep the compile-time mirrors — they are the authoritative
   * fallback, not a guess. An empty defs table, a schema/permission fault, a
   * malformed enum, or seed/map drift all rethrow and fail the boot LOUD.
   */
  async onModuleInit(): Promise<void> {
    try {
      const defs = await this.raceTimeout(
        this.prisma.wearableMetricDef.findMany({
          select: { metric: true, bucket: true, aggregation: true },
        }),
      );

      // Empty table is a real config bug (seed never applied), NOT a
      // connectivity condition — it must fail the boot LOUD rather than
      // silently running on the compile-time mirrors.
      if (defs.length === 0) {
        this.logger.error({ event: 'wearable_metric_def_bootstrap_empty' });
        throw new Error('WearableMetricDef seed missing');
      }

      this.assertMetricMapMatchesSeed(defs);
    } catch (err) {
      // Fail-open is permitted ONLY when the database was unreachable at boot
      // (e.g. a unit context with no DB): keep the compile-time mirrors, which
      // are the authoritative fallback. We log so the absence of a live
      // cross-check is visible — this is NOT a silent swallow.
      if (isConnectivityError(err)) {
        this.logger.warn({
          event: 'wearable_metric_def_bootstrap_skipped',
          reason: err instanceof Error ? err.message : 'unknown',
        });
        return;
      }
      // Anything else — empty table, schema/permission fault, malformed enum,
      // or seed/map drift — is a config bug we surface LOUD by rethrowing.
      this.logger.error({
        event: 'wearable_metric_def_bootstrap_failed',
        reason: err instanceof Error ? err.message : 'unknown',
      });
      throw err;
    }
  }

  /**
   * Cross-check the live `WearableMetricDef` rows against the compile-time
   * mirrors and adopt the seeded aggregations. On ANY drift (wrong bucket,
   * non-canonical aggregation, or an aggregation that disagrees with the
   * mirror) we log an error and THROW so the mismatch fails the boot — never a
   * silent wrong-bucket / wrong-aggregation read.
   */
  private assertMetricMapMatchesSeed(
    defs: Array<{
      metric: WearableMetricType;
      bucket: WearableMetricBucket;
      aggregation: string;
    }>,
  ): void {
    const drift: string[] = [];
    const aggregation: Record<WearableMetricType, MetricAggregation> = {
      ...METRIC_AGGREGATION,
    };

    for (const def of defs) {
      if (METRIC_BUCKET[def.metric] !== def.bucket) {
        drift.push(
          `bucket: ${def.metric} seeded ${def.bucket} but map has ${METRIC_BUCKET[def.metric]}`,
        );
      }
      if (!isMetricAggregation(def.aggregation)) {
        drift.push(
          `aggregation: ${def.metric} seeded non-canonical '${def.aggregation}'`,
        );
        continue;
      }
      aggregation[def.metric] = def.aggregation;
      if (METRIC_AGGREGATION[def.metric] !== def.aggregation) {
        drift.push(
          `aggregation: ${def.metric} seeded '${def.aggregation}' but map has '${METRIC_AGGREGATION[def.metric]}'`,
        );
      }
    }

    if (drift.length > 0) {
      this.logger.error({
        event: 'wearable_metric_def_map_drift',
        mismatches: drift,
      });
      throw new Error(
        `WearableMetricDef map drift detected (seed is source of truth): ${drift.join('; ')}`,
      );
    }

    // Seed and mirror agree: adopt the live values (identical here, but this
    // makes the DB the runtime source once it is reachable).
    this.aggregationByMetric = aggregation;
    this.logger.log({
      event: 'wearable_metric_def_bootstrap_ok',
      metric_count: defs.length,
    });
  }

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
    // controller's Zod superRefine is the primary gate (returns 400
    // WEARABLE_SAMPLES_QUERY_INVALID); this is defense-in-depth for any direct
    // service caller. It is a query-VALIDATION failure (400) — NOT a 403:
    // confusing the two ruins client error UX (P1 #5 / R0 Notion test).
    if (query.metric && METRIC_BUCKET[query.metric] !== query.bucket) {
      throw new BadRequestException({
        error: 'WEARABLE_SAMPLES_QUERY_INVALID',
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

    // Distinct providers actually present in the returned rows. In
    // preferredOnly mode resolveBest yields a single provider; in compare-all
    // mode (preferredOnly=false) this can be several. The aggregation MUST be
    // scoped to EXACTLY this set so the buckets and the `samples` array agree
    // (P1 #1 — previously buckets used only rows[0].provider while `samples`
    // spanned every provider, producing an inconsistent envelope).
    const providersInRows = Array.from(
      new Set(rows.map((r) => r.provider)),
    ).sort();

    // `provider_used` is the single resolved provider in preferred mode (or a
    // single-provider compare-all result); when the response spans MULTIPLE
    // providers it is null — no one provider "was used". The envelope shape is
    // identical across both preferredOnly modes (P1 #1).
    const providerUsed: WearableProvider | null =
      providersInRows.length === 1 ? providersInRows[0] : null;

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
        providersInRows,
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
   * bound parameters; NO user string interpolated into SQL).
   *
   * The aggregation FUNCTION is driven by the seeded `WearableMetricDef`
   * (P1 NEW #2 — no more hardcoded SUM/AVG): a `sum`/`avg`/`max` metric maps to
   * the matching SQL aggregate over the bucket window, while a `last` metric
   * (point-in-time readings such as weight, VO2max, recovery score) takes the
   * latest reading within the bucket via `(array_agg(value ORDER BY start_at
   * DESC))[1]` — averaging or summing those would be physically meaningless.
   * The expression comes from {@link aggSqlExprFor}, a closed server-controlled
   * mapping keyed off the canonical aggregation union (never a request value).
   *
   * Scoped to EXACTLY the providers present in the returned `samples` (one in
   * preferred mode, possibly several in compare-all mode) so the buckets and
   * the `samples` array always agree (P1 #1 — no provider-scope drift between
   * the two envelope fields).
   */
  private async aggregate(
    userId: string,
    metric: WearableMetricType,
    query: GetSamplesQuery,
    providers: WearableProvider[],
  ): Promise<AggBucket[]> {
    if (providers.length === 0 || query.granularity === 'raw') return [];

    const unit = WearableSamplesService.TRUNC_UNIT[query.granularity];
    const aggExpr = this.aggSqlExprFor(metric);

    // The provider IN-list is built from bound parameters, each with an
    // explicit ::"WearableProvider" cast. Prisma.join interpolates ONLY the
    // placeholder positions ("$n"), never the values themselves, so this stays
    // fully parameterized for an arbitrary provider count (P1 #1 + P1 #4).
    const providerList = Prisma.join(
      providers.map((p) => Prisma.sql`${p}::"WearableProvider"`),
    );

    // `Prisma.raw` is used ONLY for the date_trunc unit + the agg expression,
    // both drawn from closed server-side allow-lists (SQL IDENTIFIERS / a fixed
    // expression per canonical aggregation, never request VALUES). Every value
    // (userId, metric, provider, window) is a BOUND parameter — enum values use
    // a bound param with an explicit ::"<enum>" cast (P1 #4 / R65 #3 / OWASP-1).
    // No request string is ever interpolated into SQL text.
    const rows = await this.raceTimeout(
      this.prisma.$queryRaw<
        Array<{ bucket_start: Date; agg: number | null; count: bigint }>
      >`
        SELECT
          date_trunc(${unit}, "start_at") AS bucket_start,
          ${aggExpr} AS agg,
          COUNT(*)::bigint AS count
        FROM "WearableSample"
        WHERE "user_id" = ${userId}
          AND "metric" = ${metric}::"WearableMetricType"
          AND "provider" IN (${providerList})
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

  /**
   * The per-bucket SQL aggregation expression for a metric, derived from the
   * seeded {@link aggregationByMetric} (P1 NEW #2). The `switch` is EXHAUSTIVE
   * over the canonical {@link MetricAggregation} union — adding a fifth
   * aggregation to the seed without handling it here is a COMPILE ERROR (the
   * `default` arm narrows to `never` and is assigned to a `never`-typed const).
   * The returned `Prisma.Sql` is server-controlled (no request value), so the
   * #4 SQL-injection posture is unchanged.
   */
  private aggSqlExprFor(metric: WearableMetricType): Prisma.Sql {
    const aggregation = this.aggregationByMetric[metric];
    switch (aggregation) {
      case 'sum':
        return Prisma.sql`SUM("value")`;
      case 'avg':
        return Prisma.sql`AVG("value")`;
      case 'max':
        return Prisma.sql`MAX("value")`;
      case 'last':
        // Latest reading within the bucket (point-in-time metrics). Ordered by
        // sample time DESC, tie-broken on end_at then id for determinism.
        return Prisma.sql`(array_agg("value" ORDER BY "start_at" DESC, "end_at" DESC, "id" DESC))[1]`;
      default: {
        // Exhaustiveness guard: if MetricAggregation ever grows a member that
        // is not handled above, this assignment fails to compile.
        const exhaustive: never = aggregation;
        throw new Error(
          `Unhandled metric aggregation '${String(exhaustive)}' for metric ${metric}`,
        );
      }
    }
  }

  /**
   * Freshness chip data: ONE entry per provider with a non-disconnected
   * connection for this user that is RELEVANT to the requested bucket. Drives
   * the client freshness chip (recomputed client-side per plan line 91 — this
   * is the server-truth fallback).
   *
   * Bucket relevance (P2 NEW #1): the chip on the H&F tab must not advertise a
   * sleep-only source (and vice-versa). A connection is therefore filtered OUT
   * of a bucket's freshness ONLY when the provider DEMONSTRABLY serves a
   * different bucket exclusively — i.e. it has produced sample data for this
   * user but NONE of it lands in `METRIC_BUCKET[bucket]`. We decide relevance
   * from the user's own sample history (two distinct-provider probes) rather
   * than a static capability matrix, because the per-connector capability set
   * is not uniformly declared in code and would mis-filter not-yet-normalized
   * providers.
   *
   * Coverage / zero-data (P1 #2 — preserved): a connected, recently-synced
   * provider that has produced NO samples at all (so we cannot yet tell which
   * bucket it serves) is STILL reported — it is never excluded on a hunch, so
   * the user is never silently told a freshly-connected source is missing.
   *
   * Status precedence (P1 #3):
   *  1. A connection in any non-healthy lifecycle state (expired / error /
   *     revoked / anything that is not `connected`) is ALWAYS `needs_attention`
   *     regardless of how recent `last_synced_at` is — a recent sync before a
   *     token expiry must NOT be reported as `current` (that would lie to the
   *     user about a source that can no longer pull data).
   *  2. Otherwise a null `last_synced_at` is `never_synced`.
   *  3. Otherwise recency vs the current-window threshold decides
   *     `current` vs `needs_attention`.
   */
  private async buildFreshness(
    userId: string,
    bucket: WearableMetricBucket,
  ): Promise<FreshnessProvider[]> {
    const [connections, bucketSampleProviders, anySampleProviders] =
      await Promise.all([
        this.raceTimeout(
          this.prisma.wearableConnection.findMany({
            where: {
              user_id: userId,
              status: { not: WearableConnectionStatus.DISCONNECTED },
            },
            select: { provider: true, last_synced_at: true, status: true },
            orderBy: { provider: 'asc' },
          }),
        ),
        this.distinctSampleProviders(userId, metricsInBucket(bucket)),
        this.distinctSampleProviders(userId, null),
      ]);

    const now = Date.now();
    return connections
      .filter((c) =>
        this.isProviderRelevantToBucket(
          c.provider,
          bucketSampleProviders,
          anySampleProviders,
        ),
      )
      .map((c) => ({
        provider: c.provider,
        last_synced_at: c.last_synced_at ? c.last_synced_at.toISOString() : null,
        status: this.freshnessStatusFor(c.status, c.last_synced_at, now),
      }));
  }

  /**
   * Distinct providers that have at least one `WearableSample` for the user,
   * optionally restricted to a set of metrics (the bucket's metrics). Returns a
   * Set for O(1) membership in the freshness relevance check.
   */
  private async distinctSampleProviders(
    userId: string,
    metrics: WearableMetricType[] | null,
  ): Promise<ReadonlySet<WearableProvider>> {
    const rows = await this.raceTimeout(
      this.prisma.wearableSample.findMany({
        where: {
          user_id: userId,
          ...(metrics ? { metric: { in: metrics } } : {}),
        },
        select: { provider: true },
        distinct: ['provider'],
      }),
    );
    return new Set(rows.map((r) => r.provider));
  }

  /**
   * A connection is relevant to the requested bucket UNLESS it provably serves
   * a different bucket exclusively: it has produced sample data for the user
   * (`anySampleProviders`) but none of it in this bucket
   * (`bucketSampleProviders`). A provider with bucket samples is relevant; a
   * provider with NO samples anywhere is kept (zero-data coverage, P1 #2).
   */
  private isProviderRelevantToBucket(
    provider: WearableProvider,
    bucketSampleProviders: ReadonlySet<WearableProvider>,
    anySampleProviders: ReadonlySet<WearableProvider>,
  ): boolean {
    if (bucketSampleProviders.has(provider)) return true;
    // No samples in this bucket. Exclude only if it has samples in some OTHER
    // bucket (so it demonstrably belongs elsewhere); otherwise keep it.
    return !anySampleProviders.has(provider);
  }

  /**
   * Derive the freshness tier for a single connection (P1 #3). A connection in
   * any state other than `connected` is forced to `needs_attention` — recency
   * cannot override a broken/expired link.
   */
  private freshnessStatusFor(
    status: string,
    lastSyncedAt: Date | null,
    now: number,
  ): FreshnessStatus {
    if (status !== WearableConnectionStatus.CONNECTED) {
      return 'needs_attention';
    }
    if (!lastSyncedAt) {
      return 'never_synced';
    }
    return now - lastSyncedAt.getTime() <=
      WearableSamplesService.FRESHNESS_CURRENT_MS
      ? 'current'
      : 'needs_attention';
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
