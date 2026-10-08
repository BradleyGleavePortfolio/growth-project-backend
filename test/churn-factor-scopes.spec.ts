import { readFileSync } from 'fs';
import { join } from 'path';
import { COACH_FITNESS_SCOPES, ConsentScope } from '../src/consent/consent.service';
import { churnFactorScopes, coachVisibleFactors } from '../src/coach/command-center/churn-factor-scopes';

// CHURN-LABELS-132: every factor the heuristic engine writes has a known source, so a new factor added
// without one fails here (at run time it would be hidden from coaches, never shown).
describe('CHURN-LABELS-132: churn factor label -> Coach sharing scope', () => {
  const source = readFileSync(join(__dirname, '../src/ptm/ptm-heuristic.service.ts'), 'utf8');
  const keys = [...source.matchAll(/key: '([a-z0-9_]+)'/g)].map((m) => m[1]);

  it('every heuristic factor key maps to its scopes', () => {
    expect(keys).toHaveLength(14);
    expect(keys.filter((k) => churnFactorScopes(k) === null)).toEqual([]);
  });

  it('finance needs finance.summary; app opens and coach notes need no switch; the four logs need their switch', () => {
    const fin = [ConsentScope.FINANCE_SUMMARY];
    expect(churnFactorScopes('finance_eod_skip_5plus')).toEqual(fin);
    expect(churnFactorScopes('finance_milestone_recent')).toEqual(fin);
    expect(churnFactorScopes('weighted_finance_eod')).toEqual(fin);
    expect(churnFactorScopes('app_open_gap_7d')).toEqual([]);
    expect(churnFactorScopes('coach_note_recent')).toEqual([]);
    expect(churnFactorScopes('checkin_miss_3plus')).toEqual([ConsentScope.FITNESS_HABITS_PROGRESS]);
    expect(churnFactorScopes('weight_trend_aligned')).toEqual([ConsentScope.FITNESS_BODY_METRICS]);
    expect(churnFactorScopes('weighted_workout_logged')).toEqual([ConsentScope.FITNESS_WORKOUTS]);
    expect(churnFactorScopes('meal_skip_7d')).toEqual([ConsentScope.FITNESS_FOOD_MACROS]);
    expect(churnFactorScopes('consistency_low_recent')).toEqual(COACH_FITNESS_SCOPES);
    expect(churnFactorScopes('made_up')).toBeNull();
    expect(churnFactorScopes('weighted_made_up')).toBeNull();
    expect(churnFactorScopes('constructor')).toBeNull();
  });

  it('coachVisibleFactors keeps order, needs every scope, and drops unknown keys even with all shared', () => {
    const f = ['finance_eod_skip_5plus', 'weight_skip_14d', 'made_up', 'app_open_gap_7d'].map((key) => ({ key }));
    expect(coachVisibleFactors(f, new Set(COACH_FITNESS_SCOPES)).map((x) => x.key)).toEqual(['weight_skip_14d', 'app_open_gap_7d']);
    expect(coachVisibleFactors(f, new Set()).map((x) => x.key)).toEqual(['app_open_gap_7d']);
    expect(coachVisibleFactors(f, 'all').map((x) => x.key)).toEqual(['finance_eod_skip_5plus', 'weight_skip_14d', 'app_open_gap_7d']);
  });
});
