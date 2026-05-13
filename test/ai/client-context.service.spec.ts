import { ClientContextService } from '../../src/ai/context/client-context.service';

function makePrisma(opts: {
  user: any;
  macroTarget?: any;
  weightLogs?: any[];
  assignments?: any[];
  foodEntries7d?: any[];
  foodEntriesToday?: any[];
  checkIns?: any[];
  coachMessage?: any;
  coachUser?: any;
}) {
  return {
    user: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        if (where.id === opts.user.id) return opts.user;
        if (opts.coachUser && where.id === opts.coachUser.id) return opts.coachUser;
        return null;
      }),
    },
    macroTarget: {
      findFirst: jest.fn().mockResolvedValue(opts.macroTarget ?? null),
    },
    weightLog: {
      findMany: jest.fn().mockResolvedValue(opts.weightLogs ?? []),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn().mockResolvedValue(opts.assignments ?? []),
    },
    loggedFoodEntry: {
      findMany: jest
        .fn()
        .mockImplementationOnce(async () => opts.foodEntries7d ?? [])
        .mockImplementationOnce(async () => opts.foodEntriesToday ?? []),
    },
    checkIn: {
      findMany: jest.fn().mockResolvedValue(opts.checkIns ?? []),
    },
    coachMessage: {
      findFirst: jest.fn().mockResolvedValue(opts.coachMessage ?? null),
    },
  } as any;
}

describe('ClientContextService.build', () => {
  it('returns an empty context for an unknown client', async () => {
    const prisma = makePrisma({ user: { id: 'unknown' } });
    prisma.user.findUnique = jest.fn().mockResolvedValue(null);
    const svc = new ClientContextService(prisma);
    const ctx = await svc.build('unknown');
    expect(ctx.client_id).toBe('unknown');
    expect(ctx.identity.first_name).toBe('Client');
    expect(ctx.profile.injuries).toEqual([]);
  });

  it('threads through the new audit-required fields when present', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const prisma = makePrisma({
      user: {
        id: 'u1',
        name: 'Jane Doe',
        coach_id: 'coach1',
        profile: {
          height_cm: 165,
          current_weight_lbs: 150,
          target_weight_lbs: 140,
          date_of_birth: new Date('1990-01-01'),
          sex: 'female',
          activity_level: 'moderate',
          goal_type: 'fat_loss',
          workout_experience: 'intermediate',
          has_gym_membership: true,
          preferred_snacks: ['greek yogurt'],
          dietary_pattern: 'vegan',
          dietary_restrictions: ['tree_nut'],
          workout_days_per_week: 4,
          meals_per_day: 4,
          equipment_access: ['dumbbells'],
          bio: 'mountain biker',
          injuries: ['left knee'],
          food_preferences: { likes: ['oats'] },
          preferred_training_time: 'AM',
          macro_target_calories: null,
          macro_target_protein_g: null,
          macro_target_carbs_g: null,
          macro_target_fat_g: null,
          water_goal_oz: null,
        },
      },
      macroTarget: {
        calories_kcal: 1800,
        protein_g: 140,
        carbs_g: 180,
        fats_g: 60,
        fiber_g: 25,
        effective_from: new Date('2026-05-01'),
      },
      foodEntriesToday: [
        {
          date: today,
          quantity_multiplier: 1,
          food_item: { calories: 400, protein_g: 30, carbs_g: 40, fat_g: 10 },
        },
      ],
      assignments: [
        {
          scheduled_for: today,
          completed_at: today,
          post_rpe: 8,
          post_notes: null,
          workout_plan: { name: 'Upper A', type: 'strength' },
        },
      ],
      checkIns: [
        { date: today, type: 'morning', mood: 7, energy: 8, soreness: 3, sleep_hours: 7.5, notes: null },
      ],
      coachMessage: { body: 'Push protein today', created_at: today },
      coachUser: { id: 'coach1', name: 'Sasha Lee' },
    });
    const svc = new ClientContextService(prisma);
    const ctx = await svc.build('u1');
    expect(ctx.profile.injuries).toEqual(['left knee']);
    expect(ctx.profile.dietary_pattern).toBe('vegan');
    expect(ctx.profile.dietary_restrictions).toEqual(['tree_nut']);
    expect(ctx.profile.preferred_training_time).toBe('AM');
    expect(ctx.profile.food_preferences).toEqual({ likes: ['oats'] });
    expect(ctx.prescribed.calories).toBe(1800);
    expect(ctx.prescribed.protein_g).toBe(140);
    expect(ctx.today.calories).toBe(400);
    expect(ctx.today.remaining_calories).toBe(1400);
    expect(ctx.recent_workout_assignments[0].post_rpe).toBe(8);
    expect(ctx.coach.has_coach).toBe(true);
    expect(ctx.coach.coach_name).toBe('Sasha');
    expect(ctx.coach.last_coach_message_excerpt).toBe('Push protein today');
  });
});
