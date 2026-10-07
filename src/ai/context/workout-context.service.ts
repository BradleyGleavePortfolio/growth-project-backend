// B-AIB3-126 — per-client workout context v2 (plan section 1): enums and numbers only, no name / weight / snacks / messages /
// client-written text. Callers run their tenancy check first; box-2 consent is enforced where data leaves (adapter / gateway).
// Coach style reads ONLY plans the coach owns (WorkoutPlan.coach_id = coachId) and holds no client data.
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { classifyStrengthDay, median, splitOf } from '../../roman/playbook/playbook-signals.service';
import type { PlaybookDayType, PlaybookSplit } from '../../roman/playbook/playbook-signals.types';
import { InjuryAreaV2, seedExerciseFor, toInjuryAreas } from '../gateway/workout-builder/training-substitutions';

const DAY_MS = 24 * 60 * 60 * 1000;
const STYLE_TTL_MS = 10 * 60 * 1000;
const ENUM_TOKEN = /^[a-z0-9_ -]{1,40}$/i;

export type Trend = 'up' | 'flat' | 'down';
export interface WorkoutHistoryEntry { id: string; last_weight_lbs: number | null; last_reps: number | null; best_e1rm_lbs: number | null; sessions: number }
export interface WorkoutRecovery { sleep_hours_avg_7d: number | null; resting_hr_trend: Trend | null; hrv_trend: Trend | null }
export interface WorkoutClientSignals {
  goal: string | null; experience: string | null; equipment: string[]; days_per_week: number | null; injuries: InjuryAreaV2[];
  screening_flag: boolean; history_6w: WorkoutHistoryEntry[]; adherence_pct_4w: number | null;
  check_ins: Array<{ energy: number | null; soreness: number | null; sleep_hours: number | null }>;
  recovery?: WorkoutRecovery; // only while the client has an active wearable connection
}
export interface CoachStyleSignals {
  plans: number; rep_range_pct: { low_1_5: number; mid_6_12: number; high_13_30: number; timed: number }; median_sets: number | null;
  median_rest_seconds: number | null; top_exercise_ids: string[]; split: PlaybookSplit; superset_rate_pct: number;
}
export interface WorkoutContextV2 { client: WorkoutClientSignals | null; coach_style: CoachStyleSignals | null }

type SessionRow = { id: string; exercises: Array<{ exercise_name: string; reps_per_set: number[]; weight_per_set: number[] }> };
type SampleRow = { metric: string; value: number; start_at: Date };
type PlanRow = { exercises: Array<{ exercise_external_id: string; sets: number; reps_or_duration_seconds: number; rest_seconds: number | null; superset_group_id: string | null }> };

const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

/** Last 6 weeks of logged sets (sessions newest first) -> per library id: heaviest set of the last session, best e1RM, sessions. */
export function historyFromSessions(sessions: readonly SessionRow[], max = 30): WorkoutHistoryEntry[] {
  const byId = new Map<string, WorkoutHistoryEntry & { last: string; seen: Set<string> }>();
  for (const s of sessions) {
    for (const e of s.exercises) {
      const seed = seedExerciseFor(e.exercise_name);
      if (!seed) continue; // custom names are client-written text: never sent
      let h = byId.get(seed.id);
      if (!h) {
        if (byId.size >= max) continue;
        h = { id: seed.id, last_weight_lbs: null, last_reps: null, best_e1rm_lbs: null, sessions: 0, last: s.id, seen: new Set() };
        byId.set(seed.id, h);
      }
      if (!h.seen.has(s.id)) {
        h.seen.add(s.id);
        h.sessions += 1;
      }
      const n = Math.min(e.reps_per_set.length, e.weight_per_set.length);
      for (let i = 0; i < n; i++) {
        const r = e.reps_per_set[i];
        const w = e.weight_per_set[i];
        if (!(Number.isFinite(r) && Number.isFinite(w) && r >= 1 && r <= 30 && w > 0 && w <= 2_000)) continue;
        const e1 = round1(w * (1 + r / 30));
        if (h.best_e1rm_lbs === null || e1 > h.best_e1rm_lbs) h.best_e1rm_lbs = e1;
        if (s.id === h.last && (h.last_weight_lbs === null || w > h.last_weight_lbs)) {
          h.last_weight_lbs = w;
          h.last_reps = r;
        }
      }
    }
  }
  return [...byId.values()].map(({ last: _l, seen: _s, ...entry }) => entry);
}

function trendOf(samples: readonly SampleRow[], metric: string, now: number): Trend | null {
  const recent: number[] = [];
  const base: number[] = [];
  for (const s of samples) {
    if (s.metric !== metric || !Number.isFinite(s.value) || s.value <= 0) continue;
    const age = now - s.start_at.getTime();
    if (age < 7 * DAY_MS) recent.push(s.value);
    else if (age < 21 * DAY_MS) base.push(s.value);
  }
  if (recent.length === 0 || base.length === 0) return null;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = (avg(recent) - avg(base)) / avg(base);
  return delta > 0.03 ? 'up' : delta < -0.03 ? 'down' : 'flat';
}

/** 7-day average sleep (one value per night: the longest record that day) and resting HR / HRV direction vs the prior 2 weeks. */
export function recoveryFromSamples(samples: readonly SampleRow[], now: Date): WorkoutRecovery {
  const t = now.getTime();
  const nightly = new Map<string, number>();
  for (const s of samples) {
    if ((s.metric !== 'SLEEP_TOTAL_MIN' && s.metric !== 'SLEEP_DURATION_MIN') || t - s.start_at.getTime() >= 7 * DAY_MS) continue;
    if (!Number.isFinite(s.value) || s.value <= 0 || s.value > 24 * 60) continue;
    const day = s.start_at.toISOString().slice(0, 10);
    nightly.set(day, Math.max(nightly.get(day) ?? 0, s.value));
  }
  const nights = [...nightly.values()];
  return {
    sleep_hours_avg_7d: nights.length ? round1(nights.reduce((a, b) => a + b, 0) / nights.length / 60) : null,
    resting_hr_trend: trendOf(samples, 'RESTING_HEART_RATE_BPM', t),
    hrv_trend: trendOf(samples, 'HRV_MS', t),
  };
}

/** Aggregates over the coach's own plans: rep ranges, sets, rest, top 40 library ids, split, superset rate. */
export function coachStyleFromPlans(plans: readonly PlanRow[]): CoachStyleSignals | null {
  const rows = plans.flatMap((p) => p.exercises);
  if (rows.length === 0) return null;
  const bands = { low_1_5: 0, mid_6_12: 0, high_13_30: 0, timed: 0 };
  const counts = new Map<string, number>();
  const days: Partial<Record<PlaybookDayType, number>> = {};
  for (const r of rows) {
    const v = r.reps_or_duration_seconds;
    if (v > 30) bands.timed += 1;
    else if (v >= 13) bands.high_13_30 += 1;
    else if (v >= 6) bands.mid_6_12 += 1;
    else bands.low_1_5 += 1;
    counts.set(r.exercise_external_id, (counts.get(r.exercise_external_id) ?? 0) + 1);
  }
  for (const p of plans) {
    const type = classifyStrengthDay(p.exercises.map((e) => seedExerciseFor(e.exercise_external_id)?.target ?? ''));
    if (type) days[type] = (days[type] ?? 0) + 1;
  }
  return {
    plans: plans.length,
    rep_range_pct: {
      low_1_5: pct(bands.low_1_5, rows.length), mid_6_12: pct(bands.mid_6_12, rows.length),
      high_13_30: pct(bands.high_13_30, rows.length), timed: pct(bands.timed, rows.length),
    },
    median_sets: median(rows.map((r) => r.sets)),
    median_rest_seconds: median(rows.flatMap((r) => (r.rest_seconds == null ? [] : [r.rest_seconds]))),
    top_exercise_ids: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id]) => id),
    split: splitOf(days),
    superset_rate_pct: pct(rows.filter((r) => r.superset_group_id).length, rows.length),
  };
}

/** Names of the signals present, for the propose response's `context_used`. */
export function contextUsedKeys(ctx: WorkoutContextV2): string[] {
  const c = ctx.client;
  const used: Array<[unknown, string]> = c
    ? [
        [c.goal, 'goal'], [c.experience, 'experience'], [c.equipment.length, 'equipment'], [c.days_per_week, 'schedule'],
        [c.injuries.length, 'injuries'], [c.screening_flag, 'health_screening'], [c.history_6w.length, 'training_history'],
        [c.adherence_pct_4w !== null, 'adherence'], [c.check_ins.length, 'check_ins'], [c.recovery, 'recovery'],
      ]
    : [];
  return [...used, [ctx.coach_style, 'coach_style'] as [unknown, string]].filter(([v]) => Boolean(v)).map(([, k]) => k);
}

@Injectable()
export class WorkoutContextService {
  private readonly styleCache = new Map<string, { at: number; value: CoachStyleSignals | null }>();

  constructor(private readonly prisma: PrismaService) {}

  async build(args: { coachId: string; clientId?: string | null; now?: Date }): Promise<WorkoutContextV2> {
    const now = args.now ?? new Date();
    const [client, coach_style] = await Promise.all([args.clientId ? this.clientSignals(args.clientId, now) : null, this.coachStyle(args.coachId, now)]);
    return { client, coach_style };
  }

  private async clientSignals(clientId: string, now: Date): Promise<WorkoutClientSignals> {
    const t = now.getTime();
    const p = this.prisma;
    const [profile, intake, sessions, assignments, checkIns, wearable] = await Promise.all([
      p.userProfile.findUnique({ where: { user_id: clientId }, select: { goal_type: true, workout_experience: true, equipment_access: true, workout_days_per_week: true, injuries: true } }),
      p.clientOnboardingIntake.findUnique({ where: { client_id: clientId }, select: { screening_any_yes: true } }),
      p.workoutSession.findMany({
        where: { user_id: clientId, date: { gte: new Date(t - 42 * DAY_MS) } }, orderBy: { date: 'desc' }, take: 60,
        select: { id: true, exercises: { select: { exercise_name: true, reps_per_set: true, weight_per_set: true } } },
      }),
      p.clientWorkoutAssignment.findMany({
        where: { client_id: clientId, scheduled_for: { gte: new Date(t - 28 * DAY_MS), lte: now } }, select: { completed_at: true }, take: 200,
      }),
      p.checkIn.findMany({ where: { user_id: clientId }, orderBy: { date: 'desc' }, take: 2, select: { energy: true, soreness: true, sleep_hours: true } }),
      p.wearableConnection.findFirst({ where: { user_id: clientId, status: 'connected', disconnected_at: null }, select: { id: true } }),
    ]);
    const signals: WorkoutClientSignals = {
      goal: profile?.goal_type ?? null, experience: profile?.workout_experience ?? null,
      equipment: (profile?.equipment_access ?? []).filter((s) => ENUM_TOKEN.test(s)).slice(0, 12),
      days_per_week: profile?.workout_days_per_week ?? null, injuries: toInjuryAreas(profile?.injuries),
      screening_flag: intake?.screening_any_yes === true, history_6w: historyFromSessions(sessions),
      adherence_pct_4w: assignments.length ? pct(assignments.filter((a) => a.completed_at).length, assignments.length) : null,
      check_ins: checkIns.map((c) => ({ energy: c.energy ?? null, soreness: c.soreness ?? null, sleep_hours: c.sleep_hours ?? null })),
    };
    if (wearable) {
      const samples = await p.wearableSample.findMany({
        where: { user_id: clientId, metric: { in: ['SLEEP_TOTAL_MIN', 'SLEEP_DURATION_MIN', 'RESTING_HEART_RATE_BPM', 'HRV_MS'] }, start_at: { gte: new Date(t - 21 * DAY_MS) } },
        select: { metric: true, value: true, start_at: true }, take: 2_000,
      });
      signals.recovery = recoveryFromSamples(samples, now);
    }
    return signals;
  }

  private async coachStyle(coachId: string, now: Date): Promise<CoachStyleSignals | null> {
    const hit = this.styleCache.get(coachId);
    if (hit && now.getTime() - hit.at < STYLE_TTL_MS) return hit.value;
    const plans = await this.prisma.workoutPlan.findMany({
      where: { coach_id: coachId, archived_at: null }, orderBy: { updated_at: 'desc' }, take: 200,
      select: { exercises: { where: { archived_at: null }, select: { exercise_external_id: true, sets: true, reps_or_duration_seconds: true, rest_seconds: true, superset_group_id: true } } },
    });
    const value = coachStyleFromPlans(plans);
    this.styleCache.set(coachId, { at: now.getTime(), value });
    return value;
  }
}
