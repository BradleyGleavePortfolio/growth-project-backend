import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  PTM_WINDOWS,
  type PtmFactor,
  type PtmScoreResult,
  type PtmSignalTypeT,
} from './ptm.types';
import {
  cohortFor,
  type PtmSignalSnapshot,
  type PtmTrainedWeight,
  type PtmTrainingResult,
} from './ptm-weighted.types';

/**
 * PtmWeightedService — Phase 1D weighted v2 engine.
 *
 * Activation contract:
 *   - isActive() returns true iff there are >= PTM_WEIGHTED_ACTIVATION_OUTCOMES
 *     labelled ClientOutcome rows AND both the SUCCESS and FAILURE
 *     cohorts have at least one row each. Below the threshold (or with
 *     an empty cohort) the recompute orchestrator falls back to
 *     PtmHeuristicService (heuristic_v1).
 *   - score() is callable regardless of isActive() so admin diagnostics
 *     can request a weighted score on demand. The orchestrator chooses
 *     when to call it; if the engine has no training data, score()
 *     returns a zero-contribution result rather than throwing.
 *
 * Algorithm (per the brief — frequency analysis, NOT full ML, NO external
 * library):
 *   1. Pull all ClientOutcome rows. Bin into SUCCESS / FAILURE cohorts
 *      (see ptm-weighted.types.ts for the membership map).
 *   2. For each (cohort, signal_type) pair, compute the average
 *      per-30-day-window count from each row's signal_snapshot JSON
 *      (Phase 1C captures the snapshot at label time — that frozen
 *      window is the canonical training set, and it survives GDPR
 *      scrubs of older raw signals).
 *   3. weight = (avg_in_FAILURE - avg_in_SUCCESS) /
 *               max(avg_in_FAILURE + avg_in_SUCCESS, 0.1)
 *      Range roughly [-1, +1]. Positive = failure-correlated (risk),
 *      negative = success-correlated (protective).
 *   4. Score: pull the user's last-30-day signal counts, normalise each
 *      by training_max, multiply by the trained weight, sum to get
 *      rawRisk in [-1, +1]. riskScore = clamp((rawRisk + 1) / 2, 0, 1).
 *      successScore = 1 - riskScore. (Note: the v1 heuristic engine
 *      keeps risk and success as INDEPENDENT axes; the weighted v2
 *      engine LINKS them because the weight already encodes both
 *      signs simultaneously.)
 *   5. factors[]: top-5 contributing signals by absolute contribution.
 *
 * Caching:
 *   - Trained weights are cached in-memory for one hour. The trainer
 *     re-runs on cache miss or staleness, or when refresh() is called.
 *     The recompute orchestrator should call refresh() after a new
 *     outcome is labelled (1C label flow → recomputeOne path), but the
 *     1-hour TTL guarantees correctness even if the orchestrator does
 *     not.
 *
 * Environment:
 *   - PTM_WEIGHTED_ACTIVATION_OUTCOMES — minimum total outcome rows
 *     before the engine activates. Default 20.
 */
@Injectable()
export class PtmWeightedService {
  private readonly logger = new Logger(PtmWeightedService.name);

  // One-hour cache TTL. Long enough that a daily nightly recompute pass
  // trains exactly once; short enough that a freshly-labelled outcome
  // shows up in the next morning's score even without an explicit
  // refresh() call from the orchestrator.
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000;

  private cached: PtmTrainingResult | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * True iff the weighted engine has enough labelled outcomes to score
   * meaningfully. The orchestrator uses this flag to choose between
   * weighted_v2 and heuristic_v1.
   *
   * Empty-cohort guard: even with >= threshold total rows, the engine
   * stays inactive if either SUCCESS or FAILURE has zero members. With
   * one cohort empty the weight formula collapses (every weight pegs
   * to ±1) and the resulting scores are not informative.
   */
  async isActive(): Promise<boolean> {
    const threshold = activationThreshold();
    const total = await this.prisma.clientOutcome.count();
    if (total < threshold) return false;
    const training = await this.train();
    if (training.success_count === 0 || training.failure_count === 0) {
      return false;
    }
    return training.weights.size > 0;
  }

  /**
   * Score a user against the trained weights. basis is always
   * 'weighted_v2'. Callable regardless of isActive() so admin
   * diagnostics can request a weighted view; the orchestrator chooses
   * when to actually call this.
   *
   * If the engine has no trained weights (e.g. activation threshold not
   * yet met), the return carries riskScore=0.5, successScore=0.5,
   * factors=[]. Operators reading the response see the zero-factor
   * shape and know the engine had nothing to say.
   */
  async score(userId: string): Promise<PtmScoreResult> {
    const training = await this.train();
    const observed = await this.observedCounts(userId);

    if (training.weights.size === 0) {
      return {
        riskScore: 0.5,
        successScore: 0.5,
        basis: 'weighted_v2',
        factors: [],
      };
    }

    let rawRisk = 0;
    const contributions: Array<{
      signal: PtmSignalTypeT;
      weight: number;
      observedCount: number;
      contribution: number;
    }> = [];

    for (const [signal, w] of training.weights) {
      const obs = observed.get(signal) ?? 0;
      const denom = w.training_max > 0 ? w.training_max : 1;
      const normalised = clamp(obs / denom, 0, 1);
      const contribution = w.weight * normalised;
      rawRisk += contribution;
      contributions.push({
        signal,
        weight: w.weight,
        observedCount: obs,
        contribution,
      });
    }

    // Cap rawRisk into [-1, +1] before mapping. With many signals the
    // unconstrained sum can mathematically exceed the per-signal range,
    // so we clamp to keep the riskScore inside [0, 1].
    rawRisk = clamp(rawRisk, -1, 1);
    const riskScore = clamp((rawRisk + 1) / 2, 0, 1);
    const successScore = clamp(1 - riskScore, 0, 1);

    const top = contributions
      .filter((c) => c.contribution !== 0 || c.observedCount > 0)
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 5);

    const factors: PtmFactor[] = top.map((c) => ({
      key: `weighted_${c.signal}`,
      label: `Weighted: ${c.signal} observed ${c.observedCount} (cohort weight ${c.weight.toFixed(2)})`,
      contribution: round3(c.contribution),
      observed: c.observedCount,
    }));

    return {
      riskScore: round3(riskScore),
      successScore: round3(successScore),
      basis: 'weighted_v2',
      factors,
    };
  }

  /**
   * Public hook used by the recompute orchestrator after a new outcome
   * is labelled (1C label endpoint → recomputeOne path). Drops the
   * cached training result so the next score() call retrains. Safe to
   * call when no cache is present.
   */
  refresh(): void {
    this.cached = null;
  }

  /**
   * Surface the current trained weights for the admin
   * /admin/reports/ptm-signal-weights endpoint. Callers handle the
   * "below threshold" case by checking the returned training_count
   * (zero rows) — this method never throws.
   */
  async getCurrentWeights(): Promise<{
    generated_at: string;
    training_count: number;
    skipped_no_snapshot: number;
    skipped_unclassified: number;
    success_count: number;
    failure_count: number;
    weights: PtmTrainedWeight[];
  }> {
    const t = await this.train();
    return {
      generated_at: t.trained_at.toISOString(),
      training_count: t.total_outcomes,
      skipped_no_snapshot: t.skipped_no_snapshot,
      skipped_unclassified: t.skipped_unclassified,
      success_count: t.success_count,
      failure_count: t.failure_count,
      weights: Array.from(t.weights.values()).sort((a, b) =>
        a.signal_type < b.signal_type
          ? -1
          : a.signal_type > b.signal_type
            ? 1
            : 0,
      ),
    };
  }

  // -- internals ----------------------------------------------------------

  /**
   * Run a training pass (or return the cached one). Centralised here so
   * isActive(), score(), and getCurrentWeights() share a single training
   * call per cache window. The split between train() (cache layer) and
   * trainPass() (real work) lets a test spy on trainPass to assert the
   * cache short-circuits repeat calls.
   */
  protected async train(): Promise<PtmTrainingResult> {
    const fresh =
      this.cached &&
      Date.now() - this.cached.trained_at.getTime() <
        PtmWeightedService.CACHE_TTL_MS;
    if (this.cached && fresh) return this.cached;
    const result = await this.trainPass();
    this.cached = result;
    return result;
  }

  /**
   * The actual training pass. Separate method so a test can spy on the
   * call count to assert the cache short-circuits repeat score() calls.
   */
  protected async trainPass(): Promise<PtmTrainingResult> {
    const rows = await this.prisma.clientOutcome.findMany({
      select: { outcome_type: true, signal_snapshot: true },
    });

    const sums = new Map<PtmSignalTypeT, { success: number; failure: number }>();
    const counts = new Map<
      PtmSignalTypeT,
      { success: number; failure: number }
    >();
    const maxObserved = new Map<PtmSignalTypeT, number>();

    let successCount = 0;
    let failureCount = 0;
    let skippedNoSnapshot = 0;
    let skippedUnclassified = 0;

    for (const row of rows) {
      const cohort = cohortFor(row.outcome_type as never);
      if (cohort === null) {
        skippedUnclassified += 1;
        continue;
      }
      const snapshot = row.signal_snapshot as PtmSignalSnapshot | null;
      if (snapshot == null || typeof snapshot !== 'object') {
        skippedNoSnapshot += 1;
        continue;
      }
      if (cohort === 'success') successCount += 1;
      else failureCount += 1;

      for (const [key, raw] of Object.entries(snapshot)) {
        const signal = key as PtmSignalTypeT;
        const value =
          typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        if (value < 0) continue; // defensive — counts are non-negative
        const s = sums.get(signal) ?? { success: 0, failure: 0 };
        const c = counts.get(signal) ?? { success: 0, failure: 0 };
        s[cohort] += value;
        c[cohort] += 1;
        sums.set(signal, s);
        counts.set(signal, c);
        const prevMax = maxObserved.get(signal) ?? 0;
        if (value > prevMax) maxObserved.set(signal, value);
      }
    }

    const weights = new Map<PtmSignalTypeT, PtmTrainedWeight>();

    // Empty-cohort guard: with either side at zero the formula's
    // numerator is just the non-zero side and every weight pegs to ±1.
    // Refuse to publish weights in that case so the orchestrator falls
    // back to heuristic_v1.
    if (successCount > 0 && failureCount > 0) {
      for (const [signal, s] of sums) {
        const c = counts.get(signal) ?? { success: 0, failure: 0 };
        const successAvg = c.success > 0 ? s.success / c.success : 0;
        const failureAvg = c.failure > 0 ? s.failure / c.failure : 0;
        const denom = Math.max(failureAvg + successAvg, 0.1);
        const weight = (failureAvg - successAvg) / denom;
        weights.set(signal, {
          signal_type: signal,
          weight: round3(weight),
          training_count: c.success + c.failure,
          training_max: maxObserved.get(signal) ?? 0,
          success_avg: round3(successAvg),
          failure_avg: round3(failureAvg),
        });
      }
    }

    return {
      trained_at: new Date(),
      total_outcomes: successCount + failureCount,
      skipped_no_snapshot: skippedNoSnapshot,
      skipped_unclassified: skippedUnclassified,
      success_count: successCount,
      failure_count: failureCount,
      weights,
    };
  }

  /**
   * Pull a user's last-30-day signal counts grouped by signal_type. The
   * raw `value` column is intentionally ignored — the weighted engine
   * trains and scores on COUNTS only, matching what 1C captures into
   * signal_snapshot. (The heuristic engine v1 reads value for streak /
   * volume signals; v2 deliberately does not, to keep the feature
   * vector aligned with the training set.)
   */
  protected async observedCounts(
    userId: string,
  ): Promise<Map<PtmSignalTypeT, number>> {
    const since = new Date(
      Date.now() - PTM_WINDOWS.RECENT_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const grouped = await this.prisma.clientSignal.groupBy({
      by: ['signal_type'],
      where: { user_id: userId, recorded_at: { gte: since } },
      _count: { _all: true },
    });
    const map = new Map<PtmSignalTypeT, number>();
    for (const g of grouped as Array<{
      signal_type: PtmSignalTypeT;
      _count: { _all: number };
    }>) {
      map.set(g.signal_type, g._count._all);
    }
    return map;
  }
}

function activationThreshold(): number {
  const raw = process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES;
  if (raw === undefined || raw === '') {
    return PTM_WINDOWS.WEIGHTED_ACTIVATION_OUTCOMES;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return PTM_WINDOWS.WEIGHTED_ACTIVATION_OUTCOMES;
  }
  return parsed;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
