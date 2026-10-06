/**
 * B-669-1: residual B-666-5 at ef71cb9c.
 * Saved, NOT EXECUTED by this lens (no pushes/local Jest authorized).
 * Intended location for an authorized CI run: test/roman/.
 *
 * A daily aggregate does not have to repeat "today": "across two meals"
 * already sums multiple entries. The current !DAY_TOTAL_CLAIM disjunct
 * bypasses AGGREGATE_CLAIM and lets 450 stand in for the real 330 + 450.
 */
import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

const CONTEXT: PostCheckContext = {
  targets: { source: 'coach_set', calories: 2000, protein_g: 120, carbs_g: 200, fat_g: 60 },
  today: {
    kcal: 780, protein_g: 60, carbs_g: 70, fat_g: 25,
    meals_logged: 2, remaining_kcal: 1220, remaining_protein_g: 60,
    remaining_carbs_g: 130, remaining_fat_g: 35, pct_kcal: 39, pct_protein: 50,
  },
  last_7_days: {
    days_logged: 0, avg_kcal_on_logged_days: null,
    avg_protein_g_on_logged_days: null, days_within_10pct_kcal: null,
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
  kcal_facts: { intake_entries_today: [330, 450] },
};

const check = (text: string) =>
  postCheckRomanReply(text, { routerClass: 'normal', context: CONTEXT });

describe('B-669-1: aggregate wording wins even without repeating today', () => {
  it.each([
    'You have logged 450 kcal across two meals.',
    'You logged 450 kcal across breakfast and lunch.',
  ])('rejects a single-entry value as a multiple-meal sum: %s', (text) => {
    const result = check(text);
    expect(result.rewritten).toBe(true);
    expect(result.guardrails_applied).toContain('ungrounded_number');
  });

  it.each([
    'You have logged 780 kcal across two meals.',
    'You logged 780 kcal across breakfast and lunch.',
    'You logged 450 kcal at lunch today.',
    'You have logged 780 kcal today.',
    'Breakfast was 330 kcal.',
  ])('preserves a correct total or an actual single meal: %s', (text) => {
    expect(check(text)).toEqual({ text, guardrails_applied: [], rewritten: false });
  });
});
