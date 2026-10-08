/**
 * CF-ALLERGY-128 (owner 10-07: allergy filtering is "absolutely necessary").
 *
 * One allergen list (src/recipes/allergens.ts); authors declare a recipe's
 * allergens; a client's library (list, saved, detail, save, prep guide) hides
 * a recipe their coach shares only when a DECLARED allergen matches one saved
 * on the client's profile. Recipe text is never guessed into an allergen, the
 * client's own recipes are never hidden, and an undeclared recipe stays
 * visible with allergens_declared = false so the app can label it.
 *
 * Failing-first: on main c3324d4a this suite cannot run (there is no
 * src/recipes/allergens.ts and RecipesService never reads the viewer's saved
 * allergies), so every case below fails there.
 *
 * The services run against an in-memory Prisma double that EVALUATES the where
 * clauses they send (OR / AND / NOT / id / created_by_id / is_public /
 * created_by / allergens.hasSome); any other key throws, so an unknown
 * predicate fails the test instead of silently matching.
 */
import { NotFoundException } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecipesService } from '../src/recipes/recipes.service';
import { PrepGuideService } from '../src/prep-guide/prep-guide.service';
import {
  RECIPE_ERROR_HIDDEN_FOR_ALLERGENS,
  RECIPE_ERROR_MESSAGES,
  RECIPE_ERROR_NOT_FOUND,
  RecipeViewer,
  visibleRecipesWhere,
} from '../src/recipes/recipe-access';
import {
  ALLERGEN_CODES,
  RECIPE_ALLERGENS,
  allergensFromRestrictions,
  canonicalAllergens,
} from '../src/recipes/allergens';
import { CreateRecipeDto } from '../src/recipes/recipes.dto';
import { asPrismaDouble } from '../src/regimes/__tests__/prisma-test-double';

type Row = Record<string, unknown>;

interface FakeRecipe {
  id: string;
  title: string;
  image_url: string | null;
  prep_time_min: number;
  cook_time_min: number;
  servings: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  ingredients: string[];
  instructions: string[];
  tags: string[];
  allergens: string[];
  allergens_declared: boolean;
  is_public: boolean;
  created_by_id: string;
  created_at: Date;
}

const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

function makeDb() {
  const users = new Map<string, { role: Role; deleted_at: Date | null }>();
  const restrictions = new Map<string, string[]>();
  const recipes: FakeRecipe[] = [];
  const saved: Array<{ id: string; user_id: string; recipe_id: string; saved_at: Date }> = [];
  const mealPlans: Array<{ client_id: string; archived_at: null; items: unknown }> = [];
  let clock = Date.UTC(2026, 9, 7, 12, 0, 0);
  const tick = () => new Date((clock += 1000));

  const matchRecipe = (r: FakeRecipe, where: unknown): boolean => {
    if (where === undefined) return true;
    if (!isRecord(where)) throw new Error('recipe where must be an object');
    return Object.entries(where).every(([k, v]) => {
      switch (k) {
        case 'OR':
          return (v as unknown[]).some((w) => matchRecipe(r, w));
        case 'AND':
          return (v as unknown[]).every((w) => matchRecipe(r, w));
        case 'NOT':
          return !matchRecipe(r, v);
        case 'id':
          if (typeof v === 'string') return r.id === v;
          if (isRecord(v) && Array.isArray(v.in)) return v.in.includes(r.id);
          throw new Error('id supports a string or { in }');
        case 'created_by_id':
          return r.created_by_id === v;
        case 'is_public':
          return r.is_public === v;
        case 'created_by': {
          const u = users.get(r.created_by_id);
          if (!isRecord(v) || !isRecord(v.role) || !Array.isArray(v.role.in) || v.deleted_at !== null) {
            throw new Error('created_by supports { role: { in }, deleted_at: null }');
          }
          return !!u && v.role.in.includes(u.role) && u.deleted_at === null;
        }
        case 'allergens':
          if (!isRecord(v) || !Array.isArray(v.hasSome) || Object.keys(v).length !== 1) {
            throw new Error('allergens supports only { hasSome: [...] }');
          }
          {
            const wanted: unknown[] = v.hasSome;
            return r.allergens.some((a) => wanted.includes(a));
          }
        default:
          throw new Error(`unsupported recipe filter key: ${k}`);
      }
    });
  };

  const withCount = (r: FakeRecipe): Row => ({
    ...r,
    _count: { saved_by: saved.filter((s) => s.recipe_id === r.id).length },
  });

  const prisma = {
    userProfile: {
      findUnique: jest.fn(async (args: { where: { user_id: string } }) => {
        const list = restrictions.get(args.where.user_id);
        return list ? { dietary_restrictions: list } : null;
      }),
    },
    recipe: {
      findMany: jest.fn(async (args: { where?: unknown; take?: number }) => {
        const rows = recipes.filter((r) => matchRecipe(r, args.where));
        return (typeof args.take === 'number' ? rows.slice(0, args.take) : rows).map(withCount);
      }),
      findFirst: jest.fn(
        async (args: { where?: unknown; select?: Record<string, boolean>; include?: unknown }) => {
          const r = recipes.find((x) => matchRecipe(x, args.where));
          if (!r) return null;
          if (args.select) {
            const all: Row = { ...r };
            const picked: Row = {};
            for (const key of Object.keys(args.select)) picked[key] = all[key];
            return picked;
          }
          return { ...withCount(r), saved_by: [] };
        },
      ),
      create: jest.fn(async (args: { data: Omit<FakeRecipe, 'id' | 'created_at'> }) => {
        const row: FakeRecipe = { ...args.data, id: `recipe-${recipes.length + 1}`, created_at: tick() };
        recipes.push(row);
        return row;
      }),
    },
    savedRecipe: {
      findMany: jest.fn(async (args: { where: { user_id: string; recipe: unknown } }) => {
        const out: Row[] = [];
        for (const s of saved) {
          const r = recipes.find((x) => x.id === s.recipe_id);
          if (s.user_id !== args.where.user_id || !r || !matchRecipe(r, args.where.recipe)) continue;
          out.push({ ...s, recipe: withCount(r) });
        }
        return out;
      }),
      upsert: jest.fn(async (args: { create: { user_id: string; recipe_id: string } }) => {
        const row = { id: `saved-${saved.length + 1}`, saved_at: tick(), ...args.create };
        saved.push(row);
        return row;
      }),
    },
    mealPlan: {
      findMany: jest.fn(async (args: { where: { client_id: string } }) =>
        mealPlans.filter((p) => p.client_id === args.where.client_id),
      ),
    },
  };

  const addRecipe = (over: Partial<FakeRecipe> & { title: string; created_by_id: string }) => {
    const r: FakeRecipe = {
      id: `recipe-${recipes.length + 1}`,
      image_url: null,
      prep_time_min: 5,
      cook_time_min: 10,
      servings: 2,
      calories: 400,
      protein: 30,
      carbs: 40,
      fat: 10,
      ingredients: ['1 cup rice'],
      instructions: ['Cook it.'],
      tags: [],
      allergens: [],
      allergens_declared: false,
      is_public: true,
      created_at: tick(),
      ...over,
    };
    recipes.push(r);
    return r;
  };

  return { prisma, users, restrictions, recipes, saved, mealPlans, addRecipe };
}

function build(clientRestrictions: string[] | null) {
  const db = makeDb();
  db.users.set('coach-a', { role: 'coach', deleted_at: null });
  db.users.set('client-a', { role: 'student', deleted_at: null });
  if (clientRestrictions) db.restrictions.set('client-a', clientRestrictions);
  const client: RecipeViewer = { id: 'client-a', role: 'student', coach_id: 'coach-a' };
  const coach: RecipeViewer = { id: 'coach-a', role: 'coach', coach_id: null };

  const satay = db.addRecipe({
    title: 'Satay chicken',
    created_by_id: 'coach-a',
    ingredients: ['2 tbsp peanut butter', '300g chicken'],
    allergens: ['peanuts'],
    allergens_declared: true,
  });
  const pesto = db.addRecipe({
    title: 'Pesto pasta',
    created_by_id: 'coach-a',
    ingredients: ['30g pine nuts', '200g pasta'],
    allergens: ['tree_nuts', 'gluten', 'dairy'],
    allergens_declared: true,
  });
  const rice = db.addRecipe({
    title: 'Plain rice bowl',
    created_by_id: 'coach-a',
    allergens: [],
    allergens_declared: true,
  });
  // Undeclared, and its text mentions peanuts: still shown (no keyword guessing).
  const noodles = db.addRecipe({
    title: 'Peanut noodles',
    created_by_id: 'coach-a',
    ingredients: ['2 tbsp peanut butter', '200g noodles'],
  });
  // The client's own recipe declaring peanuts: never hidden from its author.
  const own = db.addRecipe({
    title: 'My peanut snack',
    created_by_id: 'client-a',
    is_public: false,
    allergens: ['peanuts'],
    allergens_declared: true,
  });

  const recipes = new RecipesService(asPrismaDouble(db.prisma));
  const prep = new PrepGuideService(asPrismaDouble(db.prisma));
  return { db, client, coach, recipes, prep, r: { satay, pesto, rice, noodles, own } };
}

const titles = (rows: Array<{ title: unknown }>) => rows.map((x) => String(x.title)).sort();

async function expectHidden(p: Promise<unknown>) {
  const err = await p.then(
    () => {
      throw new Error('expected RECIPE_HIDDEN_FOR_ALLERGENS');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NotFoundException);
  expect((err as NotFoundException).getResponse()).toEqual({
    code: RECIPE_ERROR_HIDDEN_FOR_ALLERGENS,
    error: RECIPE_ERROR_HIDDEN_FOR_ALLERGENS,
    message: RECIPE_ERROR_MESSAGES[RECIPE_ERROR_HIDDEN_FOR_ALLERGENS],
  });
}

describe('the one allergen list and the saved-answer lookup', () => {
  it('lists nine allergens with unique codes and labels', () => {
    expect(ALLERGEN_CODES).toEqual([
      'peanuts',
      'tree_nuts',
      'dairy',
      'eggs',
      'fish',
      'shellfish',
      'soy',
      'sesame',
      'gluten',
    ]);
    expect(new Set(RECIPE_ALLERGENS.map((a) => a.label)).size).toBe(RECIPE_ALLERGENS.length);
  });

  it.each([
    [['Nut Allergy'], ['peanuts', 'tree_nuts']],
    [['Peanut Allergy'], ['peanuts']],
    [['Shellfish Allergy', 'Egg Allergy'], ['eggs', 'shellfish']],
    [['Dairy Allergy', 'Gluten-Free'], ['dairy', 'gluten']],
    [['No Fish'], ['fish']],
    [['Soy', 'Sesame'], ['soy', 'sesame']],
    [['nuts', 'dairy', 'gluten', 'shellfish', 'eggs', 'soy'], ['peanuts', 'tree_nuts', 'dairy', 'eggs', 'shellfish', 'soy', 'gluten']],
    [['  GLUTEN free ', 'tree_nuts', 'Sesame'], ['tree_nuts', 'sesame', 'gluten']],
  ])('maps the saved answers %j to %j (both app vocabularies, exact lookup)', (saved, codes) => {
    expect(allergensFromRestrictions(saved)).toEqual(codes);
  });

  it.each([
    'Vegetarian',
    'Vegan',
    'Pescatarian',
    'No Pork',
    'No Spicy',
    'pork',
    'halal',
    'other',
    'I love peanut butter',
    'nut',
    'constructor',
    '__proto__',
  ])('maps %j to nothing (diets and free text never become an allergen)', (answer) => {
    expect(allergensFromRestrictions([answer])).toEqual([]);
  });

  it('treats a missing profile or list as no allergens', () => {
    expect(allergensFromRestrictions(null)).toEqual([]);
    expect(allergensFromRestrictions(undefined)).toEqual([]);
  });

  it('stores declared codes deduplicated, in list order', () => {
    expect(canonicalAllergens(['gluten', 'peanuts', 'gluten'])).toEqual(['peanuts', 'gluten']);
    expect(canonicalAllergens(undefined)).toEqual([]);
  });
});

describe('visibleRecipesWhere with saved allergens', () => {
  it('leaves out shared recipes declaring any saved allergen, never the viewer own ones', () => {
    expect(
      visibleRecipesWhere({ id: 'c1', role: 'student', coach_id: 'k1' }, ['peanuts', 'tree_nuts']),
    ).toEqual({
      OR: [
        { created_by_id: 'c1' },
        {
          is_public: true,
          created_by_id: 'k1',
          created_by: { role: { in: ['coach', 'owner'] }, deleted_at: null },
          NOT: { allergens: { hasSome: ['peanuts', 'tree_nuts'] } },
        },
      ],
    });
  });

  it('is unchanged when nothing is saved', () => {
    expect(visibleRecipesWhere({ id: 'c1', role: 'student', coach_id: 'k1' }, [])).toEqual(
      visibleRecipesWhere({ id: 'c1', role: 'student', coach_id: 'k1' }),
    );
  });
});

describe('a client library hides a recipe only on a declared match', () => {
  it('a nut-allergic client does not see shared recipes declaring peanuts or tree nuts', async () => {
    const { recipes, client } = build(['Nut Allergy']);
    expect(titles(await recipes.list(client))).toEqual([
      'My peanut snack',
      'Peanut noodles',
      'Plain rice bowl',
    ]);
  });

  it('an undeclared recipe stays visible and says it is undeclared, whatever its text says', async () => {
    const { recipes, client, r } = build(['Nut Allergy']);
    const listed = (await recipes.list(client)).find((x) => x.id === r.noodles.id);
    expect(listed).toMatchObject({ allergens: [], allergens_declared: false });
    const rice = (await recipes.list(client)).find((x) => x.id === r.rice.id);
    expect(rice).toMatchObject({ allergens: [], allergens_declared: true });
  });

  it('the consultation answer "nuts" hides the same recipes as the "Nut Allergy" chip', async () => {
    const chip = build(['Nut Allergy']);
    const slug = build(['nuts']);
    expect(titles(await slug.recipes.list(slug.client))).toEqual(
      titles(await chip.recipes.list(chip.client)),
    );
  });

  // ALLERGY-CHOICES-131: the app saves its Soy and Sesame chips as these exact strings.
  it.each([
    [['Soy'], 'Miso tofu', ['soy']],
    [['Sesame'], 'Sesame noodles', ['sesame']],
    [['sesame'], 'Tahini bowl', ['sesame']],
    [['Fish'], 'Salmon bowl', ['fish']],
  ])('the saved answer %j hides a shared recipe declaring it', async (saved, title, allergens) => {
    const shown = build(null);
    shown.db.addRecipe({ title, created_by_id: 'coach-a', allergens, allergens_declared: true });
    expect(titles(await shown.recipes.list(shown.client))).toContain(title);

    const { recipes, client, db } = build(saved);
    db.addRecipe({ title, created_by_id: 'coach-a', allergens, allergens_declared: true });
    const seen = titles(await recipes.list(client));
    expect(seen).not.toContain(title);
    expect(seen).toContain('Satay chicken');
  });

  it('only the matching allergen hides: a gluten-free client loses the pesto, keeps the satay', async () => {
    const { recipes, client } = build(['Gluten-Free']);
    const seen = titles(await recipes.list(client));
    expect(seen).toContain('Satay chicken');
    expect(seen).not.toContain('Pesto pasta');
  });

  it('a client with no saved allergies, or only diets, sees every recipe as before', async () => {
    for (const saved of [null, [], ['Vegetarian', 'No Pork']]) {
      const { recipes, client } = build(saved);
      expect(await recipes.list(client)).toHaveLength(5);
    }
  });

  it('the coach who wrote the recipes still sees all of them', async () => {
    const { recipes, coach, db } = build(['Nut Allergy']);
    db.restrictions.set('coach-a', ['Nut Allergy']);
    expect(await recipes.list(coach)).toHaveLength(4);
  });

  it('a saved recipe that declares a saved allergen leaves the saved list too', async () => {
    const { recipes, client, db, r } = build(null);
    await recipes.saveRecipe(r.satay.id, client);
    await recipes.saveRecipe(r.rice.id, client);
    expect(titles(await recipes.listSaved(client))).toEqual(['Plain rice bowl', 'Satay chicken']);
    db.restrictions.set('client-a', ['Peanut Allergy']);
    expect(titles(await recipes.listSaved(client))).toEqual(['Plain rice bowl']);
  });

  it('opening or saving a hidden recipe returns 404 RECIPE_HIDDEN_FOR_ALLERGENS and writes nothing', async () => {
    const { recipes, client, db, r } = build(['Peanut Allergy']);
    await expectHidden(recipes.getById(r.satay.id, client));
    await expectHidden(recipes.saveRecipe(r.satay.id, client));
    expect(db.saved).toEqual([]);
    expect((await recipes.getById(r.noodles.id, client)).allergens_declared).toBe(false);
    expect((await recipes.getById(r.own.id, client)).title).toBe('My peanut snack');
  });

  it('a recipe of another tenant is still a plain 404 RECIPE_NOT_FOUND', async () => {
    const { recipes, db, r } = build(['Peanut Allergy']);
    db.users.set('client-b', { role: 'student', deleted_at: null });
    const other: RecipeViewer = { id: 'client-b', role: 'student', coach_id: 'coach-b' };
    const err = (await recipes.getById(r.satay.id, other).catch((e: unknown) => e)) as NotFoundException;
    expect(err.getResponse()).toMatchObject({ code: RECIPE_ERROR_NOT_FOUND });
  });

  it('the prep guide leaves out a plan recipe that declares a saved allergen, with its ingredients', async () => {
    const { prep, client, db, r } = build(['Peanut Allergy']);
    db.mealPlans.push({
      client_id: 'client-a',
      archived_at: null,
      items: [{ recipe_id: r.satay.id }, { recipe_id: r.rice.id }],
    });
    const out = await prep.getWeeklyPrepGuide(client, '2026-10-05');
    expect(out.recipes.map((x) => x.title)).toEqual(['Plain rice bowl']);
    expect(out.recipes[0]).toMatchObject({ allergens: [], allergens_declared: true });
    expect(out.aggregated_ingredients.map((i) => i.name)).not.toContain('peanut butter');
  });
});

describe('authors declare allergens on create', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    title: 'Overnight oats',
    prepTimeMin: 5,
    cookTimeMin: 0,
    servings: 1,
    calories: 350,
    protein: 20,
    carbs: 45,
    fat: 9,
    ingredients: ['1 cup oats', '1 cup milk'],
    instructions: ['Mix and chill.'],
    tags: ['breakfast'],
    ...over,
  });
  const PIPE = { whitelist: true, forbidNonWhitelisted: true };
  const errorsFor = async (over: Record<string, unknown>) =>
    (await validate(plainToInstance(CreateRecipeDto, body(over)), PIPE)).map((e) => e.property);

  it('stores the declared list and the confirmation; without them the recipe is undeclared', async () => {
    const { recipes, coach, db } = build(null);
    const declared = await recipes.create(
      coach,
      plainToInstance(CreateRecipeDto, body({ allergens: ['gluten', 'dairy'], allergensDeclared: true })),
    );
    expect(declared).toMatchObject({ allergens: ['dairy', 'gluten'], allergens_declared: true });
    const none = await recipes.create(
      coach,
      plainToInstance(CreateRecipeDto, body({ allergens: [], allergensDeclared: true })),
    );
    expect(none).toMatchObject({ allergens: [], allergens_declared: true });
    const old = await recipes.create(coach, plainToInstance(CreateRecipeDto, body()));
    expect(old).toMatchObject({ allergens: [], allergens_declared: false });
    expect(db.prisma.recipe.create).toHaveBeenCalledTimes(3);
  });

  it('accepts the old body, a declared list and an explicit "contains none"', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(await errorsFor({ allergens: ['peanuts', 'sesame'], allergensDeclared: true })).toEqual([]);
    expect(await errorsFor({ allergens: [], allergensDeclared: true })).toEqual([]);
  });

  it('refuses unknown codes, repeats, and a confirmation without a list', async () => {
    expect(await errorsFor({ allergens: ['nuts'] })).toEqual(['allergens']);
    expect(await errorsFor({ allergens: ['peanuts', 'peanuts'] })).toEqual(['allergens']);
    expect(await errorsFor({ allergens: 'peanuts' })).toEqual(['allergens']);
    expect(await errorsFor({ allergensDeclared: true })).toEqual(['allergens']);
    expect(await errorsFor({ allergensDeclared: 'yes' })).toEqual(['allergensDeclared']);
  });
});

describe('GET /recipes/allergens', () => {
  it('serves the one list and the viewer saved allergens that hide recipes', async () => {
    const { recipes, client } = build(['Nut Allergy', 'Vegetarian']);
    expect(await recipes.allergenGuide(client)).toEqual({
      allergens: RECIPE_ALLERGENS.map((a) => ({ code: a.code, label: a.label })),
      your_allergens: ['peanuts', 'tree_nuts'],
    });
  });

  it('says nothing is hidden for a viewer with no saved allergies', async () => {
    const { recipes, client } = build(null);
    expect((await recipes.allergenGuide(client)).your_allergens).toEqual([]);
  });
});
