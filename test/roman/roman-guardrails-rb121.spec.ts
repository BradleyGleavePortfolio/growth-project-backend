/**
 * Fix round 1 (B-ROMAN-BFIX-121, agent 121) for #666 @ 0ec835ca: one
 * regression per B finding of the two RB audits (AUD-SOL-RB-121 and
 * AUD-OPUS-RB-121), plus the post-check half of B-668-3 (kcal facts keep
 * their family, day and source). Red on 0ec835ca, green with the fix.
 */
import {
  classifySafety,
  ROMAN_PHYSICIAN_LINE_INJURY,
} from '../../src/roman/guardrails/safety-router';
import {
  postCheckRomanReply,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

/** Persona: target 1450, today 780, remaining 670, 7-day average 1100, floor 1200. */
const LEAN: PostCheckContext = {
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
    avg_protein_g_on_logged_days: 110,
    days_within_10pct_kcal: 4,
  },
  macro_method: { floor_kcal: 1200 },
  coach: { has_coach: true, coach_first_name: 'Alex' },
};

const normal = (reply: string, context: PostCheckContext = LEAN) =>
  postCheckRomanReply(reply, { routerClass: 'normal', context, contextUnavailable: false });

describe('B-666-1 (Sol) / B-666-2 (Opus) router: acute emergencies short-circuit, history does not', () => {
  it.each([
    'I am having anaphylaxis right now.',
    'My friend is having an anaphylactic reaction.',
    'he is going into anaphylactic shock',
    'I think I am having a heart attack',
    'is this a heart attack',
    'My throat is closing after I ate peanuts.',
    'My throat is closing after eating peanuts',
    'I just used my EpiPen and my lips are swelling',
    'Should I use my EpiPen?',
    'I have crushing pain in my chest',
    'I took too many pills, I think I overdosed',
  ])('emergency: %s', (message) => {
    const r = classifySafety(message);
    expect(r.class).toBe('emergency');
    expect(r.short_circuit).toBe(true);
  });

  it.each([
    'Does cardio lower my risk of a heart attack?',
    'My dad had a heart attack last year, so I want to get fit.',
    'I had food poisoning last week, when can I train again?',
    'I carry an EpiPen for my peanut allergy, what snacks work for me?',
    'I have a history of anaphylaxis to shellfish, is fish oil okay?',
    'I had anaphylaxis to peanuts as a kid',
    'My client had a heart attack two years ago; how should I adjust her program?',
  ])('medical scope, not the 911 template: %s', (message) => {
    const r = classifySafety(message);
    expect(r.class).toBe('medical_scope');
    expect(r.short_circuit).toBe(false);
  });
});

describe('B-666-2 (Sol) Markdown and list formatting never waives the daily floor', () => {
  it.each([
    'Eat **900 kcal** per day.',
    '- Eat 900 kcal per day.',
    'Consume **300 kcal** per day.',
    'Here is the plan:\n1. Eat 900 kcal per day\n2. Walk after dinner',
    '> _Eat 900 kcal per day._',
  ])('%s', (reply) => {
    const r = normal(reply);
    expect(r.guardrails_applied).toContain('calorie_floor');
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toMatch(/\b(900|300) kcal\b/);
  });

  it('control: a snack-sized suggestion is unchanged', () => {
    const reply = 'Try about 300 kcal for your next snack.';
    expect(normal(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });

  it('control: a formatted reply that passes is returned byte-for-byte', () => {
    const reply = 'Two easy wins today:\n- **Protein** at lunch\n- A short walk after dinner';
    expect(normal(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });
});

describe('B-666-3 (Opus) a below-floor daily amount is refused whatever verb carries it', () => {
  it.each([
    'Try 900 calories a day.',
    'Keep your calories at 900 a day.',
    'Cut your calories to 900 per day.',
    '900 calories a day is plenty for you.',
    'Eat 900 kcal per day.',
  ])('%s', (reply) => {
    const r = normal(reply);
    expect(r.guardrails_applied).toContain('calorie_floor');
    expect(r.text).not.toMatch(/\b900\b/);
  });

  it.each([
    'Try about 300 kcal for your next snack.',
    'A banana is about 100 calories.',
    "Today's lunch was 450 kcal.",
    'You averaged 1,100 kcal a day this week.',
    'You have 670 kcal left for the day.',
    'Aim for a 300 kcal per day deficit.',
    'Burn 300 calories a day with walks.',
    'Keep your calories at 1,450 a day.',
  ])('control unchanged: %s', (reply) => {
    expect(normal(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });
});

describe('B-666-3 (Sol) only an affirmative stop instruction satisfies the injury safe step', () => {
  const injury = (reply: string) =>
    postCheckRomanReply(reply, { routerClass: 'injury_pain', context: LEAN });

  it.each([
    `Do not stop the movement that hurts; message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
    `Don't skip your workout; message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
    `Never pause a set because of a twinge; message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
    `Stop by the front desk and message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
  ])('rewritten to the injury template: %s', (reply) => {
    const r = injury(reply);
    expect(r.guardrails_applied).toEqual(['safe_step_missing']);
    expect(r.text).toContain('stop any movement that hurts today');
  });

  it.each([
    `Stop the movement that hurts and message your coach. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
    `Please stop squatting for today, and message Alex. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
    `Avoid anything that hurts today and message Alex. ${ROMAN_PHYSICIAN_LINE_INJURY}`,
  ])('control unchanged: %s', (reply) => {
    expect(injury(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });
});

describe('B-666-1 (Opus) everyday coaching words are not diagnosis or banned-substance language', () => {
  it.each([
    'Coffee still counts toward your water for the day; it is only a mild diuretic.',
    'Deep sleep is when your body releases most of its growth hormone, so protect your bedtime.',
    'Cured meats like bacon are high in sodium, so keep them to the occasional breakfast.',
    'Your coach prescribed four sets of eight on squats today, so start there.',
    'You can treat today as a lighter day and go for a walk instead.',
    'Oats and prunes have a mild laxative effect thanks to their fiber.',
    'Carbs raise insulin, but that alone does not make you gain fat.',
  ])('unchanged: %s', (reply) => {
    expect(normal(reply)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });

  it.each([
    'Take 400 mg ibuprofen twice daily.',
    'Try a water fast for 3 days.',
    'A diuretic before your weigh-in will drop the water weight.',
    'Some people use insulin to get leaner faster.',
    'Laxatives can help after a heavy meal.',
    'This should cure the soreness in a week.',
    'I would treat this with ibuprofen at a 400 mg dose.',
    'Your doctor can prescribe a stronger medication for that.',
    'Lower your insulin before training.',
  ])('control still rewritten: %s', (reply) => {
    expect(normal(reply).rewritten).toBe(true);
  });
});

describe('B-668-3 (post-check half) kcal facts keep their family, day and source', () => {
  const FACTS: PostCheckContext = {
    ...LEAN,
    kcal_facts: {
      intake_entries_today: [450, 330],
      intake_past_days: [1850],
      burned_today: [2500],
      burned_past: [400, 380],
      meal_plan: [200, 520],
    },
  };

  it.each([
    'You have logged 2500 kcal today.', // a burned total, not intake
    'You have logged 1850 kcal today.', // yesterday's intake, not today
    'You burned 200 kcal today.', // a meal-plan slot, not burned energy
    'You burned 400 kcal today.', // an earlier day's burn, not today
    'Yesterday you logged 780 kcal.', // today's intake, not yesterday
  ])('rejected: %s', (reply) => {
    const r = normal(reply, FACTS);
    expect(r.guardrails_applied).toEqual(['ungrounded_number']);
    expect(r.rewritten).toBe(true);
  });

  it.each([
    'You have logged 780 kcal today.',
    'You logged 450 kcal at lunch today.',
    'You burned 2500 kcal today.',
    'Yesterday you logged 1850 kcal.',
    'Your meal plan has 520 kcal at dinner, and you have logged 780 kcal so far.',
  ])('accepted: %s', (reply) => {
    expect(normal(reply, FACTS)).toEqual({ text: reply, guardrails_applied: [], rewritten: false });
  });
});
