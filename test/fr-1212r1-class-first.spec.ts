/**
 * FR-1212R1 (fix round 1 of b#1212), class-first tests by agent 195 next to the auditors' B-TESTs. Each block covers
 * more members of a class LS-1212 / LO-1212 found one or two members of:
 *   S1 gap lookup (LS-1212 B1, LO-1212 B1): the catalog answers alone only when it holds a row named for the food;
 *      a catalog of dishes made with it still asks USDA.
 *   S2 brand in a USDA name (LO-1212 B2): a loaded or live USDA row with a brand written in capitals is a brand,
 *      not a basic food; USDA's own capitals (NFS, USDA, BBQ) are not a brand.
 *   S3 dish first (LO-1212 B3): a row whose first comma part holds a typed word comes before a dish that holds the
 *      words only later; USDA's "Babyfood" group is not the food's group.
 *   D1 data (LS-1212 B2, LO-1212 C1): no core number is written for a food USDA did not measure it for; no food in
 *      the data file has the name of another food in it or of a built-in food.
 * The catalog rows are the ones the shared word search returns (as in the B-TESTs): rows holding every typed word as a
 * whole word, the name's first part holding the first word first, built-in foods next, shorter names next, at most
 * LOCAL_SEARCH_TAKE. USDA answers are recorded ones (test/fixtures) or USDA-style test rows.
 */
import { Prisma } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FoodService, LOCAL_SEARCH_TAKE } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';
import { parseUsdaFoods, usdaFoodRow } from '../scripts/load-usda-foods';
import { parseSeedFoods, seedFoodRow } from '../scripts/seed-built-in-foods';

const ROOT = join(__dirname, '..');
const stub = <T>(v: unknown) => v as T;
const fixture = (name: string): unknown[] => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const loaded = parseUsdaFoods(readFileSync(join(ROOT, 'prisma/data/usda-foods.jsonl.gz')));
const loadedRows = loaded.map((f) => ({ id: `usda-row-${f.fdc_id}`, ...usdaFoodRow(f) }));
const builtInRows = parseSeedFoods(readFileSync(join(ROOT, 'prisma/data/seed-foods.json'), 'utf8')).map((f, i) => ({
  id: `built-in-${i}`, ...seedFoodRow(f), sodium_mg: null, image_url: null,
}));

function catalogRows(typed: string) {
  const ws = typed.toLowerCase().split(/\s+/);
  const has = ws.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}%])${w.replace(/s$/, '')}(e?s)?([^\\p{L}\\p{N}%]|$)`, 'iu'));
  return [...loadedRows, ...builtInRows]
    .filter((r) => has.every((h) => h.test(r.name)))
    .map((r) => ({ r, lead: has[0].test(r.name.split(',')[0]) ? 0 : 1, seed: r.tags.includes('seed:common-foods') ? 0 : 1 }))
    .sort((a, b) => a.lead - b.lead || a.seed - b.seed || a.r.name.length - b.r.name.length || a.r.name.localeCompare(b.r.name))
    .slice(0, LOCAL_SEARCH_TAKE)
    .map(({ r }) => ({ ...r, word_match: 0 }));
}

const env = process.env.USDA_API_KEY;
beforeEach(() => {
  process.env.USDA_API_KEY = 'fixture-only';
});
afterEach(() => {
  jest.restoreAllMocks();
  if (env === undefined) delete process.env.USDA_API_KEY;
  else process.env.USDA_API_KEY = env;
});

/** USDA answers `foods` (Open Food Facts nothing), or both fail when `foods` is null. Returns the USDA call count. */
function upstream(foods: unknown[] | null) {
  const spy = jest.spyOn(global, 'fetch');
  if (foods === null) spy.mockRejectedValue(new Error('USDA and Open Food Facts stubbed to fail'));
  else {
    spy.mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        status: 200,
        json: async () => (new URL(String(url)).hostname === 'api.nal.usda.gov' ? { foods } : { products: [] }),
      }),
    );
  }
  return () => spy.mock.calls.filter(([url]) => new URL(String(url)).hostname === 'api.nal.usda.gov').length;
}

async function search(typed: string, rows: unknown[]) {
  const prisma = {
    foodItem: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      Prisma.sql(strings, ...values).sql.includes('"created_by_user_id" IS NULL') ? rows : [],
    ),
  };
  return (await new FoodService(stub<PrismaService>(prisma)).search(typed, 25, 'member-a')).results;
}

let fdc = 990000;
const usda = (description: string, dataType: string) => ({
  fdcId: ++fdc, description, dataType, foodCategory: 'Test category',
  foodNutrients: [{ nutrientName: 'Energy', unitName: 'KCAL', value: 100 + (fdc % 50) }],
});

describe('S1: the catalog answers alone only when it holds a row named for the food', () => {
  it.each([
    // [typed, recorded USDA answer, first row must match]
    ['oatmeal', fixture('lo-1198-usda-oatmeal.json'), /^oatmeal\b/i],
    ['2% milk', [usda('Milk, reduced fat, fluid, 2% milkfat', 'SR Legacy')], /^milk\b/i],
    ['green beans', [usda('Beans, snap, green, cooked, boiled', 'SR Legacy')], /^beans\b/i],
  ])('%s: a catalog of rows made with the food still asks USDA', async (typed, answer, first) => {
    const rows = catalogRows(typed);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const usdaCalls = upstream(answer);
    const results = await search(typed, rows);
    expect(usdaCalls()).toBe(1);
    expect(results[0].name).toMatch(first);
  });

  it.each(['eggs', 'yogurt', 'bread', 'apple', 'rice', 'banana', 'chicken breast', 'peanut butter'])(
    '%s: a catalog holding the food itself answers alone (no USDA call)',
    async (typed) => {
      const usdaCalls = upstream([]);
      const results = await search(typed, catalogRows(typed));
      expect(usdaCalls()).toBe(0);
      expect(results.length).toBeGreaterThan(0);
    },
  );
});

const CAPITALS_BRAND = /\b(?!(?:NFS|NS|USDA|NFSMI|BBQ)\b)[A-Z][A-Z'&.-]{2,}/;

describe('S2: a brand written in capitals in a USDA name ranks as a brand', () => {
  it.each(['yogurt', 'cereal', 'greek yogurt', 'granola bar', 'ice cream', 'cheese'])(
    '%s (loaded rows): the first row carries no brand in its name',
    async (typed) => {
      upstream(null);
      const results = await search(typed, catalogRows(typed));
      expect(results[0].name).not.toMatch(CAPITALS_BRAND);
    },
  );

  it('yogurt (live USDA rows): "Yogurt, Greek, plain, CHOBANI" comes after an unbranded yogurt', async () => {
    upstream([usda('Yogurt, Greek, whole, plain, CHOBANI', 'Foundation'), usda('Yogurt, plain, low fat', 'Survey (FNDDS)')]);
    const names = (await search('yogurt', [])).map((r) => r.name);
    expect(names.indexOf('Yogurt, plain, low fat')).toBeLessThan(names.indexOf('Yogurt, Greek, whole, plain, CHOBANI'));
  });

  it.each([
    ['pears', "Pears, raw, bartlett (Includes foods for USDA's Food Distribution Program)"],
    ['dark chocolate candies', 'Candies, chocolate, dark, NFS (45-59% cacao solids 90%)'],
    ['chicken bbq', 'Chicken, broiler, rotisserie, BBQ, drumstick, meat only'],
  ])('%s: USDA\'s own capitals (%s) are not a brand', async (typed, plain) => {
    // A basic row ranks above an unbranded survey row of the same match; a row read as a brand would rank below it.
    upstream([usda(`${plain} x`, 'Survey (FNDDS)'), usda(plain, 'SR Legacy')]);
    const names = (await search(typed, [])).map((r) => r.name);
    expect(names[0]).toBe(plain);
  });
});

describe('S3: a dish made with the food does not come before the food', () => {
  it.each([
    // [typed, first row must match, first row must not match]
    ['2% milk', /^milk\b/i, /prepared with/i],
    ['1% milk', /^milk\b/i, /prepared with/i],
    ['green beans', /^beans\b/i, /^babyfood/i],
  ])('%s: the food first (catalog alone, upstream failing)', async (typed, first, not) => {
    upstream(null);
    const results = await search(typed, catalogRows(typed));
    expect(results[0].name).toMatch(first);
    expect(results[0].name).not.toMatch(not);
  });

  it.each([
    ['green beans', 'Babyfood, green beans, dices, toddler', 'Beans, snap, green, raw'],
    ['mixed vegetables', 'Babyfood, mixed vegetables, strained', 'Vegetables, mixed, frozen, unprepared'],
  ])('%s (live USDA rows): %s comes after %s', async (typed, baby, food) => {
    upstream([usda(baby, 'SR Legacy'), usda(food, 'SR Legacy')]);
    const names = (await search(typed, [])).map((r) => r.name);
    expect(names.indexOf(food)).toBeLessThan(names.indexOf(baby));
  });
});

describe('D1: the data file holds only measured core numbers and one food per name', () => {
  const FIXTURE = join(ROOT, 'test/fixtures/usda-foods');
  const measured = (release: string) => {
    const lines = readFileSync(join(FIXTURE, release, 'food_nutrient.csv'), 'utf8').split('\n').slice(1).filter(Boolean);
    const out = new Map<number, Set<string>>();
    for (const line of lines) {
      const [, fdcId, nutrientId, amount] = line.split(',').map((c) => c.replace(/"/g, ''));
      if (amount.trim()) out.set(Number(fdcId), (out.get(Number(fdcId)) ?? new Set()).add(nutrientId));
    }
    return out;
  };
  let dir: string;
  let built: ReturnType<typeof parseUsdaFoods>;
  let header: { skipped: { fdc_id: string; why: string }[] };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr1212r1-'));
    const out = join(dir, 'catalog.gz');
    const result = spawnSync('python3', ['scripts/usda-foods/build.py', join(FIXTURE, 'sr-legacy'), join(FIXTURE, 'foundation'),
      join(ROOT, 'prisma/data/usda-built-in-map.json'), out], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
    built = parseUsdaFoods(readFileSync(out));
    header = JSON.parse(require('node:zlib').gunzipSync(readFileSync(out)).toString('utf8').split('\n')[0]);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['protein_g', '1003'],
    ['fat_g', '1004'],
    ['carbs_g', '1005'],
  ] as const)('every built food has a USDA figure for %s (nutrient %s); a food without one is left out with the reason', (field, id) => {
    const figures = new Map([...measured('sr-legacy'), ...measured('foundation')]);
    for (const food of built) expect([food.fdc_id, field, figures.get(food.fdc_id)?.has(id)]).toEqual([food.fdc_id, field, true]);
    const lacking = [...figures].filter(([, ids]) => !ids.has(id)).map(([fdcId]) => fdcId);
    expect(built.filter((food) => lacking.includes(food.fdc_id))).toEqual([]);
    expect(header.skipped.some((s) => /no USDA figure for/.test(s.why))).toBe(true);
  });

  it('the shipped data file holds no two foods with one name and no food with a built-in food\'s name', () => {
    const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const names = loaded.map((f) => fold(f.name));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const builtIn = new Set(builtInRows.map((r) => fold(r.name)));
    expect(loaded.filter((f) => builtIn.has(fold(f.name))).map((f) => f.name)).toEqual([]);
  });
});
