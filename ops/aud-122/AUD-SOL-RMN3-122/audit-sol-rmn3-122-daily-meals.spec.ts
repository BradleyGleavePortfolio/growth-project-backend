import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

const CONTEXT: PostCheckContext = {
  targets: {
    source: 'coach_set', calories: 2000, protein_g: 120, carbs_g: 200, fat_g: 60,
  },
  today: {
    kcal: 780, protein_g: 60, carbs_g: 70, fat_g: 25,
    meals_logged: 2, remaining_kcal: 1220, remaining_protein_g: 60,
    remaining_carbs_g: 130, remaining_fat_g: 35,
    pct_kcal: 39, pct_protein: 50,
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

describe('AUD-SOL-RMN3-122 residual B-668-3: daily totals that mention meals', () => {
  it.each([
    'You have logged 450 kcal today across two meals.',
    'Your total intake today is 450 kcal from your meals.',
  ])('a meal word must not authorize a false whole-day fact: %s', (text) => {
    const result = check(text);
    console.log(JSON.stringify({ input: text, ...result }));
    expect(result.rewritten).toBe(true);
    expect(result.guardrails_applied).toContain('ungrounded_number');
  });

  it.each([
    'You have logged 780 kcal today across two meals.',
    'Your total intake today is 780 kcal from your meals.',
    'You logged 450 kcal at lunch today.',
    'You have logged 780 kcal today.',
  ])('control: a correct daily total or actual single meal is accepted: %s', (text) => {
    expect(check(text)).toEqual({
      text, guardrails_applied: [], rewritten: false,
    });
  });
});
