// Preserved independent assertion; not included in the already-pushed lane.
// Copy into test/roman at the candidate/fix head to execute.
import { postCheckContextOf } from '../../src/roman/roman.service';
import { postCheckRomanReply } from '../../src/roman/guardrails/roman-post-check';
import type { RomanClientContext } from '../../src/roman/context/roman-client-context.types';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const ctx = fakeOf<RomanClientContext>({
  targets: { source: 'coach_set', calories: 2000, protein_g: 120, carbs_g: 200, fat_g: 60 },
  today: {
    date: '2026-10-05', kcal: 780, protein_g: 60, carbs_g: 70, fat_g: 25,
    meals_logged: 2, remaining_kcal: 1220, remaining_protein_g: 60,
    remaining_carbs_g: 130, remaining_fat_g: 35, pct_kcal: 39, pct_protein: 50,
    entries: [
      { meal: 'breakfast', name: 'Breakfast', kcal: 330, protein_g: 30 },
      { meal: 'lunch', name: 'Lunch', kcal: 450, protein_g: 30 },
    ],
  },
  last_7_days: {
    days_logged: 0, avg_kcal_on_logged_days: null, avg_protein_g_on_logged_days: null,
    days_within_10pct_kcal: null, days: [],
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
  wearables: { days: [], avg_7d: { active_kcal: null } },
  meal_plan: null,
});

describe('AUD-SOL-RMN1-122 prior B-668-3 — normal daily total versus one meal', () => {
  it('a lunch entry cannot validate a false whole-day logged-total claim', () => {
    const checked = postCheckRomanReply('You have logged 450 kcal today.', {
      routerClass: 'normal', context: postCheckContextOf(ctx),
    });
    expect(checked.rewritten).toBe(true);
    expect(checked.guardrails_applied).toContain('ungrounded_number');
  });

  it.each(['You have logged 780 kcal today.', 'You logged 450 kcal at lunch today.'])(
    'control accepts the correctly aggregated fact: %s',
    (reply) => {
      expect(postCheckRomanReply(reply, {
        routerClass: 'normal', context: postCheckContextOf(ctx),
      })).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
    },
  );
});
