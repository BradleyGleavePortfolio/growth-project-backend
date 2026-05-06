import { Injectable, Logger } from '@nestjs/common';
import type { CoachEffectivenessScore, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// Phase 6A — Coach Effectiveness Score (per-coach scalar in [0, 100]).
//
// Algorithm (v1):
//   1. completion       (30%) — fraction of clients enrolled in trailing
//                                COMPLETION_WINDOW_DAYS days who reached
//                                outcome_type='completed_90day'.
//   2. risk_delta       (25%) — average reduction in PTM risk_score over
//                                the first FIRST_60_DAYS days for each
//                                still-active client. A client getting
//                                LESS risky (delta > 0) lifts the coach.
//   3. retention        (25%) — fraction of clients assigned in trailing
//                                RETENTION_WINDOW_DAYS days who are still
//                                on the platform 60+ days after assignment.
//   4. engagement       (20%) — capped average per-client message
//                                exchanges per week, where the cap stops
//                                a single noisy outlier from gaming the
//                                score (ENGAGEMENT_CAP_PER_WEEK).
//
// Composition: each component is normalized to [0, 1] then weighted; the
// sum is multiplied by 100 to yield the score.
//
// Buckets:
//   developing      = score < DEVELOPING_MAX                 (default 50)
//   consistent      = DEVELOPING_MAX <= score < HIGH_PERFORMER_MIN (default 75)
//   high-performer  = score >= HIGH_PERFORMER_MIN            (default 75)
//
// Doctrine:
//   * APPEND-ONLY: each score(...) call inserts a fresh row.
//   * Coach-only data; the OWNER is the only consumer (avoids gaming).
//   * Coaches with zero clients return score=0, bucket='developing',
//     factors carrying the empty-roster rationale.

const COMPLETION_WINDOW_DAYS = 120;
const RETENTION_WINDOW_DAYS = 90;
const RETENTION_HORIZON_DAYS = 60;
const FIRST_60_DAYS = 60;
const ENGAGEMENT_CAP_PER_WEEK = 5; // cap per client to neutralize outliers
const DAY_MS = 24 * 60 * 60 * 1000;

const WEIGHT_COMPLETION = 0.3;
const WEIGHT_RISK_DELTA = 0.25;
const WEIGHT_RETENTION = 0.25;
const WEIGHT_ENGAGEMENT = 0.2;

const DEVELOPING_MAX = 50;
const HIGH_PERFORMER_MIN = 75;

export type CoachEffectivenessBucket =
  | 'developing'
  | 'consistent'
  | 'high-performer';

export interface CoachEffectivenessFactor {
  key:
    | 'completion'
    | 'risk_delta'
    | 'retention'
    | 'engagement'
    | 'empty_roster';
  label: string;
  /** Normalized component value in [0, 1] before weighting. */
  observed: number;
  /** Weighted contribution to the final 0–100 score. */
  contribution: number;
  /** Sample size or denominator the component was computed against. */
  sample_size?: number;
}

export interface CoachEffectivenessFactorsBlob {
  components: CoachEffectivenessFactor[];
  // Convenience copy of the bucket cutoffs at compute time so the admin
  // console can render the same thresholds the engine used.
  thresholds: {
    developing_max: number;
    high_performer_min: number;
  };
}

@Injectable()
export class CoachEffectivenessService {
  private readonly logger = new Logger(CoachEffectivenessService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Compute + persist a fresh effectiveness score for one coach. */
  async score(coachId: string, now: Date = new Date()): Promise<CoachEffectivenessScore> {
    const factors = await this.computeFactors(coachId, now);
    const totalContribution = factors.components.reduce(
      (acc, f) => acc + f.contribution,
      0,
    );
    const rawScore = totalContribution * 100;
    const score = clamp(roundTo2(rawScore), 0, 100);
    const bucket = bucketFor(score);

    return this.prisma.coachEffectivenessScore.create({
      data: {
        coach_id: coachId,
        score,
        bucket,
        factors: factors as unknown as Prisma.InputJsonValue,
        basis: 'v1',
      },
    });
  }

  /** Latest persisted row, or null when the coach has no score yet. */
  async getLatest(
    coachId: string,
  ): Promise<CoachEffectivenessScore | null> {
    return this.prisma.coachEffectivenessScore.findFirst({
      where: { coach_id: coachId },
      orderBy: { computed_at: 'desc' },
    });
  }

  /**
   * Latest score for every active coach in the platform. OWNER-only
   * consumer (the admin console). Returns rows sorted by score DESC
   * by default, with `null` ordering last.
   */
  async listAll(): Promise<
    Array<{
      coach_id: string;
      coach_name: string;
      coach_email: string;
      latest: CoachEffectivenessScore | null;
    }>
  > {
    const coaches = await this.prisma.user.findMany({
      where: {
        role: 'coach',
        deleted_at: null,
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    const ids = coaches.map((c) => c.id);
    if (ids.length === 0) return [];

    // One round-trip pulls the per-coach latest row via window-style
    // groupBy + max(computed_at), then a bounded findMany resolves the
    // full payload. Avoids N+1 across the coach roster.
    const latestKeys = await this.prisma.coachEffectivenessScore.groupBy({
      by: ['coach_id'],
      where: { coach_id: { in: ids } },
      _max: { computed_at: true },
    });

    const conditions = latestKeys
      .map((k) => k._max.computed_at)
      .filter((d): d is Date => d instanceof Date);

    const rows = conditions.length
      ? await this.prisma.coachEffectivenessScore.findMany({
          where: {
            coach_id: { in: ids },
            computed_at: { in: conditions },
          },
        })
      : [];
    const byCoach = new Map<string, CoachEffectivenessScore>();
    for (const row of rows) {
      const prev = byCoach.get(row.coach_id);
      if (!prev || row.computed_at > prev.computed_at) {
        byCoach.set(row.coach_id, row);
      }
    }

    const merged = coaches.map((c) => ({
      coach_id: c.id,
      coach_name: c.name,
      coach_email: c.email,
      latest: byCoach.get(c.id) ?? null,
    }));
    merged.sort((a, b) => {
      const sa = a.latest?.score ?? -1;
      const sb = b.latest?.score ?? -1;
      return sb - sa;
    });
    return merged;
  }

  /** Score history for one coach (newest first), bounded to `limit`. */
  async listHistory(
    coachId: string,
    limit = 30,
  ): Promise<CoachEffectivenessScore[]> {
    const safeLimit = Math.max(1, Math.min(limit, 365));
    return this.prisma.coachEffectivenessScore.findMany({
      where: { coach_id: coachId },
      orderBy: { computed_at: 'desc' },
      take: safeLimit,
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async computeFactors(
    coachId: string,
    now: Date,
  ): Promise<CoachEffectivenessFactorsBlob> {
    const allClients = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        role: 'student',
        deleted_at: null,
      },
      select: {
        id: true,
        created_at: true,
        archived_at: true,
      },
    });

    if (allClients.length === 0) {
      return {
        components: [
          {
            key: 'empty_roster',
            label: 'No clients assigned',
            observed: 0,
            contribution: 0,
            sample_size: 0,
          },
        ],
        thresholds: {
          developing_max: DEVELOPING_MAX,
          high_performer_min: HIGH_PERFORMER_MIN,
        },
      };
    }

    const completion = await this.completionComponent(coachId, now);
    const riskDelta = await this.riskDeltaComponent(allClients, now);
    const retention = this.retentionComponent(allClients, now);
    const engagement = await this.engagementComponent(coachId, allClients, now);

    return {
      components: [completion, riskDelta, retention, engagement],
      thresholds: {
        developing_max: DEVELOPING_MAX,
        high_performer_min: HIGH_PERFORMER_MIN,
      },
    };
  }

  private async completionComponent(
    coachId: string,
    now: Date,
  ): Promise<CoachEffectivenessFactor> {
    const since = new Date(now.getTime() - COMPLETION_WINDOW_DAYS * DAY_MS);
    const enrolled = await this.prisma.user.count({
      where: {
        coach_id: coachId,
        role: 'student',
        created_at: { gte: since },
      },
    });
    if (enrolled === 0) {
      return {
        key: 'completion',
        label: '90-day completion rate (last 120 days)',
        observed: 0,
        contribution: 0,
        sample_size: 0,
      };
    }
    const completed = await this.prisma.clientOutcome.count({
      where: {
        outcome_type: 'completed_90day',
        labelled_at: { gte: since },
        user: { coach_id: coachId },
      },
    });
    const ratio = clamp(completed / enrolled, 0, 1);
    return {
      key: 'completion',
      label: '90-day completion rate (last 120 days)',
      observed: roundTo3(ratio),
      contribution: roundTo3(ratio * WEIGHT_COMPLETION),
      sample_size: enrolled,
    };
  }

  private async riskDeltaComponent(
    clients: Array<{ id: string; created_at: Date }>,
    now: Date,
  ): Promise<CoachEffectivenessFactor> {
    const cutoff = new Date(now.getTime() - FIRST_60_DAYS * DAY_MS);
    const eligible = clients.filter((c) => c.created_at <= cutoff);
    if (eligible.length === 0) {
      return {
        key: 'risk_delta',
        label: 'Average risk reduction over first 60 days',
        observed: 0,
        contribution: 0,
        sample_size: 0,
      };
    }

    const deltas: number[] = [];
    for (const client of eligible) {
      const windowEnd = new Date(
        client.created_at.getTime() + FIRST_60_DAYS * DAY_MS,
      );
      const earliest = await this.prisma.ptmPrediction.findFirst({
        where: {
          user_id: client.id,
          computed_at: { gte: client.created_at },
        },
        orderBy: { computed_at: 'asc' },
      });
      if (!earliest) continue;
      const latestInWindow = await this.prisma.ptmPrediction.findFirst({
        where: {
          user_id: client.id,
          computed_at: { gte: client.created_at, lte: windowEnd },
        },
        orderBy: { computed_at: 'desc' },
      });
      if (!latestInWindow) continue;
      // delta > 0 means the client got LESS risky → coach gets credit
      const delta = earliest.risk_score - latestInWindow.risk_score;
      deltas.push(delta);
    }

    if (deltas.length === 0) {
      return {
        key: 'risk_delta',
        label: 'Average risk reduction over first 60 days',
        observed: 0,
        contribution: 0,
        sample_size: 0,
      };
    }

    const avgDelta =
      deltas.reduce((acc, d) => acc + d, 0) / deltas.length;
    // delta range is [-1.0, +1.0]; normalize by clamping then mapping to [0, 1]
    // where 0 delta = 0.5 (neutral), full reduction = 1.0, full regression = 0.
    const normalized = clamp((avgDelta + 1) / 2, 0, 1);
    return {
      key: 'risk_delta',
      label: 'Average risk reduction over first 60 days',
      observed: roundTo3(avgDelta),
      contribution: roundTo3(normalized * WEIGHT_RISK_DELTA),
      sample_size: deltas.length,
    };
  }

  private retentionComponent(
    clients: Array<{ id: string; created_at: Date; archived_at: Date | null }>,
    now: Date,
  ): CoachEffectivenessFactor {
    const since = new Date(now.getTime() - RETENTION_WINDOW_DAYS * DAY_MS);
    const horizonCutoff = new Date(
      now.getTime() - RETENTION_HORIZON_DAYS * DAY_MS,
    );
    // Numerator candidates: assigned within trailing 90 days AND old enough
    // to have crossed the 60-day horizon. If a client was assigned 30 days
    // ago we cannot know their 60-day retention yet, so they don't count.
    const denomCandidates = clients.filter(
      (c) => c.created_at >= since && c.created_at <= horizonCutoff,
    );
    if (denomCandidates.length === 0) {
      return {
        key: 'retention',
        label: '60-day retention rate (last 90 days)',
        observed: 0,
        contribution: 0,
        sample_size: 0,
      };
    }
    const retained = denomCandidates.filter(
      (c) => c.archived_at === null || c.archived_at > new Date(c.created_at.getTime() + RETENTION_HORIZON_DAYS * DAY_MS),
    );
    const ratio = clamp(retained.length / denomCandidates.length, 0, 1);
    return {
      key: 'retention',
      label: '60-day retention rate (last 90 days)',
      observed: roundTo3(ratio),
      contribution: roundTo3(ratio * WEIGHT_RETENTION),
      sample_size: denomCandidates.length,
    };
  }

  private async engagementComponent(
    coachId: string,
    clients: Array<{ id: string }>,
    now: Date,
  ): Promise<CoachEffectivenessFactor> {
    if (clients.length === 0) {
      return {
        key: 'engagement',
        label: 'Capped messages per client per week',
        observed: 0,
        contribution: 0,
        sample_size: 0,
      };
    }
    const since = new Date(now.getTime() - 28 * DAY_MS); // 4 weeks
    const messagesByClient = await this.prisma.coachMessage.groupBy({
      by: ['client_id'],
      where: {
        coach_id: coachId,
        created_at: { gte: since },
      },
      _count: { _all: true },
    });
    const totals = new Map<string, number>();
    for (const row of messagesByClient) {
      totals.set(row.client_id, row._count._all);
    }
    let cappedSum = 0;
    for (const c of clients) {
      const perWeek = (totals.get(c.id) ?? 0) / 4;
      cappedSum += Math.min(perWeek, ENGAGEMENT_CAP_PER_WEEK);
    }
    const avg = cappedSum / clients.length;
    const normalized = clamp(avg / ENGAGEMENT_CAP_PER_WEEK, 0, 1);
    return {
      key: 'engagement',
      label: 'Capped messages per client per week',
      observed: roundTo3(avg),
      contribution: roundTo3(normalized * WEIGHT_ENGAGEMENT),
      sample_size: clients.length,
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundTo3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function bucketFor(score: number): CoachEffectivenessBucket {
  if (score >= HIGH_PERFORMER_MIN) return 'high-performer';
  if (score >= DEVELOPING_MAX) return 'consistent';
  return 'developing';
}

export const COACH_EFFECTIVENESS_CONSTANTS = {
  COMPLETION_WINDOW_DAYS,
  RETENTION_WINDOW_DAYS,
  RETENTION_HORIZON_DAYS,
  FIRST_60_DAYS,
  ENGAGEMENT_CAP_PER_WEEK,
  WEIGHT_COMPLETION,
  WEIGHT_RISK_DELTA,
  WEIGHT_RETENTION,
  WEIGHT_ENGAGEMENT,
  DEVELOPING_MAX,
  HIGH_PERFORMER_MIN,
} as const;
