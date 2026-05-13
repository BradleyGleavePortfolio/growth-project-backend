// Snapshot tests for the v1 prompt strings. Locks the system prompt and a
// rendered user prompt for each of the three capabilities — diffs here
// surface unintended prompt edits.

import {
  WorkoutProgramPrompt,
  MealPlanPrompt,
  ClientInsightPrompt,
} from '../../src/ai/prompts';
import { ClientContext } from '../../src/ai/context/client-context.types';

function fixtureCtx(): ClientContext {
  return {
    client_id: 'client-1',
    identity: { first_name: 'Jane', age_years: 35, sex: 'female' },
    profile: {
      height_cm: 165,
      current_weight_lbs: 150,
      target_weight_lbs: 140,
      goal_type: 'fat_loss',
      activity_level: 'moderate',
      workout_experience: 'intermediate',
      has_gym_membership: true,
      preferred_snacks: ['greek yogurt'],
      dietary_pattern: 'omnivore',
      dietary_restrictions: ['tree_nut'],
      workout_days_per_week: 4,
      meals_per_day: 4,
      equipment_access: ['dumbbells'],
      bio: null,
      injuries: ['left knee'],
      food_preferences: null,
      preferred_training_time: 'AM',
    },
    prescribed: {
      calories: 1800,
      protein_g: 140,
      carbs_g: 180,
      fat_g: 60,
      fiber_g: 25,
      meals_per_day: 4,
      water_ml: 2000,
      effective_from: '2026-05-01T00:00:00.000Z',
    },
    today: {
      date: '2026-05-13',
      calories: 400,
      protein_g: 30,
      carbs_g: 40,
      fat_g: 10,
      remaining_calories: 1400,
      remaining_protein_g: 110,
      pct_calories: 22,
    },
    weight_trend_90d: [
      { date: '2026-02-15', weight_lbs: 156 },
      { date: '2026-05-13', weight_lbs: 150 },
    ],
    recent_workout_assignments: [],
    food_log_totals_last_7d: {
      days_logged: 6,
      avg_calories: 1750,
      avg_protein_g: 138,
      avg_carbs_g: 175,
      avg_fat_g: 58,
    },
    recent_check_ins: [],
    coach: {
      coach_id: 'coach-1',
      coach_name: 'Sasha',
      has_coach: true,
      last_coach_message_excerpt: null,
    },
    generated_at: '2026-05-13T12:00:00.000Z',
  };
}

describe('Prompt versions are pinned', () => {
  it('workout-program v1', () => {
    expect(WorkoutProgramPrompt.name).toBe('workout-program');
    expect(WorkoutProgramPrompt.version).toBe('v1');
  });
  it('meal-plan v1', () => {
    expect(MealPlanPrompt.name).toBe('meal-plan');
    expect(MealPlanPrompt.version).toBe('v1');
  });
  it('client-insight v1', () => {
    expect(ClientInsightPrompt.name).toBe('client-insight');
    expect(ClientInsightPrompt.version).toBe('v1');
  });
});

describe('System prompts are stable', () => {
  it('workout-program system prompt', () => {
    expect(WorkoutProgramPrompt.system).toMatchSnapshot();
  });
  it('meal-plan system prompt', () => {
    expect(MealPlanPrompt.system).toMatchSnapshot();
  });
  it('client-insight system prompt', () => {
    expect(ClientInsightPrompt.system).toMatchSnapshot();
  });
});

describe('User prompts render deterministically against the fixture', () => {
  it('workout-program', () => {
    const userMsg = WorkoutProgramPrompt.buildUser(fixtureCtx(), {
      weeks: 4,
      daysPerWeek: 4,
      focus: 'hypertrophy',
    });
    expect(userMsg).toMatchSnapshot();
  });
  it('meal-plan', () => {
    const userMsg = MealPlanPrompt.buildUser(fixtureCtx(), { days: 7 });
    expect(userMsg).toMatchSnapshot();
  });
  it('client-insight', () => {
    const userMsg = ClientInsightPrompt.buildUser(fixtureCtx(), { windowDays: 7 });
    expect(userMsg).toMatchSnapshot();
  });
});

describe('Output validators reject malformed payloads', () => {
  it('workout-program: missing days', () => {
    expect(() => WorkoutProgramPrompt.validate({ summary: '', weeks: 4, days_per_week: 4 })).toThrow();
  });
  it('meal-plan: missing daily_totals', () => {
    expect(() =>
      MealPlanPrompt.validate({
        summary: '',
        days: [{ day: 1, meals: [] }],
        coach_notes: '',
      }),
    ).toThrow();
  });
  it('client-insight: missing array fields', () => {
    expect(() => ClientInsightPrompt.validate({ summary: 'ok' })).toThrow();
  });
});
