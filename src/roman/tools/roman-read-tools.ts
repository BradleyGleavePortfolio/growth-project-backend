/**
 * RomanReadToolbox (R11-T1): the pinned RomanToolbox (roman-tool.types.ts).
 * Inert on main: the only caller is the R11-T2B loop (FEATURE_ROMAN_TOOLS).
 *
 * TENANCY AND PII (T4): only a 'student' caller runs a tool (else
 * not_allowed); the subject is `caller.id` only. Inputs are strict zod
 * objects, so a `user_id` (any unknown key) is bad_input before a query.
 * read_history goes through RomanTimelineReader (its tenancy and
 * never-selected rules) for ROMAN_READ_TIMELINE_KINDS only, never 'activity'
 * or 'adjustment'; its extra kinds (roman-extra-history.ts), exercise_history
 * and food_day filter on caller.id.
 * Results: compact JSON <= max_result_chars with `truncated`; numbers computed
 * in code; `facts` = past-day intake and active kcal shown, for the post-check.
 */

import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { addDays, dateOnly, localClock } from '../context/roman-client-context.service';
import { localDayStart } from '../context/roman-client-context.service';
import { RomanTimelineReader } from '../memory/roman-timeline.reader';
import { RomanTimelineError, type RomanTimelineEvent } from '../memory/roman-timeline.types';
import type { RomanTimelineKind } from '../memory/roman-timeline.types';
import { romanErrorTag } from '../roman-error-tag';
import { ROMAN_TOOL_LIMITS, type RomanToolbox, type RomanToolCaller } from './roman-tool.types';
import type { RomanToolDefinition, RomanToolFacts, RomanToolResult } from './roman-tool.types';
import { EXERCISE_HISTORY_LIMITS, exerciseChanges } from './roman-exercise-history';
import { readExerciseSets, summarizeExerciseSet } from './roman-exercise-history';
import { ROMAN_EXTRA_HISTORY_KINDS, RomanExtraHistory } from './roman-extra-history';

const DEFAULT_TZ = 'America/Los_Angeles';
const DAY_MS = 86_400_000;
const HISTORY_MAX_DAYS = 31;
const FOOD_MAX_AGE_DAYS = 365;
const FOOD_MAX_ENTRIES = 200;

/** Timeline kinds the tools may read: never 'activity' or 'adjustment'. */
export const ROMAN_READ_TIMELINE_KINDS = ['food_day', 'workout_done', 'workout_missed', 'weight',
  'water', 'habit', 'check_in', 'wearable_day', 'message', 'booking',
] as const satisfies readonly RomanTimelineKind[];
export const ROMAN_READ_HISTORY_KINDS = [...ROMAN_READ_TIMELINE_KINDS, ...ROMAN_EXTRA_HISTORY_KINDS] as const;
const TIMELINE_KINDS = new Set<string>(ROMAN_READ_TIMELINE_KINDS);

const realDay = (s: string) => {
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(s);
};
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDay);
const kindList = z.array(z.enum(ROMAN_READ_HISTORY_KINDS)).min(1).max(20);
// Letters, digits and plain punctuation: no LIKE wildcards or escapes.
const exerciseName = z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N} .,'()&+/-]+$/u);
const SCHEMAS = {
  read_history: z.strictObject({ kinds: kindList.optional(), from: ymd, to: ymd }),
  exercise_history: z.strictObject({ exercise: exerciseName, from: ymd.optional(), to: ymd.optional() }),
  food_day: z.strictObject({ date: ymd }),
};
type Input<K extends keyof typeof SCHEMAS> = z.infer<(typeof SCHEMAS)[K]>;

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
export const ROMAN_READ_TOOL_DEFINITIONS: readonly RomanToolDefinition[] = Object.freeze([
  {
    name: 'read_history',
    description:
      "The client's own logs between two dates in their time zone (inclusive, at most 31 days): daily food totals, workouts done and missed, weight, water, habits, check-ins, daily wearable totals, messages with their coach and coaching sessions; health_day is the rest of their connected-device data per day (sleep stages, bedtime and wake time, body weight and body fat, blood pressure, VO2 max, workout minutes and distance, strain, temperature, respiratory rate, SpO2); fasting windows; roman_chat is their own earlier chats with Roman. Numbers are computed by the app; quote them as given.",
    input_schema: {
      type: 'object',
      properties: { kinds: { type: 'array', items: { enum: [...ROMAN_READ_HISTORY_KINDS] } }, from: DAY, to: DAY },
      required: ['from', 'to'],
    },
  },
  {
    name: 'exercise_history',
    description:
      "The client's own logged sets for one exercise (name contains, any case): per session the date, sets, reps, weights in lb, RPE, top set, estimated 1RM (Epley) and volume, and the first-vs-last change per exercise, computed by the app. Default window the last 90 days, at most 180.",
    input_schema: {
      type: 'object',
      properties: { exercise: { type: 'string', minLength: 2, maxLength: 60 }, from: DAY, to: DAY },
      required: ['exercise'],
    },
  },
  {
    name: 'food_day',
    description:
      "Everything the client logged as food on one date within the last 365 days: each entry's kcal and macros and the day totals, computed the same way as client_data.",
    input_schema: { type: 'object', properties: { date: DAY }, required: ['date'] },
  },
]);

type ErrorCode = NonNullable<RomanToolResult['error_code']>;
export const toolFailure = (code: ErrorCode, detail: string): RomanToolResult => {
  const content = JSON.stringify({ error: code, detail });
  return { ok: false, content, rows: 0, truncated: false, error_code: code };
};

/** `head`, then as many `items` as fit under `max` characters, then `truncated`. */
export function fitToolJson(
  head: Record<string, unknown>,
  key: string,
  items: readonly unknown[],
  capped: boolean,
  max: number = ROMAN_TOOL_LIMITS.max_result_chars,
): { content: string; kept: number; truncated: boolean } {
  let used = JSON.stringify({ ...head, [key]: [], truncated: false }).length;
  let kept = 0;
  for (const item of items) {
    const add = JSON.stringify(item).length + (kept > 0 ? 1 : 0);
    if (used + add > max) break;
    used += add;
    kept += 1;
  }
  const truncated = capped || kept < items.length;
  const content = JSON.stringify({ ...head, [key]: items.slice(0, kept), truncated });
  if (content.length <= max) return { content, kept, truncated };
  return { content: JSON.stringify({ [key]: [], truncated: true }), kept: 0, truncated: true };
}

const okResult = (fit: ReturnType<typeof fitToolJson>, facts?: RomanToolFacts): RomanToolResult => ({
  ok: true,
  content: fit.content,
  rows: fit.kept,
  truncated: fit.truncated,
  ...(facts ? { facts } : {}),
});

export interface FoodEntryRow {
  meal_type: string | null;
  quantity_multiplier: number;
  logged_at: Date;
  food_item: { name: string; calories: number; protein_g: number; carbs_g: number; fat_g: number };
}

/**
 * client_data's food math (roman-client-context.service.ts:759-795): an entry
 * is round(value * quantity_multiplier); a day total sums the unrounded
 * products and rounds once, so the totals equal client_data's for that day.
 */
export function foodDayOf(rows: readonly FoodEntryRow[], tz: string) {
  const sum = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const meals = new Set<string>();
  const entries = rows.map((e) => {
    const q = e.quantity_multiplier;
    const f = e.food_item;
    sum.kcal += f.calories * q;
    sum.protein_g += f.protein_g * q;
    sum.carbs_g += f.carbs_g * q;
    sum.fat_g += f.fat_g * q;
    const meal = String(e.meal_type ?? 'meal').toLowerCase();
    meals.add(meal);
    return {
      time: localClock(e.logged_at, tz).local_time,
      meal,
      name: sanitizePromptInput(f.name, 60).trim() || 'Food',
      kcal: Math.round(f.calories * q),
      protein_g: Math.round(f.protein_g * q),
      carbs_g: Math.round(f.carbs_g * q),
      fat_g: Math.round(f.fat_g * q),
    };
  });
  const r = Math.round;
  const totals = { kcal: r(sum.kcal), protein_g: r(sum.protein_g), carbs_g: r(sum.carbs_g) };
  return { totals: { ...totals, fat_g: r(sum.fat_g), entries: rows.length, meals: meals.size }, entries };
}

const days = (a: string, b: string) => Math.round((+dateOnly(b) - +dateOnly(a)) / DAY_MS) + 1;
const INSTANT_TABLES = new Set(['WaterLog', 'CoachMessage', 'CoachingSession', 'ClientWorkoutAssignment']);

function compactEvent(e: RomanTimelineEvent, tz: string): Record<string, unknown> {
  const out: Record<string, unknown> = { date: e.local_date };
  if (INSTANT_TABLES.has(e.source.table)) out.time = localClock(new Date(e.at), tz).local_time;
  out.kind = e.kind;
  for (const [k, v] of Object.entries(e.facts)) if (v !== null && !(k in out)) out[k] = v;
  if (e.text) out.text = e.text;
  return out;
}

const NOT_A_CLIENT = 'These tools read a client their own logs only.';

@Injectable()
export class RomanReadToolbox implements RomanToolbox {
  private readonly logger = new Logger(RomanReadToolbox.name);

  private readonly extra: RomanExtraHistory;

  constructor(private readonly prisma: PrismaService, private readonly timeline: RomanTimelineReader) {
    this.extra = new RomanExtraHistory(prisma);
  }

  definitions(): readonly RomanToolDefinition[] {
    return ROMAN_READ_TOOL_DEFINITIONS;
  }

  async run(caller: RomanToolCaller, name: string, input: unknown, opts: { readonly now: Date }): Promise<RomanToolResult> {
    if (caller.role !== 'student' || !caller.id) return toolFailure('not_allowed', NOT_A_CLIENT);
    type Run<S extends z.ZodType> = (at: At, data: z.output<S>) => Promise<RomanToolResult>;
    const call = async <S extends z.ZodType>(schema: S, fn: Run<S>): Promise<RomanToolResult> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        // Content-free: path and issue code, never the received value.
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.code}`)
          .join('; ');
        return toolFailure('bad_input', detail);
      }
      const user = await this.prisma.user.findUnique({
        where: { id: caller.id },
        select: { deleted_at: true, notification_prefs: { select: { timezone: true } } },
      });
      if (!user || user.deleted_at) return toolFailure('not_allowed', NOT_A_CLIENT);
      const clock = localClock(opts.now, user.notification_prefs?.timezone ?? DEFAULT_TZ);
      const at = { id: caller.id, tz: clock.timezone, today: clock.local_date, now: opts.now };
      return fn(at, parsed.data);
    };
    try {
      switch (name) {
        case 'read_history':
          return await call(SCHEMAS.read_history, (at, d) => this.readHistory(at, d));
        case 'exercise_history':
          return await call(SCHEMAS.exercise_history, (at, d) => this.exerciseHistory(at, d));
        case 'food_day':
          return await call(SCHEMAS.food_day, (at, d) => this.foodDay(at, d));
        default:
          return toolFailure('bad_input', 'unknown tool');
      }
    } catch (err) {
      if (err instanceof RomanTimelineError && err.code === 'range_too_large') {
        return toolFailure('range_too_large', 'Ask for 31 days or fewer.');
      }
      this.logger.warn(`roman.tool_failed tool=${name.slice(0, 40)} err=${romanErrorTag(err)}`);
      return toolFailure('unavailable', 'That data could not be read right now.');
    }
  }

  private async readHistory(at: At, input: Input<'read_history'>): Promise<RomanToolResult> {
    const n = days(input.from, input.to);
    if (n < 1) return toolFailure('bad_input', 'from must be on or before to.');
    if (n > HISTORY_MAX_DAYS) return toolFailure('range_too_large', 'Ask for 31 days or fewer.');
    const asked = new Set<string>(input.kinds ?? ROMAN_READ_HISTORY_KINDS);
    const kinds = ROMAN_READ_TIMELINE_KINDS.filter((k) => asked.has(k));
    const from = localDayStart(input.from, at.tz);
    // A daylight-saving change can make 31 local days an hour longer than the reader's cap.
    const end = Math.min(
      localDayStart(addDays(input.to, 1), at.tz).getTime(),
      from.getTime() + HISTORY_MAX_DAYS * DAY_MS,
    );
    const window = { from, to: new Date(end), kinds, limit: 500, now: at.now };
    // Never an empty kinds list: the reader reads every kind (activity, adjustment) when none is given.
    const [page, extra] = await Promise.all([
      kinds.length > 0 ? this.timeline.read(at.id, window) : null,
      this.extra.read(at.id, { from, to: window.to, firstDay: input.from, lastDay: input.to, tz: at.tz }, asked),
    ]);
    const events = (page?.events ?? []).filter((e) => TIMELINE_KINDS.has(e.kind) && asked.has(e.kind));
    const rows = [
      ...events.map((e) => ({ out: compactEvent(e, at.tz), src: e })),
      ...extra.events.map((out) => ({ out, src: null })),
    ];
    const key = (o: Record<string, unknown>) => `${String(o.date)} ${typeof o.time === 'string' ? o.time : ''}`;
    rows.sort((a, b) => (key(a.out) < key(b.out) ? -1 : key(a.out) > key(b.out) ? 1 : 0));
    const fit = fitToolJson(
      { tool: 'read_history', from: input.from, to: input.to, timezone: at.tz },
      'events',
      rows.map((r) => r.out),
      (page !== null && (page.next_cursor !== null || page.truncated.length > 0)) || extra.capped,
    );
    const past = rows
      .slice(0, fit.kept)
      .flatMap((r) => (r.src && r.src.local_date < at.today ? [r.src] : []));
    const pick = (kind: RomanTimelineKind, key: string): number[] =>
      past
        .filter((e) => e.kind === kind)
        .map((e) => e.facts[key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const facts = { intake_past_kcal: pick('food_day', 'kcal') };
    return okResult(fit, { ...facts, burned_past_kcal: pick('wearable_day', 'active_kcal') });
  }

  private async exerciseHistory(at: At, input: Input<'exercise_history'>): Promise<RomanToolResult> {
    const to = input.to ?? at.today;
    const from = input.from ?? addDays(to, 1 - EXERCISE_HISTORY_LIMITS.default_days);
    const n = days(from, to);
    if (n < 1) return toolFailure('bad_input', 'from must be on or before to.');
    if (n > EXERCISE_HISTORY_LIMITS.max_days) {
      return toolFailure('range_too_large', 'Ask for 180 days or fewer.');
    }
    const rows = await readExerciseSets(this.prisma, at.id, { exercise: input.exercise, from, to });
    // Newest first, so a clamp drops the oldest sessions.
    const sessions = rows.slice(0, EXERCISE_HISTORY_LIMITS.max_sessions).map(summarizeExerciseSet);
    const changes = exerciseChanges([...sessions].reverse());
    const head = { tool: 'exercise_history', exercise: input.exercise, from, to, unit: 'lb', changes };
    const capped = rows.length > EXERCISE_HISTORY_LIMITS.max_sessions;
    return okResult(fitToolJson(head, 'sessions', sessions, capped));
  }

  private async foodDay(at: At, input: Input<'food_day'>): Promise<RomanToolResult> {
    if (input.date > at.today) return toolFailure('bad_input', 'That date is in the future.');
    if (input.date < addDays(at.today, -FOOD_MAX_AGE_DAYS)) {
      return toolFailure('range_too_large', 'Ask for a date within the last 365 days.');
    }
    const rows = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: at.id, date: dateOnly(input.date) },
      orderBy: { logged_at: 'asc' },
      take: FOOD_MAX_ENTRIES + 1,
      select: { meal_type: true, quantity_multiplier: true, logged_at: true,
        food_item: { select: { name: true, calories: true, protein_g: true, carbs_g: true, fat_g: true } } },
    });
    const day = foodDayOf(rows.slice(0, FOOD_MAX_ENTRIES), at.tz);
    const head = { tool: 'food_day', date: input.date, totals: day.totals };
    const fit = fitToolJson(head, 'entries', day.entries, rows.length > FOOD_MAX_ENTRIES);
    // Today's numbers are already in client_data; only an earlier day is a past-day fact.
    const shown = day.entries.slice(0, fit.kept).map((e) => e.kcal);
    const past = input.date < at.today && rows.length > 0;
    return okResult(fit, { intake_past_kcal: past ? [day.totals.kcal, ...shown] : [] });
  }
}

interface At { id: string; tz: string; today: string; now: Date }
