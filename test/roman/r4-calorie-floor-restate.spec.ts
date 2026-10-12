import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

// B-908-1: a coach target saved before #908 can sit under the client's floor.
// Roman's deterministic correction restates max(stored target, floor).
function coachTarget(floor: number, calories: number): PostCheckContext {
  return {
    targets: { source: 'coach_set', calories, protein_g: 100, carbs_g: 100, fat_g: 40 },
    today: {
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      meals_logged: 0,
      remaining_kcal: calories,
      remaining_protein_g: 100,
      remaining_carbs_g: 100,
      remaining_fat_g: 40,
      pct_kcal: 0,
      pct_protein: 0,
    },
    last_7_days: {
      days_logged: 0,
      avg_kcal_on_logged_days: null,
      avg_protein_g_on_logged_days: null,
      days_within_10pct_kcal: null,
    },
    macro_method: { floor_kcal: floor },
    coach: { has_coach: true, coach_first_name: 'Alex' },
  };
}

describe('B-908-1: Roman never re-endorses a stored target under the floor', () => {
  it.each([
    ['female', 1200, 'Your daily target is 1,200 kcal'],
    ['male', 1500, 'Your daily target is 1,500 kcal'],
    ['sex not recorded', 1500, 'Your daily target is 1,500 kcal'],
  ] as const)('%s: corrections restate the floor, not 1,000 kcal', (_sex, floor, expected) => {
    const context = coachTarget(floor, 1000);
    for (const reply of [
      'Stick to 1,000 kcal today.',
      'Your daily protein target should be 200 g.',
    ]) {
      const checked = postCheckRomanReply(reply, { context, routerClass: 'normal' });
      expect(checked.rewritten).toBe(true);
      expect(checked.text).not.toContain('1,000 kcal');
      expect(checked.text).toContain(expected);
      expect(context.targets.calories).toBe(1000); // stored target is untouched
    }
  });

  it('still restates an ordinary coach target above the floor', () => {
    const checked = postCheckRomanReply('Stick to 1,000 kcal today.', {
      context: coachTarget(1500, 1800),
      routerClass: 'normal',
    });
    expect(checked.guardrails_applied).toContain('calorie_floor');
    expect(checked.text).toContain('Your daily target is 1,800 kcal');
  });
});
