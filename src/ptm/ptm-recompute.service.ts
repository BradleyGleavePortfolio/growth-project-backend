import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type PtmPrediction } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PtmHeuristicService } from './ptm-heuristic.service';
import { PtmWeightedService } from './ptm-weighted.service';
import {
  bucketize,
  PTM_WINDOWS,
  type PtmPredictionBasisT,
  type PtmRiskBucket,
  type PtmScoreResult,
} from './ptm.types';

// Phase 6B hook contract. PtmRecomputeService imports the alert service
// via a structural interface to avoid a hard module dependency at the
// type level; the real binding is wired in CoachModule + PtmModule.
// `@Optional()` keeps the constructor compatible with existing tests
// that build PtmRecomputeService without the alerts service.
export interface CoachAlertsServiceLike {
  createAlert(input: {
    coachId: string;
    clientId: string;
    alertType: 'risk_red_transition' | 'consecutive_misses' | 'streak_dropped' | 'finance_eod_gap';
    severity?: 'info' | 'warning' | 'critical';
    message: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
}

export const COACH_ALERTS_SERVICE = Symbol('COACH_ALERTS_SERVICE');

/**
 * PtmRecomputeService — orchestrator for the heuristic + weighted
 * scoring engines. The single writer of PtmPrediction rows.
 *
 * Doctrine:
 *   * PtmPrediction is APPEND-ONLY. Always create, never update.
 *   * Engine selection: if PtmWeightedService.isActive() resolves true
 *     we use it; otherwise the heuristic. Activation is a property of
 *     the dataset (>= PTM_WINDOWS.WEIGHTED_ACTIVATION_OUTCOMES labelled
 *     outcomes), not of the user being scored — the same engine is
 *     used for every user in a given run.
 *   * recomputeBatch: best-effort. A single user's failure MUST NEVER
 *     abort the batch. We catch per-user, log, and increment errors.
 *   * The eligible set is "users with >= 1 ClientSignal in the last
 *     PTM_WINDOWS.RECENT_SIGNAL_WINDOW_DAYS". Brand-new users with no
 *     signals are skipped (the heuristic would just return zeros).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 5000;
const MAX_BATCH_LIMIT = 50000;
const MIN_BATCH_LIMIT = 1;
const CHUNK_SIZE = 100;
const CHUNK_PAUSE_MS = 25;

export interface RecomputeBatchOptions {
  limit?: number;
  // Override "now" — used by tests so they don't have to manipulate
  // the real wall-clock to drive the recent-signal window.
  now?: Date;
}

export interface RecomputeBatchReport {
  considered: number;
  recomputed: number;
  errors: number;
}

function resolveLimit(input?: number): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return clampInt(Math.trunc(input), MIN_BATCH_LIMIT, MAX_BATCH_LIMIT);
  }
  const env = process.env.PTM_RECOMPUTE_BATCH_LIMIT;
  const parsed = env ? parseInt(env, 10) : NaN;
  if (Number.isFinite(parsed)) {
    return clampInt(parsed, MIN_BATCH_LIMIT, MAX_BATCH_LIMIT);
  }
  return DEFAULT_BATCH_LIMIT;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

@Injectable()
export class PtmRecomputeService {
  private readonly logger = new Logger(PtmRecomputeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly heuristic: PtmHeuristicService,
    private readonly weighted: PtmWeightedService,
    @Optional()
    @Inject(COACH_ALERTS_SERVICE)
    private readonly coachAlerts?: CoachAlertsServiceLike,
  ) {}

  // Score a single user and APPEND a fresh PtmPrediction row. The
  // engine selection is reevaluated on every call so a freshly-crossed
  // activation threshold takes effect on the very next recompute.
  //
  // Phase 6B: AFTER the new prediction is persisted, compare its bucket
  // against the prior prediction. On a green/amber → red transition we
  // create a CoachAlert for the assigned coach. The hook is fire-and-
  // forget — a failure in the alert path can never bubble back into the
  // recompute (which itself is best-effort and tolerates per-user
  // failures already).
  async recomputeOne(userId: string): Promise<PtmPrediction> {
    const previous = await this.prisma.ptmPrediction.findFirst({
      where: { user_id: userId },
      orderBy: { computed_at: 'desc' },
    });

    const useWeighted = await this.weighted.isActive();
    let result: PtmScoreResult;
    if (useWeighted) {
      result = await this.weighted.score(userId);
    } else {
      result = await this.heuristic.score(userId);
    }
    const created = await this.persist(userId, result);
    await this.maybeFireRedTransitionAlert(userId, previous, created);
    return created;
  }

  private async maybeFireRedTransitionAlert(
    userId: string,
    previous: PtmPrediction | null,
    next: PtmPrediction,
  ): Promise<void> {
    if (!this.coachAlerts) return;
    if ((process.env.COACH_ALERT_RED_TRANSITION_ENABLED ?? '').toLowerCase() === 'false') {
      return;
    }
    const nextBucket: PtmRiskBucket = bucketize(next.risk_score);
    if (nextBucket !== 'red') return;
    const prevBucket: PtmRiskBucket | null = previous ? bucketize(previous.risk_score) : null;
    if (prevBucket === 'red') return; // already red — dedup window in service handles re-flap

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, coach_id: true },
      });
      if (!user || !user.coach_id) return;
      const pct = Math.round(next.risk_score * 100);
      await this.coachAlerts.createAlert({
        coachId: user.coach_id,
        clientId: user.id,
        alertType: 'risk_red_transition',
        severity: 'critical',
        message: `${user.name} crossed into the red risk band (${pct}%).`,
        payload: {
          prior_bucket: prevBucket,
          next_bucket: nextBucket,
          risk_score: next.risk_score,
          prediction_id: next.id,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`PTM red-transition alert failed (user=${userId}): ${msg}`);
    }
  }

  // Walk the eligible set in CHUNK_SIZE batches. A failure on one user
  // is logged and counted but does not abort the run — the cron is
  // best-effort, and the next tick will retry naturally.
  async recomputeBatch(
    options: RecomputeBatchOptions = {},
  ): Promise<RecomputeBatchReport> {
    const now = options.now ?? new Date();
    const limit = resolveLimit(options.limit);
    const since = new Date(
      now.getTime() - PTM_WINDOWS.RECENT_SIGNAL_WINDOW_DAYS * DAY_MS,
    );

    const eligibleRows = await this.prisma.clientSignal.findMany({
      where: { recorded_at: { gte: since } },
      distinct: ['user_id'],
      orderBy: { user_id: 'asc' },
      take: limit,
      select: { user_id: true },
    });
    const userIds = eligibleRows.map((r) => r.user_id);

    let recomputed = 0;
    let errors = 0;
    for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
      const slice = userIds.slice(i, i + CHUNK_SIZE);
      for (const userId of slice) {
        try {
          await this.recomputeOne(userId);
          recomputed += 1;
        } catch (err) {
          errors += 1;
          const msg = err instanceof Error ? err.message : String(err);
          // Never include PII (no email, no name) — user_id only.
          this.logger.error(
            `PTM recompute failed (user=${userId}): ${msg}`,
          );
        }
      }
      if (i + CHUNK_SIZE < userIds.length) {
        await sleep(CHUNK_PAUSE_MS);
      }
    }

    return {
      considered: userIds.length,
      recomputed,
      errors,
    };
  }

  // Single source of truth for prediction writes. APPEND-ONLY: callers
  // never UPDATE; every recompute creates a fresh row so the admin
  // "score history" drawer can show drift over time.
  private async persist(
    userId: string,
    result: PtmScoreResult,
  ): Promise<PtmPrediction> {
    const basis: PtmPredictionBasisT = result.basis;
    return this.prisma.ptmPrediction.create({
      data: {
        user_id: userId,
        risk_score: result.riskScore,
        success_score: result.successScore,
        prediction_basis: basis,
        factors: result.factors as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
