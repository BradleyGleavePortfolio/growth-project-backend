/**
 * LS-1221 B1: authenticated table writes must enforce the same new-link tenant
 * boundary as the coach HTTP routes. Runs against the replayed migration chain.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('LS-1221 link proof requires TEST_DATABASE_URL under CI.');
}

(url ? describe : describe.skip)('LS-1221 B1: template links reject another coach under RLS', () => {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const k = randomUUID();
  const l = randomUUID();
  const sub = randomUUID();
  const own = randomUUID();
  const ownSwap = randomUUID();
  const foreignSwap = randomUUID();
  const ownRecipe = randomUUID();
  const foreignRecipe = randomUUID();

  beforeAll(async () => {
    for (const [id, supabaseId] of [[k, sub], [l, randomUUID()]]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${id}, ${supabaseId}, ${`ls-1221-${id}`}, 'Link test coach', 'coach'::"Role")`;
    }
    for (const [id, coach] of [[own, k], [ownSwap, k], [foreignSwap, l]]) {
      await prisma.mealTemplate.create({
        data: { id, coach_id: coach, name: 'Link test meal', calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15 },
      });
    }
    for (const [id, coach] of [[ownRecipe, k], [foreignRecipe, l]]) {
      await prisma.recipe.create({
        data: {
          id, created_by_id: coach, title: 'Link test recipe',
          prep_time_min: 1, cook_time_min: 1, servings: 1,
          calories: 400, protein: 20, carbs: 40, fat: 15,
          ingredients: [], instructions: [], tags: [],
        },
      });
    }
  });
  afterAll(() => prisma.$disconnect());

  const asCoach = <T>(query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${k}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_role', 'coach', true)`;
      await tx.$executeRaw`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub, role: 'authenticated' })}, true)`;
      return query(tx);
    });

  it.each(['swap', 'recipe'] as const)('refuses a foreign %s on authenticated UPDATE after an own-link control', async (kind) => {
    const update = (target: string) => asCoach((tx) => kind === 'swap'
      ? tx.$executeRaw`UPDATE "MealTemplate" SET "swap_template_ids" = ARRAY[${target}]::TEXT[] WHERE "id" = ${own}`
      : tx.$executeRaw`UPDATE "MealTemplate" SET "recipe_id" = ${target} WHERE "id" = ${own}`);
    if (kind === 'swap') {
      expect(await asCoach((tx) => tx.mealTemplate.count({ where: { id: foreignSwap } }))).toBe(0);
    } else {
      // Recipe is server-only for API roles. Denied SELECT is the expected
      // control, not a failure of this probe's foreign-link assertion.
      await expect(asCoach((tx) => tx.recipe.count({ where: { id: foreignRecipe } }))).rejects.toThrow();
    }
    expect(await update(kind === 'swap' ? ownSwap : ownRecipe)).toBe(1);
    await expect(update(kind === 'swap' ? foreignSwap : foreignRecipe)).rejects.toThrow();
  });

  it.each(['swap', 'recipe'] as const)('refuses a foreign %s on authenticated INSERT after an own-link control', async (kind) => {
    const insert = (target: string) => asCoach((tx) => tx.mealTemplate.create({
      data: {
        coach_id: k, name: 'Inserted link meal', calories_kcal: 400, protein_g: 20, carbs_g: 40, fats_g: 15,
        ...(kind === 'swap' ? { swap_template_ids: [target] } : { recipe_id: target }),
      },
    }));
    expect(await insert(kind === 'swap' ? ownSwap : ownRecipe)).toMatchObject({ coach_id: k });
    await expect(insert(kind === 'swap' ? foreignSwap : foreignRecipe)).rejects.toThrow();
  });
});
