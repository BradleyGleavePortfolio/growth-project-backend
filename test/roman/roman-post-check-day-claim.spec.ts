/**
 * ROMAN-GUARD-129 (b#846 U1, agent 129): a correct figure for today in a sentence that also says
 * "your usual", "your baseline" or "last month" is not replaced by the targets paragraph when the
 * number's own clause names no day. R11-T3-FU (#849) fixed the clause that says "today"; these shapes
 * were still judged against earlier days only. Red on main c3324d4a: every "accepted" sentence was
 * rewritten. A figure that matches none of the client's data, or a day named before it that it does
 * not match, is still rewritten (green before and after).
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

describe('ROMAN-GUARD-129: a correct today figure next to "usual", "baseline" or "last month"', () => {
  it.each([
    'Today you have logged 780 kcal and 60 g protein, both under your usual.',
    'You are at 60 g protein, under your usual.',
    'You are at 60 g protein against your baseline.',
    'So far you have logged 780 kcal and 60 g protein, both below last month.',
    'You are at 780 kcal, below your average last month.',
    'Today, you are at 60 g protein, below your baseline.',
    'You burned 2500 kcal, more than your usual.',
    'You are at 60 g protein, under your usual 110 g.',
    'Yesterday you logged 1,850 kcal, and today you have logged 780 kcal and 60 g protein.',
  ])('accepted unchanged: %s', (reply) => {
    expect(check(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });

  it.each([
    'Today you have logged 780 kcal and 95 g protein, both under your usual.', // invented grams
    'You are at 95 g protein, under your usual.', // invented grams
    'You are at 1,234 kcal, below your average last month.', // invented kcal
    'You burned 999 kcal, more than your usual.', // invented burn
    'You are at 60 g protein, under your usual 95 g.', // invented usual
    'Yesterday, you logged 780 kcal.', // today's kcal claimed for the day named before it
    'Yesterday you logged 1850 kcal and 60 g protein.', // today's grams claimed for yesterday
  ])('still rewritten: %s', (reply) => {
    const r = check(reply);
    expect(r.guardrails_applied).toEqual(['ungrounded_number']);
    expect(r.rewritten).toBe(true);
  });
});
