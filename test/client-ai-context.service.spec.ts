import { ClientAIContextService } from '../src/ai/client-ai-context.service';

// Tests pin the public contract of ClientAIContextService.build:
//   - Macro / profile fields land in the typed shape and follow APP_PRESCRIBED.
//   - PII (email, supabase_id, last name, exact DOB string) never appears.
//   - Missing profile, missing coach, and missing logs all degrade gracefully.
//   - Coach relationship surfaces last message excerpt and guidelines.
//   - Recent food entries collapse into a per-day adherence summary.
//   - The rendered prompt block reflects the typed context exactly and
//     contains the DO-NOT-CONTRADICT marker for app-prescribed values.

function makePrisma(opts: {
  user?: any;
  todayEntries?: any[];
  recentEntries?: any[];
  workouts?: any[];
  weights?: any[];
  habits?: any[];
  checkIns?: any[];
  coach?: any;
  lastMsg?: any;
  guidelines?: any;
  mealPlan?: any;
}) {
  const fallbackUser = {
    id: 'u1',
    name: 'Brad Gleave',
    email: 'leak@example.com',
    supabase_id: 'sb-secret',
    coach_id: 'coach-1',
    profile: {
      height_cm: 183,
      current_weight_lbs: 192,
      target_weight_lbs: 178,
      date_of_birth: new Date('1992-04-12'),
      sex: 'male',
      activity_level: 'active',
      goal_type: 'fat_loss',
      workout_experience: 'intermediate',
      has_gym_membership: true,
      preferred_snacks: ['cottage cheese', 'almonds'],
      macro_target_calories: 2400,
      macro_target_protein_g: 200,
      macro_target_carbs_g: 240,
      macro_target_fat_g: 70,
      water_goal_oz: 100,
      meals_per_day: 4,
      bio: 'Surf and lifts. No dairy.',
    },
  };
  return {
    user: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        if (where.id === 'u1') return Promise.resolve(opts.user ?? fallbackUser);
        if (where.id === 'coach-1') return Promise.resolve(opts.coach ?? { name: 'Sasha Lin' });
        return Promise.resolve(null);
      }),
    },
    loggedFoodEntry: {
      findMany: jest
        .fn()
        // First call inside Promise.all is the recent (7d) range, second is today.
        .mockImplementationOnce(async () => opts.recentEntries ?? [])
        .mockImplementationOnce(async () => opts.todayEntries ?? []),
    },
    workoutSession: {
      findMany: jest.fn().mockResolvedValue(opts.workouts ?? []),
    },
    weightLog: {
      findMany: jest.fn().mockResolvedValue(opts.weights ?? []),
    },
    habit: {
      findMany: jest.fn().mockResolvedValue(opts.habits ?? []),
    },
    checkIn: {
      findMany: jest.fn().mockResolvedValue(opts.checkIns ?? []),
    },
    coachMessage: {
      findFirst: jest.fn().mockResolvedValue(opts.lastMsg ?? null),
    },
    coachGuideline: {
      findUnique: jest.fn().mockResolvedValue(opts.guidelines ?? null),
    },
    mealPlan: {
      findFirst: jest.fn().mockResolvedValue(opts.mealPlan ?? null),
    },
  } as any;
}

describe('ClientAIContextService.buildFresh', () => {
  it('includes macro targets and profile fields and omits PII', async () => {
    const prisma = makePrisma({});
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('u1');

    expect(ctx.prescribed.calories).toBe(2400);
    expect(ctx.prescribed.protein_g).toBe(200);
    expect(ctx.profile.goal_type).toBe('fat_loss');
    expect(ctx.profile.height_cm).toBe(183);
    expect(ctx.profile.current_weight_lbs).toBe(192);
    expect(ctx.identity.first_name).toBe('Brad');
    // Anti-PII: full name, email, supabase id never escape.
    const json = JSON.stringify(ctx);
    expect(json).not.toContain('Gleave');
    expect(json).not.toContain('leak@example.com');
    expect(json).not.toContain('sb-secret');
  });

  it('handles missing profile without crashing', async () => {
    const prisma = makePrisma({
      user: { id: 'u1', name: 'Solo', coach_id: null, profile: null },
    });
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('u1');
    expect(ctx.profile.height_cm).toBeNull();
    expect(ctx.prescribed.calories).toBeNull();
    expect(ctx.coach.has_coach).toBe(false);
    expect(ctx.guardrails.forbid_contradicting_macros).toBe(false);
  });

  it('surfaces coach relationship and last message excerpt without coach PII', async () => {
    const prisma = makePrisma({
      lastMsg: {
        body: 'Great work this week. Stick to the protein target. ' + 'x'.repeat(500),
        created_at: new Date('2026-04-25T18:00:00Z'),
      },
      guidelines: { content: 'No alcohol weekdays. Lift 4x. Walk 8k steps daily.' },
      coach: { name: 'Sasha Lin', email: 'coach@example.com' },
    });
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('u1');
    expect(ctx.coach.has_coach).toBe(true);
    expect(ctx.coach.coach_name).toBe('Sasha');
    expect(ctx.coach.last_coach_message_excerpt).toBeTruthy();
    expect(ctx.coach.last_coach_message_excerpt!.length).toBeLessThanOrEqual(280);
    expect(ctx.coach.active_guidelines_excerpt).toContain('No alcohol weekdays');
    // Coach email never makes it through.
    expect(JSON.stringify(ctx)).not.toContain('coach@example.com');
  });

  it('summarizes recent food entries into per-day adherence', async () => {
    const fi = (cal: number, p: number, c: number, f: number) => ({
      calories: cal,
      protein_g: p,
      carbs_g: c,
      fat_g: f,
    });
    const day1 = new Date();
    day1.setHours(0, 0, 0, 0);
    day1.setDate(day1.getDate() - 1);
    const day2 = new Date(day1);
    day2.setDate(day2.getDate() - 1);
    const prisma = makePrisma({
      recentEntries: [
        { date: day1, food_item: fi(500, 40, 50, 15), quantity_multiplier: 1 },
        { date: day1, food_item: fi(400, 30, 40, 10), quantity_multiplier: 1 },
        { date: day2, food_item: fi(700, 55, 80, 20), quantity_multiplier: 1 },
      ],
    });
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('u1');
    expect(ctx.recent_adherence_7d.length).toBe(2);
    const top = ctx.recent_adherence_7d[0];
    expect(top.calories).toBe(900);
    expect(top.protein_g).toBe(70);
    expect(top.meal_count).toBe(2);
  });

  it('builds guardrails that demand non-contradiction when macros are set', async () => {
    const prisma = makePrisma({});
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('u1');
    expect(ctx.guardrails.forbid_contradicting_macros).toBe(true);
    expect(ctx.guardrails.refer_to_coach_for_medical).toBe(true);
    expect(ctx.guardrails.forbid_calorie_recommendations_below).toBeGreaterThanOrEqual(1500);
  });

  it('renderForPrompt includes APP_PRESCRIBED and DO NOT CONTRADICT markers', async () => {
    const prisma = makePrisma({
      lastMsg: {
        body: 'Stay strict on dinner carbs this week.',
        created_at: new Date('2026-04-26T18:00:00Z'),
      },
    });
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('u1');
    const rendered = svc.renderForPrompt(ctx);
    expect(rendered).toContain('APP_PRESCRIBED');
    expect(rendered).toContain('DO NOT CONTRADICT');
    expect(rendered).toContain('calories=2400');
    expect(rendered).toContain('protein_g=200');
    expect(rendered).toContain('Stay strict on dinner carbs');
  });

  it('returns an empty/safe context for unknown userId without throwing', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any;
    const svc = new ClientAIContextService(prisma);
    const ctx = await svc.buildFresh('ghost');
    expect(ctx.identity.first_name).toBe('there');
    expect(ctx.coach.has_coach).toBe(false);
  });

  it('caches context per user for the TTL window', async () => {
    const prisma = makePrisma({});
    const svc = new ClientAIContextService(prisma);
    const a = await svc.build('u1');
    const b = await svc.build('u1');
    expect(b.generated_at).toBe(a.generated_at);
    // user.findUnique called once for u1 plus once for coach lookup on the
    // first build only. Second build should re-use the cache and not refetch.
    expect((prisma.user.findUnique as jest.Mock).mock.calls.length).toBeLessThanOrEqual(2);
  });
});
