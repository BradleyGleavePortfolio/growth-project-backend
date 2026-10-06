/**
 * roman-timeline.types.ts — Roman v1.1 client timeline (slice R11-M2).
 *
 * One ordered, client-scoped view of the client's own events across existing
 * tables, for the background day summaries (R11-M3a) to walk back in time.
 * Internal only: no endpoint, no model call, no writes.
 *
 * Every event is a plain fact record with a source reference so a summary can
 * cite where each number came from. Strings are sanitised and clamped.
 *
 * Excluded by construction (never selected): other users' rows,
 * CoachingSession.coach_notes_md, WorkoutAdjustmentProposal.dismiss_reason,
 * bloodwork, purchases and payments, wearable connections and credentials,
 * email, phone, last name.
 */

export const ROMAN_TIMELINE_KINDS = [
  'food_day',
  'workout_done',
  'workout_missed',
  'weight',
  'water',
  'habit',
  'check_in',
  'wearable_day',
  'message',
  'booking',
  'adjustment',
  'activity',
] as const;
export type RomanTimelineKind = (typeof ROMAN_TIMELINE_KINDS)[number];

/** Prisma model each event was read from. */
export type RomanTimelineTable =
  | 'LoggedFoodEntry'
  | 'ClientWorkoutAssignment'
  | 'WorkoutSession'
  | 'WeightLog'
  | 'WaterLog'
  | 'HabitLog'
  | 'CheckIn'
  | 'WearableSample'
  | 'CoachMessage'
  | 'CoachingSession'
  | 'WorkoutAdjustmentProposal'
  | 'ActivityEvent';

/**
 * Where an event came from. `id` is the row id; for the two day aggregates
 * (food_day, wearable_day) it is the client's local date (YYYY-MM-DD).
 */
export interface RomanTimelineSource {
  table: RomanTimelineTable;
  id: string;
}

export type RomanTimelineFactValue = string | number | boolean | null;

export interface RomanTimelineEvent {
  /** ISO instant. Date-only rows (food, weight, check-in, habit, logged workout, wearable day) use the start of that local day. */
  at: string;
  /** The client's local date of `at` (YYYY-MM-DD). */
  local_date: string;
  kind: RomanTimelineKind;
  source: RomanTimelineSource;
  /** Numbers, codes and short labels only. */
  facts: Record<string, RomanTimelineFactValue>;
  /** Client- or coach-written words (sanitised, clamped), when the source has them. */
  text?: string;
}

export interface RomanTimelineReadOptions {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound; at most ROMAN_TIMELINE_LIMITS.max_range_days after `from`. */
  to: Date;
  /** Kinds to read; omitted or empty means every kind. */
  kinds?: readonly RomanTimelineKind[];
  /** Page size, 1..ROMAN_TIMELINE_LIMITS.max_page (default ROMAN_TIMELINE_LIMITS.default_page). */
  limit?: number;
  /** `next_cursor` from the previous page of the same query. */
  cursor?: string | null;
  /** Clock for "missed" (a planned workout whose local day has ended). Default: new Date(). */
  now?: Date;
}

export interface RomanTimelinePage {
  client_id: string;
  /** The client's timezone used for local dates. */
  timezone: string;
  /** Ascending by (at, kind, source.table, source.id). */
  events: RomanTimelineEvent[];
  /** Opaque; null when the window is exhausted. */
  next_cursor: string | null;
  /** Kinds whose source hit its read cap; this page stops before the first unread row. */
  truncated: RomanTimelineKind[];
}

export const ROMAN_TIMELINE_LIMITS = {
  default_page: 200,
  max_page: 500,
  /** One call covers at most this many days; summaries walk back in steps. */
  max_range_days: 31,
  /** Rows read per source per call (cap+1 is read to detect more). */
  rows_per_source: 1000,
  /** Wearable samples are many per day (steps, heart rate, sleep stages). */
  wearable_samples: 12000,
} as const;

/** ActivityEvent types the timeline may read (content-free: the type only). */
export const ROMAN_TIMELINE_ACTIVITY_TYPES = ['coach.message_sent'] as const;

/** Adjustment outcomes the client lived through (never pending, dismissed, expired, withdrawn). */
export const ROMAN_TIMELINE_ADJUSTMENT_STATUSES = ['approved', 'edited', 'undone'] as const;

export class RomanTimelineError extends Error {
  constructor(readonly code: 'bad_range' | 'range_too_large' | 'bad_cursor' | 'bad_kind') {
    super(`roman_timeline.${code}`);
    this.name = 'RomanTimelineError';
  }
}
