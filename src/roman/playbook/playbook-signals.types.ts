/**
 * Roman v1.1 R11-P2: deterministic playbook signals (types and constants).
 *
 * What a head coach's team (the head coach plus its active sub-coaches)
 * actually programs, computed by code from the team's own rows. No model
 * call and no AI egress happen here; the playbook builder (R11-P3b) is the
 * only consumer and decides what, if anything, leaves the server.
 *
 * Privacy contract of the output (pinned by test/roman/r11-playbook-signals.spec.ts):
 * - aggregates and exercise names only: never a client id, a client or coach
 *   name, a plan title, free text, or a date;
 * - every figure derived from clients' rows needs at least
 *   PLAYBOOK_SIGNALS_MIN_CLIENTS distinct clients behind it, or it is omitted
 *   (null / left out of its list).
 */

/** k-anonymity floor for any figure derived from clients' rows. */
export const PLAYBOOK_SIGNALS_MIN_CLIENTS = 3;

export const PLAYBOOK_SIGNALS_LIMITS = Object.freeze({
  /** Exercises reported, most programmed first. */
  topExercises: 20,
  /** Catalog lookups per run (candidates before the name merge). */
  exerciseCandidates: 60,
  /** Window for sessions per week and the split (ClientWorkoutAssignment.scheduled_for). */
  scheduleDays: 90,
  /** Window for approve-to-adjust decisions (WorkoutAdjustmentProposal.created_at). */
  adjustDays: 180,
  /** Substitution pairs reported. */
  substitutions: 12,
  /** Upper bound of rows read per source (launch volume is far below it). */
  rowsPerSource: 5000,
});

/** Day classification of one strength session from its exercises' primary muscles. */
export type PlaybookDayType = 'push' | 'pull' | 'lower' | 'upper' | 'full_body' | 'conditioning';

export type PlaybookSplit = 'push_pull_legs' | 'upper_lower' | 'full_body' | 'mixed';

export interface PlaybookExerciseSignal {
  /** Display name from the exercise library. */
  name: string;
  /** Times the team has programmed it across its live plans. */
  times_programmed: number;
}

export interface PlaybookScheduleSignal {
  /** Median, across clients, of scheduled sessions per active week (one decimal). */
  sessions_per_week_median: number;
  /** Share of sessions per day type, in whole percent (sums to about 100). */
  day_type_pct: Partial<Record<PlaybookDayType, number>>;
  split: PlaybookSplit;
  clients: number;
}

export interface PlaybookAdjustRuleSignal {
  rule_key: string;
  decided: number;
  approved_unedited: number;
  edited: number;
  dismissed: number;
  undone: number;
  /** approved_unedited / decided, whole percent. */
  unedited_approval_pct: number;
  /** Median of (coach's applied cut - proposed cut) in percentage points, edits only; null without edits. */
  edit_volume_delta_median_pp: number | null;
  /** Dismiss reasons as counts (closed list from roman-adjust.constants). */
  dismiss_reasons: Record<string, number>;
  clients: number;
}

export interface PlaybookSubstitutionSignal {
  /** Exercise the proposal had. */
  from: string;
  /** Exercise the coach applied instead. */
  to: string;
  times: number;
}

export interface PlaybookMacroSignal {
  /** Median protein grams per lb of goal weight (current weight when no goal), two decimals. */
  protein_g_per_lb_median: number | null;
  /** Median calorie deficit below estimated maintenance for fat-loss clients, whole percent. */
  deficit_pct_median: number | null;
  /** Median calorie surplus above estimated maintenance for muscle-gain clients, whole percent. */
  surplus_pct_median: number | null;
  clients: number;
}

export interface PlaybookMealsSignal {
  meals_per_day_median: number;
  clients: number;
}

export interface PlaybookSignals {
  version: 'pbs-v1';
  /** Coaches on the team (head + active sub-coaches); a count, never ids. */
  team_size: number;
  top_exercises: PlaybookExerciseSignal[];
  schedule: PlaybookScheduleSignal | null;
  adjustments: PlaybookAdjustRuleSignal[];
  substitutions: PlaybookSubstitutionSignal[];
  macros: PlaybookMacroSignal | null;
  meals: PlaybookMealsSignal | null;
}

export interface PlaybookSignalsOptions {
  /**
   * When set, client-derived figures use only these clients (R11-P3b passes
   * the clients with memory-scope AI consent). Coach-authored plan contents
   * (top exercises) are not client data and ignore it.
   */
  clientIds?: readonly string[];
  /** Clock override for tests. */
  now?: Date;
}
