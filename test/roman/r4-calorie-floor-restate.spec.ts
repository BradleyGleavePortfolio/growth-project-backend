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

// C-908-5/6: the grams and the kcal left come from the same lifted number.
describe('R4c: a floor-lifted correction adds up', () => {
  function logged(floor: number, calories: number): PostCheckContext {
    const ctx = coachTarget(floor, calories);
    ctx.targets = { ...ctx.targets, protein_g: 70, carbs_g: 110, fat_g: 31 };
    ctx.today = { ...ctx.today, kcal: 600, protein_g: 40, meals_logged: 2 };
    ctx.today.remaining_kcal = calories - 600;
    return ctx;
  }

  it('grams and kcal left follow the 1,200 kcal floor, not the stored 1,000', () => {
    const checked = postCheckRomanReply('Stick to 1,000 kcal today.', {
      context: logged(1200, 1000),
      routerClass: 'normal',
    });
    expect(checked.text).toBe(
      'Your daily target is 1,200 kcal (84 g protein, 132 g carbs, 37 g fat), which Alex set. So far today you have logged 600 kcal and 40 g protein, leaving 600 kcal. I will not suggest different targets; if you would like them reviewed, message Alex.',
    );
    const kcal = 84 * 4 + 132 * 4 + 37 * 9;
    expect(Math.abs(kcal - 1200)).toBeLessThan(12);
  });

  it('a target above the floor is restated byte for byte as stored', () => {
    const checked = postCheckRomanReply('Stick to 1,000 kcal today.', {
      context: logged(1200, 1800),
      routerClass: 'normal',
    });
    expect(checked.text).toBe(
      'Your daily target is 1,800 kcal (70 g protein, 110 g carbs, 31 g fat), which Alex set. So far today you have logged 600 kcal and 40 g protein, leaving 1200 kcal. I will not suggest different targets; if you would like them reviewed, message Alex.',
    );
  });
});
