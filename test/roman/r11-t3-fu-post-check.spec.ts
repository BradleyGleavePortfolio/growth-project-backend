/**
 * R11-T3-FU (agent 128): a sentence that gives a correct figure for today and also names a past period
 * ("your usual", "last month", "in the last 2 weeks") keeps both checks apart: today's figure is checked
 * against today's facts, the past-period figure against earlier days. Red on main a2dccecb: every
 * "accepted" mixed sentence was replaced by the targets paragraph, and three earlier-day figures
 * claimed for today passed. Green with the fix.
 */
import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

/** Today 780 kcal / 60 g protein, burned 2500; earlier days 1850 and 1500 kcal, 110 and 118 g protein, burned 400. */
const CTX: PostCheckContext = {
  targets: { source: 'coach_set', calories: 1450, protein_g: 120, carbs_g: 140, fat_g: 45 },
  today: {
    kcal: 780,
    protein_g: 60,
    carbs_g: 70,
    fat_g: 25,
    meals_logged: 2,
    remaining_kcal: 670,
    remaining_protein_g: 60,
    remaining_carbs_g: 70,
    remaining_fat_g: 20,
    pct_kcal: 54,
    pct_protein: 50,
  },
  last_7_days: {
    days_logged: 5,
    avg_kcal_on_logged_days: 1100,
    avg_protein_g_on_logged_days: 100,
    days_within_10pct_kcal: 4,
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
  kcal_facts: {
    intake_entries_today: [450, 330],
    intake_past_days: [1850, 1500],
    burned_today: [2500],
    burned_past: [400],
  },
  macro_past: { protein_g: [110, 118] },
};

const check = (reply: string) =>
  postCheckRomanReply(reply, { routerClass: 'normal', context: CTX, contextUnavailable: false });

describe('R11-T3-FU: today and a past period in one sentence', () => {
  it.each([
    'You are at 60 g protein today, under your usual.',
    'You have logged 780 kcal today, a little under your usual.',
    'You burned 2500 kcal today, more than your usual.',
    'You have had 60 g protein today, and last month you logged 118 g protein on your best day.',
    'You are at 780 kcal today; in the last 2 weeks you logged 1,850 kcal on your highest day.',
    'Over the last three weeks your protein ran 110 g on most days, and today you are at 60 g protein.',
  ])('accepted unchanged: %s', (reply) => {
    expect(check(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });

  it.each([
    'You are at 110 g protein today, under your usual.', // an earlier day's grams claimed for today
    'You have logged 1850 kcal today, more than your usual.', // an earlier day's kcal claimed for today
    'Last month you logged 780 kcal on your best day, and today you have had 60 g protein.', // today's kcal claimed for the past
    'You are at 95 g protein today, under your usual.', // invented
    'You burned 400 kcal today, more than your usual.', // an earlier day's burn claimed for today
  ])('still rewritten: %s', (reply) => {
    const r = check(reply);
    expect(r.guardrails_applied).toEqual(['ungrounded_number']);
    expect(r.rewritten).toBe(true);
  });

  it.each([
    ['You are at 60 g protein today.', false],
    ['You are at 110 g protein today.', true],
    ['Yesterday you logged 1850 kcal and 118 g protein.', false],
    ['Yesterday you logged 780 kcal.', true],
    ['In the last 2 weeks you logged 1,850 kcal on your highest day.', false],
  ])('unchanged without a today word next to the number: %s', (reply, rewritten) => {
    expect(check(reply).rewritten).toBe(rewritten);
  });
});
