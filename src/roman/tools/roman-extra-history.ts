/**
 * read_history extra kinds (R11-T1b, owner 10:18 10-07: "Roman needs all ... data they ever produce or
 * bring in"). Client-owned sources the timeline reader does not cover, read for `callerId` only:
 * - health_day: every connected-device metric (Apple Health, Health Connect, wearables, scales) that
 *   wearable_day does not already carry: sleep stages, bedtime and wake time, body weight and body fat,
 *   blood pressure, VO2 max, workout minutes and distance, load, strain, body battery, temperature,
 *   respiratory rate, SpO2. Daily values per the ingest aggregation (METRIC_AGGREGATION) and the same
 *   provider choice as wearable_day (selectWearableProviders). Never the raw heart-rate stream.
 * - fasting: FastingWindow rows. roman_chat: the caller's own client-surface Roman messages in chats
 *   they have not deleted.
 * Numbers are computed here; strings are sanitised and clamped.
 */

import { PrismaService } from '../../prisma.service';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { localClock, localDateOf, selectWearableProviders } from '../context/roman-client-context.service';
import { METRIC_AGGREGATION } from '../../wearables/samples/metric-bucket.map';

export const ROMAN_EXTRA_HISTORY_KINDS = ['health_day', 'fasting', 'roman_chat'] as const;
export type RomanExtraHistoryKind = (typeof ROMAN_EXTRA_HISTORY_KINDS)[number];

/** Metric -> output key. wearable_day already has steps, active kcal, resting HR, HRV, sleep total, efficiency, recovery, readiness. */
const HEALTH_KEYS = {
  SLEEP_REM_MIN: 'sleep_rem_min',
  SLEEP_DEEP_MIN: 'sleep_deep_min',
  SLEEP_LIGHT_MIN: 'sleep_light_min',
  SLEEP_AWAKE_MIN: 'sleep_awake_min',
  SLEEP_ONSET_ISO: 'bedtime',
  SLEEP_WAKE_ISO: 'wake_time',
  BODY_WEIGHT_KG: 'body_weight_kg',
  BODY_FAT_PCT: 'body_fat_pct',
  BLOOD_PRESSURE_SYS: 'bp_systolic',
  BLOOD_PRESSURE_DIA: 'bp_diastolic',
  VO2_MAX: 'vo2_max',
  WORKOUT_DURATION_MIN: 'workout_min',
  WORKOUT_DISTANCE_M: 'workout_distance_km',
  TRAINING_LOAD: 'training_load',
  STRAIN_SCORE: 'strain',
  BODY_BATTERY: 'body_battery',
  BODY_TEMP_DEVIATION_C: 'temp_deviation_c',
  RESPIRATORY_RATE_BRPM: 'respiratory_rate',
  SPO2_PCT: 'spo2_pct',
} as const;
type HealthMetric = keyof typeof HEALTH_KEYS;
const HEALTH_METRICS = Object.keys(HEALTH_KEYS) as HealthMetric[];

const CAP = 1000;
const SAMPLE_CAP = 12_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (s: string | null | undefined, max: number): string | null =>
  (s && sanitizePromptInput(s, max).trim()) || null;

export type ExtraEvent = Record<string, unknown>;
export interface ExtraWindow {
  from: Date;
  to: Date;
  firstDay: string;
  lastDay: string;
  tz: string;
}

/** Bedtime / wake time are minutes after local midnight. */
const clockOf = (minutes: number): string => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function healthValue(metric: HealthMetric, v: number): number | string {
  if (metric === 'SLEEP_ONSET_ISO' || metric === 'SLEEP_WAKE_ISO') return clockOf(v);
  if (metric === 'WORKOUT_DISTANCE_M') return Math.round(v / 10) / 100;
  if (metric.endsWith('_MIN')) return Math.round(v);
  return round1(v);
}

export class RomanExtraHistory {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    callerId: string,
    w: ExtraWindow,
    kinds: ReadonlySet<string>,
  ): Promise<{ events: ExtraEvent[]; capped: boolean }> {
    const parts = await Promise.all([
      kinds.has('health_day') ? this.health(callerId, w) : null,
      kinds.has('fasting') ? this.fasting(callerId, w) : null,
      kinds.has('roman_chat') ? this.chats(callerId, w) : null,
    ]);
    const events = parts.flatMap((p) => p?.events ?? []);
    return { events, capped: parts.some((p) => p?.capped) };
  }

  private async health(callerId: string, w: ExtraWindow) {
    const [rows, prefs] = await Promise.all([
      this.prisma.wearableSample.findMany({
        // One extra day before: sleep belongs to the day it ends.
        where: {
          user_id: callerId,
          metric: { in: HEALTH_METRICS },
          start_at: { gte: new Date(w.from.getTime() - 86_400_000), lt: w.to },
        },
        orderBy: { start_at: 'asc' },
        take: SAMPLE_CAP + 1,
        select: { metric: true, provider: true, value: true, start_at: true, end_at: true, recorded_at: true, source_tz: true },
      }),
      this.prisma.wearableUserMetricPreference.findMany({
        where: { user_id: callerId, metric: { in: HEALTH_METRICS } },
        select: { metric: true, preferred_provider: true },
      }),
    ]);
    const dayOf = localDateOf(w.tz);
    const capped = rows.length > SAMPLE_CAP;
    // A capped read stops before the first local day it may not have read completely.
    const horizon = capped ? dayOf(rows[SAMPLE_CAP].start_at) : null;
    const samples = rows.slice(0, SAMPLE_CAP);
    const chosen = selectWearableProviders(samples, prefs);
    type Acc = { sum: number; n: number; max: number; last: number; lastAt: number };
    const days = new Map<string, Map<HealthMetric, Acc>>();
    for (const s of samples) {
      const metric = String(s.metric) as HealthMetric;
      if (!(metric in HEALTH_KEYS) || chosen.get(metric) !== String(s.provider)) continue;
      if (!Number.isFinite(s.value)) continue;
      const day = dayOf(metric.startsWith('SLEEP_') ? s.end_at : s.start_at);
      if (day < w.firstDay || day > w.lastDay || (horizon !== null && day >= horizon)) continue;
      const byMetric = days.get(day) ?? new Map<HealthMetric, Acc>();
      const a = byMetric.get(metric) ?? { sum: 0, n: 0, max: -Infinity, last: 0, lastAt: -Infinity };
      a.sum += s.value;
      a.n += 1;
      a.max = Math.max(a.max, s.value);
      if (s.end_at.getTime() >= a.lastAt) {
        a.last = s.value;
        a.lastAt = s.end_at.getTime();
      }
      byMetric.set(metric, a);
      days.set(day, byMetric);
    }
    const events: ExtraEvent[] = [...days.entries()].map(([day, byMetric]) => {
      const event: Record<string, unknown> = { date: day, kind: 'health_day' };
      for (const [metric, a] of byMetric) {
        const how = METRIC_AGGREGATION[metric];
        const v = how === 'sum' ? a.sum : how === 'avg' ? a.sum / a.n : how === 'max' ? a.max : a.last;
        event[HEALTH_KEYS[metric]] = healthValue(metric, v);
        if (metric === 'BODY_WEIGHT_KG') event.body_weight_lbs = round1(a.last * 2.20462);
      }
      return event;
    });
    return { events, capped };
  }

  private async fasting(callerId: string, w: ExtraWindow) {
    const rows = await this.prisma.fastingWindow.findMany({
      where: { user_id: callerId, start_time: { gte: w.from, lt: w.to } },
      orderBy: { start_time: 'asc' },
      take: CAP + 1,
      select: { start_time: true, end_time: true, protocol: true, notes: true },
    });
    const events = rows.slice(0, CAP).map((r) => {
      const c = localClock(r.start_time, w.tz);
      const hours = r.end_time ? round1((r.end_time.getTime() - r.start_time.getTime()) / 3_600_000) : null;
      const event: Record<string, unknown> = { date: c.local_date, time: c.local_time, kind: 'fasting' };
      if (hours !== null) event.hours = hours;
      event.ended = r.end_time !== null;
      const protocol = clamp(r.protocol, 40);
      const text = clamp(r.notes, 300);
      if (protocol) event.protocol = protocol;
      if (text) event.text = text;
      return event;
    });
    return { events, capped: rows.length > CAP };
  }

  private async chats(callerId: string, w: ExtraWindow) {
    const rows = await this.prisma.romanMessage.findMany({
      where: {
        user_id: callerId,
        interrupted: false,
        created_at: { gte: w.from, lt: w.to },
        session: { user_id: callerId, surface: 'client', deleted_at: null },
      },
      orderBy: { created_at: 'asc' },
      take: CAP + 1,
      select: { created_at: true, role: true, content: true },
    });
    const events: ExtraEvent[] = [];
    for (const r of rows.slice(0, CAP)) {
      const text = clamp(r.content, 300);
      if (!text) continue;
      const c = localClock(r.created_at, w.tz);
      const from = r.role === 'user' ? 'client' : 'roman';
      events.push({ date: c.local_date, time: c.local_time, kind: 'roman_chat', from, text });
    }
    return { events, capped: rows.length > CAP };
  }
}
