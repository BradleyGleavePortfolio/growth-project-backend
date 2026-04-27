import { AIGuardrailsService } from '../src/ai/ai-guardrails.service';
import { ClientAIContext } from '../src/ai/client-ai-context.types';

function ctxFixture(overrides: Partial<ClientAIContext> = {}): ClientAIContext {
  return {
    identity: { first_name: 'Brad', age_years: 33, sex: 'male' },
    profile: {
      height_cm: 183,
      current_weight_lbs: 192,
      target_weight_lbs: 178,
      goal_type: 'fat_loss',
      activity_level: 'active',
      workout_experience: 'intermediate',
      has_gym_membership: true,
      preferred_snacks: [],
      bio: null,
    },
    prescribed: {
      calories: 2400,
      protein_g: 200,
      carbs_g: 240,
      fat_g: 70,
      water_ml: 2950,
      meals_per_day: 4,
    },
    today: {
      date: '2026-04-27',
      calories: 1200,
      protein_g: 100,
      carbs_g: 150,
      fat_g: 30,
      remaining_calories: 1200,
      remaining_protein_g: 100,
      pct_calories: 50,
    },
    recent_adherence_7d: [],
    recent_workouts: [],
    weight_trend_14d: [],
    habits: [],
    recent_check_ins: [],
    coach: {
      coach_name: 'Sasha',
      has_coach: true,
      last_coach_message_excerpt: null,
      last_coach_message_at: null,
      active_guidelines_excerpt: null,
    },
    current_meal_plan: null,
    guardrails: {
      forbid_calorie_recommendations_below: 1500,
      forbid_contradicting_macros: true,
      refer_to_coach_for_medical: true,
      forbid_extreme_dieting_language: true,
      forbid_unsafe_substances: true,
    },
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('AIGuardrailsService.validate', () => {
  let svc: AIGuardrailsService;
  beforeEach(() => {
    svc = new AIGuardrailsService();
  });

  it('flags a sub-floor calorie recommendation', () => {
    const r = svc.validate('how few calories can I eat', 'Try 1100 calories per day.', ctxFixture());
    expect(r.applied).toContain('calorie-floor');
    expect(r.reply).toContain('safety floor');
  });

  it('appends a macro-correction when the model proposes a contradicting protein target', () => {
    const r = svc.validate(
      'how much protein',
      'Aim for 100g protein daily for your goal.',
      ctxFixture(),
    );
    expect(r.applied).toContain('macro-correction');
    expect(r.reply).toContain('200g protein');
  });

  it('does NOT flag macro-correction when the model echoes the prescribed target', () => {
    const r = svc.validate(
      'how much protein',
      'Your target is 200g protein per day.',
      ctxFixture(),
    );
    expect(r.applied).not.toContain('macro-correction');
  });

  it('refers to the coach for medical / injury / mental-health questions', () => {
    const withCoach = svc.validate(
      'I tweaked my knee, what dosage of ibuprofen',
      'Take 800mg every 8 hours.',
      ctxFixture(),
    );
    expect(withCoach.applied).toContain('refer-to-coach');
    expect(withCoach.reply).toContain('Sasha');

    const noCoach = svc.validate(
      'I think I have an eating disorder',
      'Cut calories more.',
      ctxFixture({
        coach: {
          coach_name: null,
          has_coach: false,
          last_coach_message_excerpt: null,
          last_coach_message_at: null,
          active_guidelines_excerpt: null,
        },
      }),
    );
    expect(noCoach.applied).toContain('refer-to-coach');
    expect(noCoach.reply).toContain('qualified professional');
  });

  it('redacts banned substances and extreme-restriction language', () => {
    const r = svc.validate(
      'how to cut',
      'You could try clenbuterol or a 5 day water fast.',
      ctxFixture(),
    );
    expect(r.applied.some((x) => x.startsWith('banned:'))).toBe(true);
    expect(r.reply).not.toContain('clenbuterol');
    expect(r.reply.toLowerCase()).not.toContain('water fast');
  });

  it('strips em-dashes and exclamation marks (project style)', () => {
    const r = svc.validate('hi', 'Stay sharp — eat protein!', ctxFixture());
    expect(r.reply).not.toContain('—');
    expect(r.reply).not.toContain('!');
  });

  it('passes a clean reply through without modification', () => {
    const r = svc.validate('what is creatine', 'Creatine monohydrate, 5g daily, no loading.', ctxFixture());
    expect(r.applied).toEqual([]);
    expect(r.reply).toContain('Creatine monohydrate');
  });
});
