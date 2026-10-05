import 'reflect-metadata';
import {
  classifySafety,
  ROMAN_PHYSICIAN_LINE_INJURY,
} from '../../src/roman/guardrails/safety-router';
import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

const CONTEXT: PostCheckContext = {
  targets: { source: 'coach_set', calories: 1450, protein_g: 120, carbs_g: 140, fat_g: 45 },
  today: {
    kcal: 780, protein_g: 60, carbs_g: 70, fat_g: 25, meals_logged: 2,
    remaining_kcal: 670, remaining_protein_g: 60, remaining_carbs_g: 70,
    remaining_fat_g: 20, pct_kcal: 54, pct_protein: 50,
  },
  last_7_days: {
    days_logged: 5, avg_kcal_on_logged_days: 1100,
    avg_protein_g_on_logged_days: 110, days_within_10pct_kcal: 4,
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
};

describe('AUD-SOL-RB-121 independent safety probes at #666 exact head', () => {
  it.each([
    'I am having anaphylaxis right now.',
    'My friend is having an anaphylactic reaction.',
  ])('acute named allergic emergency must short-circuit: %s', (message) => {
    const actual = classifySafety(message);
    console.info(JSON.stringify({ probe: 'acute_anaphylaxis', message, actual }));
    expect(actual.class).toBe('emergency');
    expect(actual.short_circuit).toBe(true);
  });

  it.each([
    'Eat **900 kcal** per day.',
    '- Eat 900 kcal per day.',
    'Consume **300 kcal** per day.',
  ])('formatting does not waive a daily floor: %s', (reply) => {
    const actual = postCheckRomanReply(reply, { routerClass: 'normal', context: CONTEXT });
    console.info(JSON.stringify({ probe: 'formatted_daily_floor', reply, actual }));
    expect(actual.rewritten).toBe(true);
    expect(actual.text).not.toBe(reply);
    expect(actual.guardrails_applied).toContain('calorie_floor');
  });

  it('a negated stop instruction does not satisfy the injury safe-step requirement', () => {
    const reply =
      `Do not stop the movement that hurts; message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`;
    const actual = postCheckRomanReply(reply, { routerClass: 'injury_pain', context: CONTEXT });
    console.info(JSON.stringify({ probe: 'negated_stop', reply, actual }));
    expect(actual.rewritten).toBe(true);
    expect(actual.text).not.toContain('Do not stop the movement that hurts');
    expect(actual.text).toContain('stop any movement that hurts today');
  });

  it.each([
    'What should my rowing stroke rate be?',
    'How do I improve my back stroke for swim day?',
    'I fainted once last year after giving blood.',
  ])('historical B-651-2 negative remains non-emergency: %s', (message) => {
    expect(classifySafety(message).class).not.toBe('emergency');
  });

  it('positive crisis control retains the airway emergency route', () => {
    expect(classifySafety('My throat is closing after I ate peanuts.')).toMatchObject({
      class: 'emergency', short_circuit: true,
    });
  });

  it('plain daily directive remains rejected and a snack remains permitted', () => {
    expect(postCheckRomanReply('Eat 900 kcal per day.', {
      routerClass: 'normal', context: CONTEXT,
    }).guardrails_applied).toContain('calorie_floor');
    const snack = 'Try about 300 kcal for your next snack.';
    expect(postCheckRomanReply(snack, {
      routerClass: 'normal', context: CONTEXT,
    }).text).toBe(snack);
  });

  it('an affirmative stop instruction and exact physician line remain permitted', () => {
    const reply = `Stop the movement that hurts and message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`;
    expect(postCheckRomanReply(reply, {
      routerClass: 'injury_pain', context: CONTEXT,
    })).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });
});
