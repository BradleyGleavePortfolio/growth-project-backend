/**
 * RMN3 items fixed in #669 (B-RMNC2-122, agent 122; the Roman train lands as
 * one, so #666 stays unchanged). Failing-before at #668 fefe73c6:
 * - A-666-3 (Opus): an overdose named by the medicine ("a whole bottle of
 *   Tylenol") reaches the emergency template; adapted from the
 *   AUD-OPUS-RMN3-122 probe.
 * - B-666-5 (Sol, residual B-668-3): a daily summary that mentions "meals"
 *   cannot pass one meal off as the whole day; adapted from the
 *   AUD-SOL-RMN3-122 probe.
 */
import { classifySafety } from '../../src/roman/guardrails/safety-router';
import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

describe('A-666-3 (Opus) overdose named by the medicine, not the word "pills"', () => {
  it.each([
    'I took a whole bottle of Tylenol',
    'I just swallowed a bottle of Advil',
    'I took 30 Tylenol',
    'I took 20 ibuprofen an hour ago',
    'I took a bunch of Xanax',
    'I took a whole bottle of my sleeping meds',
  ])('%s -> emergency template (short circuit)', (msg) => {
    const route = classifySafety(msg);
    expect(route.class).toBe('emergency');
    expect(route.short_circuit).toBe(true);
  });

  it.each([
    'I took 2 Tylenol for my headache',
    'I took 2 pills of ibuprofen for my headache',
    'Can I take Advil before a run?',
    'I took a whole bottle of water to the gym',
    'I took lots of vitamins',
    'Can I end my workout early today?',
  ])('control: %s -> not emergency or self_harm', (msg) => {
    const cls = classifySafety(msg).class;
    expect(cls === 'emergency' || cls === 'self_harm').toBe(false);
  });
});

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

const check = (text: string) => postCheckRomanReply(text, { routerClass: 'normal', context: CONTEXT });

describe('B-666-5 (Sol) a daily total that mentions meals is checked against the whole day', () => {
  it.each([
    'You have logged 450 kcal today across two meals.',
    'Your total intake today is 450 kcal from your meals.',
  ])('rejected (lunch passed off as the day): %s', (text) => {
    const result = check(text);
    expect(result.rewritten).toBe(true);
    expect(result.guardrails_applied).toContain('ungrounded_number');
  });

  it.each([
    'You have logged 780 kcal today across two meals.',
    'Your total intake today is 780 kcal from your meals.',
    'You logged 450 kcal at lunch today.',
    'You have logged 780 kcal today.',
    'Breakfast was 330 kcal.',
  ])('control (correct total or one actual meal): %s', (text) => {
    expect(check(text)).toEqual({ text, guardrails_applied: [], rewritten: false });
  });
});
