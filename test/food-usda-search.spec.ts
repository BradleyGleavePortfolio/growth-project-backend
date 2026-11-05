// FOOD-USDA-BE (U3, U4, U6): the catalog's word search, catalog first, without a database. The live proof over the
// real 7,980 loaded USDA rows (the seven foods, chick, the injection cases) is test/rls/food-usda-release-rls.spec.ts.
//   - the typed text reaches SQL only as bound parameters, never inside the SQL text, whatever it holds;
//   - the words and tsquery texts hold letters, digits, " & " and ":*" only;
//   - catalog first: with LOCAL_ENOUGH_WHOLE whole-word catalog matches, USDA and Open Food Facts are not asked;
//     with fewer (a brand the catalog lacks), both are;
//   - the cache key moved past b#1198's v2;
//   - the fewer-than-2-characters list leaves the loaded USDA rows (shared + basic-food) out.
import { Prisma } from '@prisma/client';
import {
  FoodService,
  LOCAL_ENOUGH_WHOLE,
  LOCAL_SEARCH_TAKE,
  foodSearchWords,
  foodWordQueries,
} from '../src/food/food.service';
import { carbsFor, fatFor } from './support/food-true-numbers';

const VIEWER = '00000000-0000-0000-0000-000000000193';
const INJECTIONS = [
  `'; DROP TABLE "FoodItem"; --`,
  `"chicken" breast`,
  'chicken:* | !egg',
  'mac & cheese',
  'back\\slash milk\\',
  '🍓 strawberries 🍓',
  `o'brien's potatoes`,
  '2% milk',
  '80/20 beef',
  '%_%',
];

function row(name: string, word_match: number, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${name}`, name, brand_or_restaurant: null, category: 'generic', serving_description: '100 g',
    serving_size_grams: 100, calories: 100, protein_g: 0, carbs_g: carbsFor(100), fat_g: fatFor(100), fiber_g: null, sugar_g: null,
    sodium_mg: null, tags: ['basic-food'], search_aliases: [], image_url: null, nutrient_basis: 'PER_100G', word_match,
    ...extra,
  };
}

function setup(catalogRows: ReturnType<typeof row>[]) {
  const sent: Prisma.Sql[] = [];
  const prisma = {
    foodItem: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      sent.push(sql);
      return sql.sql.includes('"created_by_user_id" IS NULL') ? catalogRows : [];
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new FoodService(prisma as any);
  return { prisma, service, sent };
}

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  process.env.USDA_API_KEY = 'test-key';
  // USDA and Open Food Facts fail: whatever a search finds comes from the catalog.
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('USDA and Open Food Facts stubbed to fail'));
});
afterEach(() => fetchSpy.mockRestore());

describe('FOOD-USDA-BE: the words of a typed search', () => {
  it.each(INJECTIONS)('%s: words and tsquery texts hold letters, digits, " & " and ":*" only', (typed) => {
    for (const w of foodSearchWords(typed)) expect(w).toMatch(/^[\p{L}\p{N}]+$/u);
    const { whole, typing } = foodWordQueries(typed);
    expect(whole).toMatch(/^([\p{L}\p{N}]+( & [\p{L}\p{N}]+)*)?$/u);
    expect(typing).toMatch(/^([\p{L}\p{N}]+( & [\p{L}\p{N}]+)*:\*)?$/u);
  });

  it('every word, any order, the last as the start of a word', () => {
    expect(foodWordQueries('Chicken BREAST')).toEqual({ whole: 'chicken & breast', typing: 'chicken & breast:*' });
    expect(foodWordQueries('chick').typing).toBe('chick:*');
    expect(foodSearchWords('a b c d e f g h i j')).toHaveLength(8);
  });

  it.each(INJECTIONS)('%s: the typed text reaches the database only as bound parameters', async (typed) => {
    // The SQL text sent for the typed search is the very text sent for a plain word: the typed text changes only the
    // bound values.
    const typedRun = setup([]);
    await typedRun.service.search(typed, 20, VIEWER);
    const plainRun = setup([]);
    await plainRun.service.search('zucchini', 20, VIEWER);
    expect(typedRun.sent.length).toBe(2); // the viewer's own foods and the shared catalog
    expect(typedRun.sent.map((s) => s.sql)).toEqual(plainRun.sent.map((s) => s.sql));
    for (const sql of typedRun.sent) {
      expect(sql.sql).not.toContain('DROP TABLE');
      expect(sql.sql).not.toContain('similarity(');
    }
  });
});

describe('FOOD-USDA-BE: catalog first (U4)', () => {
  it(`${LOCAL_ENOUGH_WHOLE} whole-word catalog matches answer alone: USDA and Open Food Facts are not asked`, async () => {
    const rows = Array.from({ length: LOCAL_ENOUGH_WHOLE }, (_, i) => row(`Egg, whole, raw ${i}`, 0));
    const { service, prisma } = setup(rows);
    const res = await service.search('eggs', 20, VIEWER);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.results.map((r) => r.name)).toEqual(expect.arrayContaining(rows.map((r) => r.name)));
    const shared = prisma.$queryRaw.mock.calls.map((c) => Prisma.sql(c[0], ...c.slice(1))).find((s) => s.sql.includes('IS NULL'))!;
    expect(shared.values).toContain(LOCAL_SEARCH_TAKE);
  });

  it('fewer whole-word matches (a brand the catalog lacks) still asks USDA and Open Food Facts', async () => {
    const { service } = setup([row('Yogurt, Greek, plain', 2)]);
    const res = await service.search('chobani', 20, VIEWER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('https://api.nal.usda.gov/fdc/v1/foods/search?query=chobani'))).toBe(true);
    expect(urls.some((u) => u.includes('openfoodfacts'))).toBe(true);
    expect(res.results.map((r) => r.name)).toEqual(['Yogurt, Greek, plain']);
  });

  it('a catalog query the database refuses still asks USDA and Open Food Facts', async () => {
    const { service, prisma } = setup([]);
    prisma.$queryRaw.mockRejectedValue(new Error('database down'));
    await service.search('eggs', 20, VIEWER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('the shared answer is cached under food:search:v4: (FOOD-TRUE-BE), past v3 and b#1198\'s v2', async () => {
    // FR-1212R1: rows named for the food ("Egg, whole, raw"), so the catalog answers alone (LS-1212 B1).
    const { service } = setup(Array.from({ length: LOCAL_ENOUGH_WHOLE }, (_, i) => row(`Egg, whole, raw ${i}`, 0)));
    await service.search('eggs', 20, VIEWER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keys = [...(service as any).memoryCache.keys()] as string[];
    expect(keys.length).toBe(1);
    expect(keys[0].startsWith('food:search:v4:')).toBe(true);
  });
});

describe('FOOD-USDA-BE: the fewer-than-2-characters list (U6)', () => {
  it('lists built-in foods and the viewer\'s own, never the shared USDA rows', async () => {
    const { service, prisma } = setup([]);
    await service.search('', 20, VIEWER);
    await service.search('e', 20, VIEWER);
    expect(prisma.foodItem.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of prisma.foodItem.findMany.mock.calls) {
      expect(JSON.stringify(args.where)).toContain(JSON.stringify({ NOT: { created_by_user_id: null, tags: { has: 'basic-food' } } }));
      expect(JSON.stringify(args.where)).toContain(VIEWER);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
