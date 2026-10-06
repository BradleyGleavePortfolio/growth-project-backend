/**
 * Roman v1.1 R11-P2: deterministic playbook signals.
 *
 * The numbers and exercises a head coach's team actually uses, computed by
 * code from the team's own rows: what it programs most, how often and in
 * which split it schedules sessions, how it decides approve-to-adjust (#655)
 * proposals, how it sets protein and calories, and how many meals a day it
 * plans. No model call, no AI egress, no writes.
 *
 * Tenancy: the team is the head coach (resolveHeadCoachId folds a sub-coach
 * into its head coach) plus the head coach's active sub-coaches. Every query
 * is filtered to rows the team authored (plan owner, assigning coach,
 * proposing coach, target setter); another coach's rows are never read.
 *
 * Output: aggregates and exercise names only (see playbook-signals.types.ts).
 * Every client-derived figure needs PLAYBOOK_SIGNALS_MIN_CLIENTS distinct
 * clients or it is omitted.
 *
 * Inert in this slice: nothing calls it. The playbook builder (R11-P3b) calls
 * it only while FEATURE_ROMAN_PLAYBOOK is on.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { computeMacros, INPUT_BOUNDS, resolveMacroInputs } from '../../macros/macro-calculator';
import {
  PLAYBOOK_SIGNALS_LIMITS as LIMITS,
  PLAYBOOK_SIGNALS_MIN_CLIENTS as MIN_CLIENTS,
  type PlaybookAdjustRuleSignal,
  type PlaybookDayType,
  type PlaybookExerciseSignal,
  type PlaybookMacroSignal,
  type PlaybookMealsSignal,
  type PlaybookScheduleSignal,
  type PlaybookSignals,
  type PlaybookSignalsOptions,
  type PlaybookSplit,
  type PlaybookSubstitutionSignal,
} from './playbook-signals.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DECIDED_STATUSES = ['approved', 'edited', 'dismissed', 'undone'] as const;

/** Catalog primary_muscle (ExerciseDB "target" vocabulary) -> movement group. */
const MUSCLE_GROUP: Readonly<Record<string, 'push' | 'pull' | 'lower'>> = Object.freeze({
  pectorals: 'push',
  chest: 'push',
  'upper chest': 'push',
  'front delts': 'push',
  'side delts': 'push',
  delts: 'push',
  shoulders: 'push',
  triceps: 'push',
  'serratus anterior': 'push',
  lats: 'pull',
  'mid back': 'pull',
  'upper back': 'pull',
  back: 'pull',
  'rear delts': 'pull',
  biceps: 'pull',
  traps: 'pull',
  forearms: 'pull',
  erectors: 'pull',
  'levator scapulae': 'pull',
  quads: 'lower',
  hamstrings: 'lower',
  glutes: 'lower',
  calves: 'lower',
  adductors: 'lower',
  abductors: 'lower',
});

// ─── pure helpers (exported for the spec) ────────────────────────────────────

export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Strength session -> day type from its exercises' primary muscles; null when none map. */
export function classifyStrengthDay(primaryMuscles: readonly string[]): PlaybookDayType | null {
  let push = 0;
  let pull = 0;
  let lower = 0;
  for (const m of primaryMuscles) {
    const g = MUSCLE_GROUP[m.trim().toLowerCase()];
    if (g === 'push') push += 1;
    else if (g === 'pull') pull += 1;
    else if (g === 'lower') lower += 1;
  }
  const total = push + pull + lower;
  if (total === 0) return null;
  if (lower / total >= 0.7) return 'lower';
  const upper = push + pull;
  if (upper / total >= 0.7) {
    if (push / upper >= 0.7) return 'push';
    if (pull / upper >= 0.7) return 'pull';
    return 'upper';
  }
  return 'full_body';
}

/** Named split from the share of strength day types (whole percent of strength sessions). */
export function splitOf(counts: Partial<Record<PlaybookDayType, number>>): PlaybookSplit {
  const strength = (['push', 'pull', 'lower', 'upper', 'full_body'] as const).reduce(
    (a, k) => a + (counts[k] ?? 0),
    0,
  );
  if (strength === 0) return 'mixed';
  const share = (k: PlaybookDayType): number => (counts[k] ?? 0) / strength;
  if (share('push') >= 0.15 && share('pull') >= 0.15 && share('lower') >= 0.15) return 'push_pull_legs';
  if (share('upper') >= 0.25 && share('lower') >= 0.25) return 'upper_lower';
  if (share('full_body') >= 0.6) return 'full_body';
  return 'mixed';
}

/** Monday-based UTC week bucket (day number of that Monday). */
function utcWeekKey(d: Date): number {
  const day = Math.floor(d.getTime() / DAY_MS);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  return day - ((day + 3) % 7);
}

function jsonObject(v: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function exercisesByOrder(v: Prisma.JsonValue | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  const list = Array.isArray(v) ? v : (jsonObject(v)?.exercises as unknown);
  if (!Array.isArray(list)) return out;
  for (const x of list) {
    const o = jsonObject(x as Prisma.JsonValue);
    const id = o?.exercise_external_id;
    const order = o?.order;
    if (typeof id !== 'string' || typeof order !== 'number' || !Number.isInteger(order)) continue;
    out.set(order, id);
  }
  return out;
}

function volumePct(v: Prisma.JsonValue | null | undefined): number | null {
  const n = jsonObject(v)?.volume_pct;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Meals per day of one legacy/AI meal plan: median meals per day, else distinct item times. */
export function mealsPerDayOfPlan(items: Prisma.JsonValue, days: Prisma.JsonValue | null): number | null {
  if (Array.isArray(days)) {
    const counts: number[] = [];
    for (const d of days) {
      const meals = jsonObject(d as Prisma.JsonValue)?.meals;
      if (Array.isArray(meals) && meals.length > 0) counts.push(meals.length);
    }
    const m = median(counts);
    if (m !== null) return m;
  }
  if (Array.isArray(items)) {
    const times = new Set<string>();
    for (const it of items) {
      const t = jsonObject(it as Prisma.JsonValue)?.time_of_day;
      if (typeof t === 'string' && t.trim()) times.add(t.trim().toLowerCase());
    }
    if (times.size > 0) return times.size;
  }
  return null;
}

function inBounds(v: number | null | undefined): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= INPUT_BOUNDS.weight_lbs.min &&
    v <= INPUT_BOUNDS.weight_lbs.max
  );
}

interface CatalogEntry {
  name: string;
  primary_muscle: string;
}

// ─── service ─────────────────────────────────────────────────────────────────

@Injectable()
export class PlaybookSignalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: CoachAIBudgetService,
  ) {}

  /** Signals for the team of `coachId` (a head coach, or a sub-coach folded into its head). */
  async compute(coachId: string, opts: PlaybookSignalsOptions = {}): Promise<PlaybookSignals> {
    const now = opts.now ?? new Date();
    const team = await this.teamOf(coachId);
    const clientFilter = opts.clientIds ? { in: [...opts.clientIds] } : undefined;

    const [planExercises, assignments, proposals, targets, dailyAssignments, mealPlans] = await Promise.all([
      this.prisma.workoutPlanExercise.findMany({
        where: { archived_at: null, workout_plan: { coach_id: { in: team }, archived_at: null } },
        select: { exercise_external_id: true },
        take: LIMITS.rowsPerSource,
      }),
      this.prisma.clientWorkoutAssignment.findMany({
        where: {
          assigned_by_coach_id: { in: team },
          scheduled_for: { gte: new Date(now.getTime() - LIMITS.scheduleDays * DAY_MS), lte: now },
          ...(clientFilter ? { client_id: clientFilter } : {}),
        },
        select: { client_id: true, scheduled_for: true, workout_plan_id: true, workout_plan: { select: { type: true } } },
        take: LIMITS.rowsPerSource,
      }),
      this.prisma.workoutAdjustmentProposal.findMany({
        where: {
          coach_id: { in: team },
          status: { in: [...DECIDED_STATUSES] },
          created_at: { gte: new Date(now.getTime() - LIMITS.adjustDays * DAY_MS) },
          ...(clientFilter ? { client_id: clientFilter } : {}),
        },
        select: {
          client_id: true,
          rule_key: true,
          status: true,
          proposed_change: true,
          applied_change: true,
          before_exercises: true,
          dismiss_reason: true,
        },
        take: LIMITS.rowsPerSource,
      }),
      this.prisma.macroTarget.findMany({
        where: {
          coach_id: { in: team },
          archived_at: null,
          effective_from: { lte: now },
          ...(clientFilter ? { client_id: clientFilter } : {}),
        },
        orderBy: [{ effective_from: 'desc' }, { created_at: 'desc' }],
        select: {
          client_id: true,
          calories_kcal: true,
          protein_g: true,
          client: {
            select: {
              profile: {
                select: {
                  current_weight_lbs: true,
                  target_weight_lbs: true,
                  height_cm: true,
                  date_of_birth: true,
                  sex: true,
                  activity_level: true,
                  goal_type: true,
                },
              },
            },
          },
        },
        take: LIMITS.rowsPerSource,
      }),
      this.prisma.dailyMealPlanAssignment.findMany({
        where: {
          assigned_by_coach_id: { in: team },
          daily_meal_plan: { coach_id: { in: team } },
          ...(clientFilter ? { client_id: clientFilter } : {}),
        },
        orderBy: { starts_on: 'desc' },
        select: { client_id: true, daily_meal_plan: { select: { _count: { select: { slots: true } } } } },
        take: LIMITS.rowsPerSource,
      }),
      this.prisma.mealPlan.findMany({
        where: { coach_id: { in: team }, archived_at: null, client_id: clientFilter ?? { not: null } },
        orderBy: { created_at: 'desc' },
        select: { client_id: true, items: true, days: true },
        take: LIMITS.rowsPerSource,
      }),
    ]);

    // Exercise ids needing a catalog row: programmed exercises, scheduled
    // sessions' exercises (for the split) and substitution pairs.
    const programmed = new Map<string, number>();
    for (const e of planExercises) programmed.set(e.exercise_external_id, (programmed.get(e.exercise_external_id) ?? 0) + 1);
    const candidates = [...programmed.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LIMITS.exerciseCandidates);

    const planIds = [...new Set(assignments.filter((a) => a.workout_plan.type === 'strength').map((a) => a.workout_plan_id))];
    const sessionExercises = planIds.length
      ? await this.prisma.workoutPlanExercise.findMany({
          where: { workout_plan_id: { in: planIds }, archived_at: null, workout_plan: { coach_id: { in: team } } },
          select: { workout_plan_id: true, exercise_external_id: true },
          take: LIMITS.rowsPerSource,
        })
      : [];

    const subPairs = this.substitutionPairs(proposals);
    const ids = new Set<string>(candidates.map(([id]) => id));
    for (const e of sessionExercises) ids.add(e.exercise_external_id);
    for (const p of subPairs.values()) {
      ids.add(p.from);
      ids.add(p.to);
    }
    const catalog = await this.catalog([...ids]);

    return {
      version: 'pbs-v1',
      team_size: team.length,
      top_exercises: this.topExercises(candidates, catalog),
      schedule: this.schedule(assignments, sessionExercises, catalog),
      adjustments: this.adjustments(proposals),
      substitutions: this.substitutions(subPairs, catalog),
      macros: this.macros(targets, now),
      meals: this.meals(dailyAssignments, mealPlans),
    };
  }

  /** Head coach + active sub-coaches, head first. */
  private async teamOf(coachId: string): Promise<string[]> {
    const head = await this.budget.resolveHeadCoachId(coachId);
    const subs = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: head, archived_at: null },
      select: { sub_coach_id: true },
    });
    return [head, ...new Set(subs.map((s) => s.sub_coach_id).filter((id) => id !== head))];
  }

  /** Catalog rows by id, slug or seed source_ref (the three forms exercise_external_id takes). */
  private async catalog(ids: string[]): Promise<Map<string, CatalogEntry>> {
    const out = new Map<string, CatalogEntry>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.exerciseCatalogItem.findMany({
      where: { OR: [{ id: { in: ids } }, { slug: { in: ids } }, { source_ref: { in: ids } }] },
      select: { id: true, slug: true, source_ref: true, name: true, primary_muscle: true },
    });
    for (const r of rows) {
      const entry = { name: r.name.trim(), primary_muscle: r.primary_muscle };
      if (!entry.name) continue;
      for (const key of [r.id, r.slug, r.source_ref]) if (key) out.set(key, entry);
    }
    return out;
  }

  private topExercises(candidates: Array<[string, number]>, catalog: Map<string, CatalogEntry>): PlaybookExerciseSignal[] {
    const byName = new Map<string, PlaybookExerciseSignal>();
    for (const [id, n] of candidates) {
      const entry = catalog.get(id);
      if (!entry) continue; // names only: an id without a library name is left out
      const key = entry.name.toLowerCase();
      const cur = byName.get(key);
      if (cur) cur.times_programmed += n;
      else byName.set(key, { name: entry.name, times_programmed: n });
    }
    return [...byName.values()]
      .sort((a, b) => b.times_programmed - a.times_programmed || a.name.localeCompare(b.name))
      .slice(0, LIMITS.topExercises);
  }

  private schedule(
    assignments: Array<{ client_id: string; scheduled_for: Date; workout_plan_id: string; workout_plan: { type: string } }>,
    sessionExercises: Array<{ workout_plan_id: string; exercise_external_id: string }>,
    catalog: Map<string, CatalogEntry>,
  ): PlaybookScheduleSignal | null {
    const perClient = new Map<string, { sessions: number; weeks: Set<number> }>();
    for (const a of assignments) {
      const c = perClient.get(a.client_id) ?? { sessions: 0, weeks: new Set<number>() };
      c.sessions += 1;
      c.weeks.add(utcWeekKey(a.scheduled_for));
      perClient.set(a.client_id, c);
    }
    if (perClient.size < MIN_CLIENTS) return null;
    const perWeek = median([...perClient.values()].map((c) => c.sessions / c.weeks.size));
    if (perWeek === null) return null;

    const musclesByPlan = new Map<string, string[]>();
    for (const e of sessionExercises) {
      const m = catalog.get(e.exercise_external_id)?.primary_muscle;
      if (!m) continue;
      const list = musclesByPlan.get(e.workout_plan_id) ?? [];
      list.push(m);
      musclesByPlan.set(e.workout_plan_id, list);
    }
    const counts: Partial<Record<PlaybookDayType, number>> = {};
    let classified = 0;
    for (const a of assignments) {
      const t: PlaybookDayType | null =
        a.workout_plan.type === 'strength'
          ? classifyStrengthDay(musclesByPlan.get(a.workout_plan_id) ?? [])
          : 'conditioning';
      if (!t) continue;
      counts[t] = (counts[t] ?? 0) + 1;
      classified += 1;
    }
    const day_type_pct: Partial<Record<PlaybookDayType, number>> = {};
    for (const [k, n] of Object.entries(counts) as Array<[PlaybookDayType, number]>) {
      day_type_pct[k] = Math.round((n / classified) * 100);
    }
    return { sessions_per_week_median: round(perWeek, 1), day_type_pct, split: splitOf(counts), clients: perClient.size };
  }

  private adjustments(
    proposals: Array<{ client_id: string; rule_key: string; status: string; proposed_change: Prisma.JsonValue; applied_change: Prisma.JsonValue | null; dismiss_reason: string | null }>,
  ): PlaybookAdjustRuleSignal[] {
    const byRule = new Map<string, typeof proposals>();
    for (const p of proposals) {
      const list = byRule.get(p.rule_key) ?? [];
      list.push(p);
      byRule.set(p.rule_key, list);
    }
    const out: PlaybookAdjustRuleSignal[] = [];
    for (const [rule_key, rows] of byRule) {
      const clients = new Set(rows.map((r) => r.client_id)).size;
      if (clients < MIN_CLIENTS) continue;
      const count = (s: string): number => rows.filter((r) => r.status === s).length;
      const deltas: number[] = [];
      const dismiss_reasons: Record<string, number> = {};
      for (const r of rows) {
        if (r.status === 'edited') {
          const a = volumePct(r.applied_change);
          const p = volumePct(r.proposed_change);
          if (a !== null && p !== null) deltas.push(a - p);
        }
        if (r.status === 'dismissed') {
          const reason = r.dismiss_reason ?? 'none';
          dismiss_reasons[reason] = (dismiss_reasons[reason] ?? 0) + 1;
        }
      }
      const delta = median(deltas);
      out.push({
        rule_key,
        decided: rows.length,
        approved_unedited: count('approved'),
        edited: count('edited'),
        dismissed: count('dismissed'),
        undone: count('undone'),
        unedited_approval_pct: Math.round((count('approved') / rows.length) * 100),
        edit_volume_delta_median_pp: delta === null ? null : round(delta, 1),
        dismiss_reasons,
        clients,
      });
    }
    return out.sort((a, b) => a.rule_key.localeCompare(b.rule_key));
  }

  /** (before exercise, applied exercise) pairs at the same slot of an applied proposal. */
  private substitutionPairs(
    proposals: Array<{ client_id: string; status: string; applied_change: Prisma.JsonValue | null; before_exercises: Prisma.JsonValue | null }>,
  ): Map<string, { from: string; to: string; times: number; clients: Set<string> }> {
    const pairs = new Map<string, { from: string; to: string; times: number; clients: Set<string> }>();
    for (const p of proposals) {
      if (p.status !== 'approved' && p.status !== 'edited') continue;
      const before = exercisesByOrder(p.before_exercises);
      for (const [order, to] of exercisesByOrder(p.applied_change)) {
        const from = before.get(order);
        if (!from || from === to) continue;
        const key = `${from}\u0000${to}`;
        const cur = pairs.get(key) ?? { from, to, times: 0, clients: new Set<string>() };
        cur.times += 1;
        cur.clients.add(p.client_id);
        pairs.set(key, cur);
      }
    }
    return pairs;
  }

  private substitutions(
    pairs: Map<string, { from: string; to: string; times: number; clients: Set<string> }>,
    catalog: Map<string, CatalogEntry>,
  ): PlaybookSubstitutionSignal[] {
    const out: PlaybookSubstitutionSignal[] = [];
    for (const p of pairs.values()) {
      if (p.clients.size < MIN_CLIENTS) continue;
      const from = catalog.get(p.from)?.name;
      const to = catalog.get(p.to)?.name;
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
      out.push({ from, to, times: p.times });
    }
    return out
      .sort((a, b) => b.times - a.times || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .slice(0, LIMITS.substitutions);
  }

  private macros(
    targets: Array<{
      client_id: string;
      calories_kcal: number;
      protein_g: number;
      client: {
        profile: {
          current_weight_lbs: number | null;
          target_weight_lbs: number | null;
          height_cm: number | null;
          date_of_birth: Date | null;
          sex: string;
          activity_level: string;
          goal_type: string;
        } | null;
      };
    }>,
    now: Date,
  ): PlaybookMacroSignal | null {
    // Rows arrive newest first: the first row per client is the live target.
    const latest = new Map<string, (typeof targets)[number]>();
    for (const t of targets) if (!latest.has(t.client_id)) latest.set(t.client_id, t);
    if (latest.size < MIN_CLIENTS) return null;

    const proteinPerLb: number[] = [];
    const deficit: number[] = [];
    const surplus: number[] = [];
    for (const t of latest.values()) {
      const p = t.client.profile;
      if (!p) continue;
      const basis = inBounds(p.target_weight_lbs) ? p.target_weight_lbs : inBounds(p.current_weight_lbs) ? p.current_weight_lbs : null;
      if (basis !== null && t.protein_g > 0) proteinPerLb.push(t.protein_g / basis);
      const resolved = resolveMacroInputs(p, now);
      if (!resolved.ok || t.calories_kcal <= 0) continue;
      const tdee = computeMacros(resolved.inputs).tdee;
      if (tdee <= 0) continue;
      if (resolved.inputs.goal === 'fat_loss') deficit.push(((tdee - t.calories_kcal) / tdee) * 100);
      if (resolved.inputs.goal === 'muscle_gain') surplus.push(((t.calories_kcal - tdee) / tdee) * 100);
    }
    const kMedian = (xs: number[], digits: number): number | null => {
      if (xs.length < MIN_CLIENTS) return null;
      const m = median(xs);
      return m === null ? null : round(m, digits);
    };
    const out: PlaybookMacroSignal = {
      protein_g_per_lb_median: kMedian(proteinPerLb, 2),
      deficit_pct_median: kMedian(deficit, 0),
      surplus_pct_median: kMedian(surplus, 0),
      clients: latest.size,
    };
    if (out.protein_g_per_lb_median === null && out.deficit_pct_median === null && out.surplus_pct_median === null) {
      return null;
    }
    return out;
  }

  private meals(
    daily: Array<{ client_id: string; daily_meal_plan: { _count: { slots: number } } }>,
    plans: Array<{ client_id: string | null; items: Prisma.JsonValue; days: Prisma.JsonValue | null }>,
  ): PlaybookMealsSignal | null {
    // Newest first: a client's latest structured day plan wins, else its latest meal plan.
    const perClient = new Map<string, number>();
    for (const d of daily) {
      if (perClient.has(d.client_id) || d.daily_meal_plan._count.slots <= 0) continue;
      perClient.set(d.client_id, d.daily_meal_plan._count.slots);
    }
    for (const p of plans) {
      if (!p.client_id || perClient.has(p.client_id)) continue;
      const n = mealsPerDayOfPlan(p.items, p.days);
      if (n !== null) perClient.set(p.client_id, n);
    }
    if (perClient.size < MIN_CLIENTS) return null;
    const m = median([...perClient.values()]);
    return m === null ? null : { meals_per_day_median: round(m, 1), clients: perClient.size };
  }
}
