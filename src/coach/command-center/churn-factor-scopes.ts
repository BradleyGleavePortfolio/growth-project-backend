import { COACH_FITNESS_SCOPES, ConsentScope } from '../../consent/consent.service';

// CHURN-LABELS-132: the Coach sharing scope behind each churn-risk factor label. A coach sees a label
// (at-risk lists, the churn draft prompt and its stored top factor) only while the client shares every
// scope it is read from with that coach; the owner account reads all (grantedScopesByClient).
// - Workouts, food logs, weigh-ins, check-ins and habits: the at-risk lists and the draft already need
//   all four switches, so these labels are shared wherever they are shown.
// - Finance (finance EOD, finance milestone): read from the finance app, which none of the four covers.
//   Shown only with finance.summary, which no app screen grants today. Without it the engine still
//   writes "5+ finance EOD misses" for a client with no finance app at all.
// - App opens, messages and coach notes are not a log the switches cover: always shown.
// - A factor key not listed here (a new factor or engine) is never shown.
const NONE: readonly string[] = [];
const HABITS = [ConsentScope.FITNESS_HABITS_PROGRESS];
const BODY = [ConsentScope.FITNESS_BODY_METRICS];
const WORKOUTS = [ConsentScope.FITNESS_WORKOUTS];
const FOOD = [ConsentScope.FITNESS_FOOD_MACROS];
const FINANCE = [ConsentScope.FINANCE_SUMMARY];

// Signal (src/ptm/ptm.types.ts PtmSignalTypeT) -> the scopes it is read from.
const SIGNAL_SCOPES = new Map<string, readonly string[]>([
  ['checkin_streak', HABITS], ['checkin_miss', HABITS], ['streak_dropped', HABITS],
  ['consistency_low', COACH_FITNESS_SCOPES],
  ['weight_logged', BODY], ['weight_skipped', BODY],
  ['workout_logged', WORKOUTS], ['workout_skipped', WORKOUTS],
  ['meal_logged', FOOD], ['meal_skipped', FOOD],
  ['finance_eod', FINANCE], ['finance_milestone', FINANCE],
  ['app_open', NONE], ['message_sent', NONE], ['message_received', NONE], ['coach_note_received', NONE],
]);

// Heuristic factor key (src/ptm/ptm-heuristic.service.ts) -> its signal. The weighted engine writes
// `weighted_<signal>` (src/ptm/ptm-weighted.service.ts).
const FACTOR_SIGNAL = new Map<string, string>([
  ['checkin_miss_3plus', 'checkin_miss'], ['checkin_streak_7plus', 'checkin_streak'],
  ['streak_dropped_recent', 'streak_dropped'], ['consistency_low_recent', 'consistency_low'],
  ['weight_skip_14d', 'weight_logged'], ['weight_trend_aligned', 'weight_logged'],
  ['workout_skip_10d', 'workout_logged'], ['workout_recent', 'workout_logged'],
  ['meal_skip_7d', 'meal_logged'],
  ['finance_eod_skip_5plus', 'finance_eod'], ['finance_milestone_recent', 'finance_milestone'],
  ['app_open_gap_7d', 'app_open'], ['coach_note_gap_10d', 'coach_note_received'], ['coach_note_recent', 'coach_note_received'],
]);

/** Every scope a factor label can need: read once per request with grantedScopesByClient. */
export const CHURN_FACTOR_SCOPES: readonly string[] = [...COACH_FITNESS_SCOPES, ConsentScope.FINANCE_SUMMARY];

/** The scopes a factor is read from, or null when its source is not known. */
export function churnFactorScopes(key: string): readonly string[] | null {
  const signal = key.startsWith('weighted_') ? key.slice('weighted_'.length) : FACTOR_SIGNAL.get(key);
  return (signal !== undefined && SIGNAL_SCOPES.get(signal)) || null;
}

/** The factors a coach may see. `granted` is that coach's scopes for the client; 'all' only when no
 *  ConsentService is wired (hand-built unit tests, as coach-sharing-gate.ts). */
export function coachVisibleFactors<F extends { key: string }>(factors: readonly F[], granted: ReadonlySet<string> | 'all'): F[] {
  return factors.filter((f) => {
    const scopes = churnFactorScopes(f.key);
    return scopes !== null && (granted === 'all' || scopes.every((s) => granted.has(s)));
  });
}
