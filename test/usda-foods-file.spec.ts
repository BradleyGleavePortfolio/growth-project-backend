// FOOD-USDA-BE (U1): the USDA foods file release step 6 writes from (prisma/data/usda-foods.jsonl.gz) is checked in CI
// without downloading anything. test/fixtures/usda-foods is a small cut of USDA's two CSV downloads (made by
// scripts/usda-foods/cut-fixture.py: the CSV rows of 25 foods, unchanged). build.py is run on that cut here, and every
// food it builds must be, field for field, the row the committed file holds for it; so every number in the file comes
// from USDA's files by the committed script. Plus the file's own description (download URLs, sha256, row counts), the
// built-in map checked by numbers, and the row the release step writes (a food with no USDA portion is 100 g).
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { HUNDRED_GRAMS, parseUsdaFoods, usdaFoodRow, type UsdaFood } from '../scripts/load-usda-foods';
import { parseSeedFoods } from '../scripts/seed-built-in-foods';

const ROOT = join(__dirname, '..');
const DATA_FILE = join(ROOT, 'prisma/data/usda-foods.jsonl.gz');
const MAP_FILE = join(ROOT, 'prisma/data/usda-built-in-map.json');
const FIXTURE = join(ROOT, 'test/fixtures/usda-foods');
const gz = readFileSync(DATA_FILE);
const foods = parseUsdaFoods(gz);
const byId = new Map(foods.map((f) => [f.fdc_id, f]));

interface LeftOut {
  fdc_id: number;
  name: string;
  built_in: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}
interface Header {
  files: { data_type: string; url: string; sha256: string | null; foods: number }[];
  foods: number;
  with_portion: number;
  left_out_built_in: LeftOut[];
  left_out_same_name: { fdc_id: number; name: string; kept: string }[];
  skipped: { fdc_id: string; why: string }[];
  carbs_below_zero_stored_as_0: { fdc_id: number; usda_carbs_g: number }[];
}
const header = JSON.parse(gunzipSync(gz).toString('utf8').split('\n')[0]) as Header;

function buildFixture(): { header: Header; foods: UsdaFood[] } {
  const out = join(mkdtempSync(join(tmpdir(), 'usda-fixture-')), 'fixture.jsonl.gz');
  const r = spawnSync(
    'python3',
    ['scripts/usda-foods/build.py', join(FIXTURE, 'sr-legacy'), join(FIXTURE, 'foundation'), MAP_FILE, out],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`build.py on the fixture failed: ${r.stderr}${r.error?.message ?? ''}`);
  const built = readFileSync(out);
  return {
    header: JSON.parse(gunzipSync(built).toString('utf8').split('\n')[0]) as Header,
    foods: parseUsdaFoods(built),
  };
}

const csvIds = (file: string) =>
  readFileSync(join(FIXTURE, file), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => Number(JSON.parse(l.split(',')[0])));

describe('prisma/data/usda-foods.jsonl.gz — the USDA SR Legacy and Foundation foods (U1)', () => {
  it('names both USDA downloads with their sha256 and food counts, and holds the count it says', () => {
    expect(header.files.map((f) => [f.data_type, f.url])).toEqual([
      ['SR Legacy', 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip'],
      ['Foundation', 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip'],
    ]);
    expect(header.files.map((f) => f.sha256)).toEqual([
      'b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0',
      '70457ee9d9342f43bda2010318c85f04210c689fdeb9cd2da4c513b0e8dbc655',
    ]);
    // FR-1212R1: Foundation 323 less Salt, table, iodized (no protein, carbohydrate or fat figure, LS-1212 B2); in
    // the file, Foundation less the 75 foods named like a built-in food or an SR Legacy food (LO-1212 C1).
    expect(header.files.map((f) => f.foods)).toEqual([7793, 322]);
    expect(foods).toHaveLength(7980);
    expect(header.foods).toBe(7980);
    // SR Legacy less the foods a built-in food stands for, plus Foundation less the foods named like another.
    expect(foods.filter((f) => f.data_type === 'SR Legacy')).toHaveLength(7793 - header.left_out_built_in.length);
    expect(foods.filter((f) => f.data_type === 'Foundation')).toHaveLength(322 - header.left_out_same_name.length);
    expect(header.left_out_same_name).toHaveLength(75);
    expect(foods.filter((f) => f.serving_description !== null)).toHaveLength(header.with_portion);
  });

  it('every food build.py makes from the fixture cut is the row the file holds, field for field', () => {
    const fixture = buildFixture();
    const sr = csvIds('sr-legacy/sr_legacy_food.csv');
    const fd = csvIds('foundation/foundation_food.csv');
    expect(sr.length + fd.length).toBeGreaterThanOrEqual(20);
    // FR-1212R1: 19, as Salt, table, iodized (Foundation 746775, no protein, carbohydrate or fat figure) is left out.
    expect(fixture.foods.length).toBeGreaterThanOrEqual(19);
    expect(new Set(fixture.foods.map((f) => f.data_type))).toEqual(new Set(['SR Legacy', 'Foundation']));
    // FR-1212R1: a food the full build leaves out for its name (its twin is outside the cut) is not in the file.
    const sameName = new Set(header.left_out_same_name.map((l) => l.fdc_id));
    for (const f of fixture.foods) expect([f.fdc_id, byId.get(f.fdc_id)]).toEqual([f.fdc_id, sameName.has(f.fdc_id) ? undefined : f]);
    // The cut covers each path: no portion, energy from Atwater General, carbohydrate below zero, no energy at all,
    // no protein, carbohydrate or fat figure (FR-1212R1), and an SR Legacy food a built-in food stands for.
    expect(fixture.foods.some((f) => f.serving_description === null)).toBe(true);
    expect(fixture.foods.some((f) => f.energy_from === '2047')).toBe(true);
    expect(fixture.header.carbs_below_zero_stored_as_0.length).toBeGreaterThan(0);
    for (const z of fixture.header.carbs_below_zero_stored_as_0) expect(byId.get(z.fdc_id)?.carbs_g).toBe(0);
    expect(fixture.header.skipped.length).toBeGreaterThan(0);
    expect(fixture.header.skipped.some((s) => /^no USDA figure for /.test(s.why))).toBe(true);
    for (const s of fixture.header.skipped) expect(byId.has(Number(s.fdc_id))).toBe(false);
    expect(fixture.header.left_out_built_in.length).toBeGreaterThan(0);
    for (const l of fixture.header.left_out_built_in) {
      expect(byId.has(l.fdc_id)).toBe(false);
      expect(header.left_out_built_in).toContainEqual(l);
    }
  });

  it('the built-in map: one entry per built-in food, each pair within 2 kcal and 0.5 g of protein, carbs and fat', () => {
    const seed = parseSeedFoods(readFileSync(join(ROOT, 'prisma/data/seed-foods.json'), 'utf8'));
    const map = JSON.parse(readFileSync(MAP_FILE, 'utf8')) as { foods: { built_in: string; sr_legacy_fdc_id: number | null }[] };
    expect(map.foods.map((m) => m.built_in)).toEqual(seed.map((f) => f.name));
    const mapped = map.foods.filter((m) => m.sr_legacy_fdc_id !== null);
    expect(header.left_out_built_in.map((l) => [l.fdc_id, l.built_in]).sort()).toEqual(
      mapped.map((m) => [m.sr_legacy_fdc_id, m.built_in]).sort(),
    );
    const off: string[] = [];
    for (const l of header.left_out_built_in) {
      const s = seed.find((f) => f.name === l.built_in)!;
      const close =
        Math.abs(s.calories - l.calories) <= 2 &&
        Math.abs(s.protein_g - l.protein_g) <= 0.5 &&
        Math.abs(s.carbs_g - l.carbs_g) <= 0.5 &&
        Math.abs(s.fat_g - l.fat_g) <= 0.5;
      if (!close) off.push(`${l.built_in} vs ${l.fdc_id} ${l.name}`);
    }
    expect(off).toEqual([]);
  });

  it('the row step 6 writes is the live import row; a food with no USDA portion is 100 g', () => {
    const none = foods.find((f) => f.serving_description === null)!;
    const row = usdaFoodRow(none);
    expect([row.serving_description, row.serving_size_grams]).toEqual([HUNDRED_GRAMS, 100]);
    expect(row).toMatchObject({ brand_or_restaurant: null, category: 'generic', nutrient_basis: 'PER_100G', search_aliases: [] });
    expect(row.tags).toEqual([`usda:${none.fdc_id}`, `category:${none.usda_category}`, 'basic-food']);
    const egg = byId.get(172187)!; // Egg, whole, cooked, scrambled: USDA's first portion
    expect(egg.name).toBe('Egg, whole, cooked, scrambled');
    expect(usdaFoodRow(egg)).toMatchObject({ serving_description: egg.serving_description, serving_size_grams: egg.serving_size_grams });
  });
});
