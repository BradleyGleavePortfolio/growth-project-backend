import { Prisma } from '@prisma/client';
import { PrepGuideService } from '../src/prep-guide/prep-guide.service';
import { ListsService } from '../src/lists/lists.service';
import { MealPlansService } from '../src/meal-plans/meal-plans.service';
import { visibleRecipesWhere, RecipeViewer } from '../src/recipes/recipe-access';
import { asPrismaDouble } from '../src/regimes/__tests__/prisma-test-double';

const viewer: RecipeViewer = { id: 'client', role: 'student', coach_id: 'coach' };
const recipe = (id: string, ingredients: string[]) => ({
  id, ingredients, title: id, image_url: null, prep_time_min: 5,
  cook_time_min: 10, servings: 2, calories: 400, protein: 30,
  carbs: 40, fat: 10, tags: [],
});

describe('NUTR-BE-128 prep guide', () => {
  const make = (items: unknown[] = []) => {
    const db = {
      mealPlan: { findMany: jest.fn().mockResolvedValue([{ items }]) },
      recipe: { findMany: jest.fn().mockResolvedValue([recipe('r1', ['1 cup rice'])]) },
    };
    return { db, service: new PrepGuideService(asPrismaDouble(db)) };
  };

  it('labels visible-library fallback and reports that the requested week is not a filter', async () => {
    const { db, service } = make();
    const first = await service.getWeeklyPrepGuide(viewer, '2026-10-05');
    const next = await service.getWeeklyPrepGuide(viewer, '2026-10-12');
    expect(first).toMatchObject({ source: 'library', week_filter_applied: false, prep_day_suggestions: [] });
    expect(next.recipes).toEqual(first.recipes);
    expect(next).toMatchObject({ source: 'library', week_filter_applied: false });
    expect(db.recipe.findMany).toHaveBeenCalledWith({
      where: visibleRecipesWhere(viewer), orderBy: { created_at: 'desc' }, take: 6,
    });
  });

  it('labels only recipes referenced by assigned plans as plan, preserving visibility', async () => {
    const { db, service } = make([{ recipe_id: 'r1' }]);
    expect(await service.getWeeklyPrepGuide(viewer, '2026-10-05')).toMatchObject({
      source: 'plan', week_filter_applied: false, prep_day_suggestions: [],
    });
    expect(db.mealPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { client_id: viewer.id, archived_at: null },
    }));
    expect(db.recipe.findMany).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: ['r1'] } }, visibleRecipesWhere(viewer)] },
    });
  });

  it.each([
    ['cup', 'cups', 'cup'], ['tbsp', 'tablespoons', 'tbsp'],
    ['lb', 'lbs', 'lb'], ['g', 'grams', 'g'], ['tsp', 'teaspoon', 'tsp'],
  ])('aggregates %s and %s as %s', async (one, many, unit) => {
    const { db, service } = make();
    db.recipe.findMany.mockResolvedValue([
      recipe('r1', [`1 ${one} rice`]), recipe('r2', [`2 ${many} rice`, '4 kg rice']),
    ]);
    const result = await service.getWeeklyPrepGuide(viewer, '2026-10-05');
    expect(result.aggregated_ingredients).toEqual([
      { name: 'rice', quantity: 3, unit, recipe_ids: ['r1', 'r2'] },
      { name: 'rice', quantity: 4, unit: 'kg', recipe_ids: ['r2'] },
    ]);
  });
});

describe('NUTR-BE-128 list additions', () => {
  it.each<[string | null, string | undefined]>([
    ['cups', 'cup'], ['tablespoon', 'tbsp'], ['grams', 'g'], [null, undefined],
  ])(
    'merges into an unchecked case-insensitive name with equivalent units %s/%s',
    async (stored, incoming) => {
      const db = { listItem: {
        findMany: jest.fn().mockResolvedValue([{ id: 'existing', unit: stored }]),
        update: jest.fn().mockResolvedValue({ id: 'existing', quantity: 5 }),
        create: jest.fn(),
      } };
      const result = await new ListsService(asPrismaDouble(db)).addItem('client', 'grocery', {
        name: 'RICE', unit: incoming, quantity: 3,
      });
      expect(result).toMatchObject({ id: 'existing', quantity: 5 });
      expect(db.listItem.findMany).toHaveBeenCalledWith({
        where: {
          user_id: 'client', list_type: 'grocery', is_checked: false,
          name: { equals: 'RICE', mode: 'insensitive' },
        },
      });
      expect(db.listItem.update).toHaveBeenCalledWith({
        where: { id: 'existing' },
        data: { quantity: { increment: 3 }, unit: incoming == null ? null : incoming },
      });
      expect(db.listItem.create).not.toHaveBeenCalled();
    },
  );

  it('keeps different units separate and defaults new quantity to one', async () => {
    const db = { listItem: {
      findMany: jest.fn().mockResolvedValue([{ id: 'rice-kg', unit: 'kg' }]),
      update: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'new' }),
    } };
    await new ListsService(asPrismaDouble(db)).addItem('client', 'shopping', {
      name: 'rice', unit: 'Cups', source_recipe_id: 'r1',
    });
    expect(db.listItem.update).not.toHaveBeenCalled();
    expect(db.listItem.create).toHaveBeenCalledWith({ data: {
      user_id: 'client', list_type: 'shopping', name: 'rice', unit: 'cup',
      quantity: 1, source_recipe_id: 'r1',
    } });
  });

  it('adds twice to one saved row rather than creating a second row', async () => {
    const rows: Array<{ id: string; name: string; unit: string; quantity: number }> = [];
    const db = { listItem: {
      findMany: jest.fn(async () => rows),
      create: jest.fn(async ({ data }: { data: { name: string; unit: string; quantity: number } }) => {
        const row = { id: 'saved', ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ data }: { data: { quantity: { increment: number } } }) => {
        rows[0].quantity += data.quantity.increment;
        return rows[0];
      }),
    } };
    const service = new ListsService(asPrismaDouble(db));
    await service.addItem('client', 'grocery', { name: 'rice', unit: 'cups', quantity: 2 });
    await service.addItem('client', 'grocery', { name: 'RICE', unit: 'cup', quantity: 3 });
    expect(rows).toEqual([{ id: 'saved', user_id: 'client', list_type: 'grocery',
      name: 'rice', unit: 'cup', quantity: 5, source_recipe_id: null }]);
    expect(db.listItem.create).toHaveBeenCalledTimes(1);
  });
});

describe('NUTR-BE-128 canonical plan expiry', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-07T12:00:00Z')));
  afterAll(() => jest.useRealTimers());
  it.each([null, new Date('2026-11-01'), new Date('2026-09-01')])(
    'keeps open/current assignments but excludes an assignment ending %s',
    async (endsOn) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const legacy = { id: 'legacy', created_at: today };
      const db = {
        mealPlan: { findMany: jest.fn().mockResolvedValue([legacy]) },
        dailyMealPlanAssignment: { findFirst: jest.fn(async (
          { where }: { where: Prisma.DailyMealPlanAssignmentWhereInput },
        ) => {
          // Evaluate the end-date predicate, so removing it resurrects the ended plan.
          if (where.OR && endsOn && endsOn < today) return null;
          return { starts_on: today, daily_meal_plan: {
            id: 'daily', coach_id: 'coach', name: 'Plan', archived_at: null,
            created_at: today, slots: [],
          } };
        }) },
      };
      const result = await new MealPlansService(asPrismaDouble(db))
        .listForClientWithCanonicalFallback('client');
      expect(result.some((p) => p.id === 'canonical:daily')).toBe(!endsOn || endsOn >= today);
      expect(result).toContain(legacy);
      expect(db.dailyMealPlanAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { client_id: 'client', OR: [{ ends_on: null }, { ends_on: { gte: today } }] },
      }));
    },
  );
});
