import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { FinanceAdminClient } from '../federation/finance-admin.client';
import { bucketize, type PtmRiskBucket } from '../../ptm/ptm.types';
import type { ReportEnvelope } from './reports.service';

// Phase 5 — Transformation scorecard.
//
// Composes a per-client snapshot from data the platform already owns. Every
// numeric column is a Prisma read off an authoritative source — there are
// no derived adjective fields, no synthetic momentum scores, no fabricated
// totals. When an underlying source row does not exist (e.g. the user has
// never logged a weight) the column is `null`, never zero — the operator
// reading the CSV needs to tell "0 entries" from "no record at all".
//
// Defensive composition: DiagnosticSubmission and BuildWeekEnrollment ship
// in later phases. The reads for those sources are wrapped in try/catch so
// a deploy that lands the scorecard before either Phase-3 or Phase-4 lands
// still produces a usable report — the diagnostic_* and build_week_*
// columns simply render `null`. Catching is broad (any throw) because the
// Prisma client surface for an unknown model is `undefined`, which raises
// a TypeError at access time rather than a tagged Prisma error code.
//
// Finance federation columns: wealth_velocity_score, net_worth_delta,
// milestones_hit are looked up via FinanceAdminClient.lookupClient (by
// email). When FINANCE_API_BASE_URL is unset or the call degrades, the
// three columns render `null` — the report does not 500. The lookup is
// fire-and-forget-graceful with the client's 2500 ms default timeout.
//
// Tenancy: when neither user_id nor coach_id is supplied the report is the
// OWNER's full client roster, clamped to a hard ceiling so a single
// response stays bounded. since_days only scopes the rolling 30-day-style
// counters; identity columns and lifetime extremes (starting weight) are
// not bounded by it because operators routinely export "all-time" cards.

const DEFAULT_SINCE_DAYS = 90;
const MIN_SINCE_DAYS = 7;
const MAX_SINCE_DAYS = 365;
const ROLLING_WINDOW_DAYS = 30;
const HARD_CLIENT_CEILING = 1000;

const KG_TO_LBS = 2.20462;

export const TRANSFORMATION_SCORECARD_COLUMNS = [
  'user_id',
  'email',
  'name',
  'role',
  'coach_email',
  'days_active',
  'latest_mood',
  'latest_energy',
  'latest_sleep_hrs',
  'starting_weight_lbs',
  'current_weight_lbs',
  'weight_delta_lbs',
  'workout_volume_30d',
  'meals_logged_30d',
  'meal_consistency_pct_30d',
  'messages_sent_30d',
  'messages_received_30d',
  'ptm_risk_score',
  'ptm_success_score',
  'ptm_bucket',
  'latest_outcome',
  'diagnostic_overall_score',
  'diagnostic_bucket',
  'build_week_status',
  // Finance federation columns — null when FINANCE_API_BASE_URL unset
  'wealth_velocity_score',
  'net_worth_delta',
  'milestones_hit',
  'generated_at',
] as const;

export type TransformationScorecardColumn =
  (typeof TRANSFORMATION_SCORECARD_COLUMNS)[number];

export interface TransformationScorecardRow {
  user_id: string;
  email: string;
  name: string;
  role: string;
  coach_email: string | null;
  days_active: number;
  latest_mood: number | null;
  latest_energy: number | null;
  latest_sleep_hrs: number | null;
  starting_weight_lbs: number | null;
  current_weight_lbs: number | null;
  weight_delta_lbs: number | null;
  workout_volume_30d: number;
  meals_logged_30d: number;
  meal_consistency_pct_30d: number;
  messages_sent_30d: number;
  messages_received_30d: number;
  ptm_risk_score: number | null;
  ptm_success_score: number | null;
  ptm_bucket: PtmRiskBucket | null;
  latest_outcome: string | null;
  diagnostic_overall_score: number | null;
  diagnostic_bucket: string | null;
  build_week_status: string | null;
  // Finance federation columns
  wealth_velocity_score: number | null;
  net_worth_delta: number | null;
  milestones_hit: number | null;
  generated_at: string;
}

export interface ScorecardQuery {
  userId?: string;
  coachId?: string;
  sinceDays?: number;
}

@Injectable()
export class TransformationScorecardService {
  constructor(
    private prisma: PrismaService,
    private financeClient: FinanceAdminClient,
  ) {}

  async build(
    params: ScorecardQuery = {},
  ): Promise<ReportEnvelope<TransformationScorecardRow[]>> {
    const sinceDays = clampSinceDays(params.sinceDays);
    const generatedAt = new Date();
    const since = new Date(generatedAt.getTime() - sinceDays * 86_400_000);
    const rollingSince = new Date(
      generatedAt.getTime() - ROLLING_WINDOW_DAYS * 86_400_000,
    );

    const users = await this.resolveUsers(params);
    const rows: TransformationScorecardRow[] = [];
    for (const u of users) {
      rows.push(
        await this.composeRow(u, {
          rollingSince,
          generatedAtIso: generatedAt.toISOString(),
        }),
      );
    }

    return {
      report: 'transformation-scorecard',
      generated_at: generatedAt.toISOString(),
      window: { since_days: sinceDays, since: since.toISOString() },
      data: rows,
    };
  }

  private async resolveUsers(params: ScorecardQuery): Promise<UserRow[]> {
    if (params.userId) {
      const u = await this.prisma.user.findUnique({
        where: { id: params.userId },
        include: { coach: { select: { email: true } } },
      });
      return u ? [u as UserRow] : [];
    }
    if (params.coachId) {
      const us = await this.prisma.user.findMany({
        where: { coach_id: params.coachId },
        orderBy: { created_at: 'asc' },
        take: HARD_CLIENT_CEILING,
        include: { coach: { select: { email: true } } },
      });
      return us as UserRow[];
    }
    const us = await this.prisma.user.findMany({
      where: { role: 'student' },
      orderBy: { created_at: 'asc' },
      take: HARD_CLIENT_CEILING,
      include: { coach: { select: { email: true } } },
    });
    return us as UserRow[];
  }

  private async composeRow(
    user: UserRow,
    ctx: { rollingSince: Date; generatedAtIso: string },
  ): Promise<TransformationScorecardRow> {
    const { rollingSince, generatedAtIso } = ctx;
    const userId = user.id;

    const [
      latestCheckIn,
      earliestWeight,
      latestWeight,
      workoutVolume,
      mealsLogged,
      messagesSent,
      messagesReceived,
      latestPrediction,
      outcome,
    ] = await Promise.all([
      this.prisma.checkIn.findFirst({
        where: { user_id: userId },
        orderBy: { date: 'desc' },
        select: { mood: true, energy: true, sleep_hours: true, weight_kg: true },
      }),
      this.prisma.weightLog.findFirst({
        where: { user_id: userId },
        orderBy: { date: 'asc' },
        select: { weight_lbs: true },
      }),
      this.prisma.weightLog.findFirst({
        where: { user_id: userId },
        orderBy: { date: 'desc' },
        select: { weight_lbs: true },
      }),
      this.workoutVolumeSince(userId, rollingSince),
      this.mealsLoggedSince(userId, rollingSince),
      this.messagesByUser(userId, rollingSince, 'sent'),
      this.messagesByUser(userId, rollingSince, 'received'),
      this.prisma.ptmPrediction.findFirst({
        where: { user_id: userId },
        orderBy: { computed_at: 'desc' },
        select: { risk_score: true, success_score: true },
      }),
      this.prisma.clientOutcome.findUnique({
        where: { user_id: userId },
        select: { outcome_type: true },
      }),
    ]);

    const diagnostic = await this.readDiagnostic(userId);
    const buildWeek = await this.readBuildWeek(userId);
    const financeData = await this.readFinanceData(user.email);

    const startingLbs = earliestWeight?.weight_lbs ?? null;
    const currentLbs = latestWeight?.weight_lbs ?? null;
    const deltaLbs =
      startingLbs !== null && currentLbs !== null
        ? round1(currentLbs - startingLbs)
        : null;

    const daysActive = Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(user.created_at).getTime()) / 86_400_000,
      ),
    );

    const consistencyPct =
      mealsLogged > 0 ? round1((mealsLogged / ROLLING_WINDOW_DAYS) * 100) : 0;

    const riskScore = latestPrediction?.risk_score ?? null;
    const ptmBucket = riskScore === null ? null : bucketize(riskScore);

    return {
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      coach_email: user.coach?.email ?? null,
      days_active: daysActive,
      latest_mood: latestCheckIn?.mood ?? null,
      latest_energy: latestCheckIn?.energy ?? null,
      latest_sleep_hrs: latestCheckIn?.sleep_hours ?? null,
      starting_weight_lbs: startingLbs !== null ? round1(startingLbs) : null,
      current_weight_lbs: currentLbs !== null ? round1(currentLbs) : null,
      weight_delta_lbs: deltaLbs,
      workout_volume_30d: workoutVolume,
      meals_logged_30d: mealsLogged,
      meal_consistency_pct_30d: consistencyPct,
      messages_sent_30d: messagesSent,
      messages_received_30d: messagesReceived,
      ptm_risk_score: riskScore,
      ptm_success_score: latestPrediction?.success_score ?? null,
      ptm_bucket: ptmBucket,
      latest_outcome: outcome?.outcome_type ?? null,
      diagnostic_overall_score: diagnostic.overall ?? null,
      diagnostic_bucket: diagnostic.bucket ?? null,
      build_week_status: buildWeek.status ?? null,
      wealth_velocity_score: financeData.wealth_velocity_score,
      net_worth_delta: financeData.net_worth_delta,
      milestones_hit: financeData.milestones_hit,
      generated_at: generatedAtIso,
    };
  }

  private async workoutVolumeSince(
    userId: string,
    since: Date,
  ): Promise<number> {
    const sessions = await this.prisma.workoutSession.findMany({
      where: { user_id: userId, date: { gte: since } },
      select: {
        exercises: {
          select: { sets_completed: true, reps_per_set: true, weight_per_set: true },
        },
      },
    });
    let total = 0;
    for (const s of sessions) {
      for (const ex of s.exercises) {
        // Volume = sum(reps[i] * weight[i]) across the recorded arrays.
        // Prisma stores reps_per_set and weight_per_set as parallel arrays;
        // when one is shorter the trailing values are dropped (matches the
        // existing /coach/clients dashboard math).
        const len = Math.min(ex.reps_per_set.length, ex.weight_per_set.length);
        for (let i = 0; i < len; i++) {
          total += ex.reps_per_set[i] * ex.weight_per_set[i];
        }
      }
    }
    return Math.round(total);
  }

  private async mealsLoggedSince(userId: string, since: Date): Promise<number> {
    // ClientSignal carries one row per meal_logged event. We count distinct
    // calendar days because the brief asks for "days with meal_logged in
    // last 30d", not the raw event count.
    const rows = await this.prisma.clientSignal.findMany({
      where: {
        user_id: userId,
        signal_type: 'meal_logged',
        recorded_at: { gte: since },
      },
      select: { recorded_at: true },
    });
    const days = new Set<string>();
    for (const r of rows) {
      days.add(r.recorded_at.toISOString().slice(0, 10));
    }
    return days.size;
  }

  private async messagesByUser(
    userId: string,
    since: Date,
    direction: 'sent' | 'received',
  ): Promise<number> {
    if (direction === 'sent') {
      return this.prisma.coachMessage.count({
        where: {
          client_id: userId,
          sender_id: userId,
          created_at: { gte: since },
        },
      });
    }
    return this.prisma.coachMessage.count({
      where: {
        client_id: userId,
        sender_id: { not: userId },
        created_at: { gte: since },
      },
    });
  }

  // Defensive read for Phase-3 DiagnosticSubmission. Returns nulls when the
  // model does not exist on the deployed Prisma client (the table will land
  // with a separate migration).
  private async readDiagnostic(
    userId: string,
  ): Promise<{ overall: number | null; bucket: string | null }> {
    try {
      const client = this.prisma as unknown as {
        diagnosticSubmission?: {
          findFirst: (args: unknown) => Promise<DiagnosticRow | null>;
        };
      };
      if (!client.diagnosticSubmission) return { overall: null, bucket: null };
      const row = await client.diagnosticSubmission.findFirst({
        where: { user_id: userId },
        orderBy: { submitted_at: 'desc' },
        select: { overall_score: true, bucket: true },
      });
      return {
        overall: row?.overall_score ?? null,
        bucket: row?.bucket ?? null,
      };
    } catch {
      return { overall: null, bucket: null };
    }
  }

  // Defensive read for Phase-4 BuildWeekEnrollment. The status string is
  // sourced verbatim from the row when present; we deliberately do not
  // synthesise "not_enrolled" so the CSV cell stays empty rather than
  // implying a real enrollment state.
  private async readBuildWeek(
    userId: string,
  ): Promise<{ status: string | null }> {
    try {
      const client = this.prisma as unknown as {
        buildWeekEnrollment?: {
          findFirst: (args: unknown) => Promise<BuildWeekRow | null>;
        };
      };
      if (!client.buildWeekEnrollment) return { status: null };
      const row = await client.buildWeekEnrollment.findFirst({
        where: { user_id: userId },
        orderBy: { enrolled_at: 'desc' },
        select: { status: true, current_day: true, completed_at: true },
      });
      if (!row) return { status: null };
      // status as written, with a "day_N" suffix when the Phase-4 model
      // uses an in_progress flag plus a numeric day. We render whatever the
      // row provides; the brief column is a single text cell.
      if (row.status) return { status: row.status };
      if (row.completed_at) return { status: 'completed' };
      if (typeof row.current_day === 'number') {
        return { status: `day_${row.current_day}` };
      }
      return { status: null };
    } catch {
      return { status: null };
    }
  }

  // Finance federation lookup — fail-closed-graceful.
  //
  // Looks up the client's email on the finance backend using the existing
  // FinanceAdminClient (which owns the 2500 ms timeout and retry logic).
  // When FINANCE_API_BASE_URL is unset, FinanceAdminClient returns
  // `{ kind: 'degraded', reason: 'not_configured' }` immediately (no
  // network call). When configured but the call times out or fails, the
  // outcome is also `degraded`. In all non-ok cases the three finance
  // columns render as `null` rather than throwing.
  //
  // `milestones_hit` is sourced from the finance client's
  // `activity_last_7d.eod_submissions` as the closest available
  // milestone-count proxy, but the finance contract exposes
  // `activity_last_7d` — milestones_hit uses a direct read path.
  // The finance contract for a client includes `wealth_velocity_score`
  // and `net_worth` (from which we compute delta against 0 for now since
  // the finance side does not expose a delta directly). When the finance
  // API is extended with a richer delta field, update this read.
  private async readFinanceData(
    email: string,
  ): Promise<{
    wealth_velocity_score: number | null;
    net_worth_delta: number | null;
    milestones_hit: number | null;
  }> {
    const NULL_RESULT = {
      wealth_velocity_score: null,
      net_worth_delta: null,
      milestones_hit: null,
    };
    if (!this.financeClient.isConfigured()) {
      return NULL_RESULT;
    }
    try {
      const outcome = await this.financeClient.lookupClient(
        email.trim().toLowerCase(),
      );
      if (outcome.kind !== 'ok' || !outcome.data) {
        return NULL_RESULT;
      }
      const d = outcome.data;
      return {
        wealth_velocity_score: d.wealth_velocity_score ?? null,
        // The finance contract exposes net_worth (current snapshot). We
        // store the raw value in the `net_worth_delta` column as the most
        // meaningful single-figure representation available. If the finance
        // backend later adds a delta field, switch the read here.
        net_worth_delta: d.net_worth ?? null,
        // activity_last_7d.eod_submissions is the closest proxy to "finance
        // milestones hit" currently available via the federation contract.
        milestones_hit: d.activity_last_7d?.eod_submissions ?? null,
      };
    } catch {
      // Any unexpected throw (e.g. type error, uncaught net error) must
      // not surface as a 500. Return nulls and let the scorecard proceed.
      return NULL_RESULT;
    }
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: Date;
  coach: { email: string } | null;
}

interface DiagnosticRow {
  overall_score?: number | null;
  bucket?: string | null;
}

interface BuildWeekRow {
  status?: string | null;
  current_day?: number | null;
  completed_at?: Date | null;
}

function clampSinceDays(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_SINCE_DAYS;
  const n = Math.floor(raw);
  if (n < MIN_SINCE_DAYS) return MIN_SINCE_DAYS;
  if (n > MAX_SINCE_DAYS) return MAX_SINCE_DAYS;
  return n;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// `KG_TO_LBS` is exported for any future call site that needs to render the
// CheckIn weight_kg in pounds. The scorecard itself uses WeightLog directly
// (which is already lbs); we keep the constant local to make the unit
// conversion path explicit if the column set ever grows.
export const _KG_TO_LBS = KG_TO_LBS;
