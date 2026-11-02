// FOOD-SEED-BE (F3): the built-in foods file every deploy now writes from (scripts/release.sh step 5) is checked in
// CI: 65 foods, unique name + brand, and per-100 g values a food can have. Owner check 191-S4: calories within 30% or
// 40 kcal of 4·protein + 4·carbs + 9·fat. Known exceptions (named, with the reason) go in KNOWN_EXCEPTIONS; there
// are none today. Seed values are never changed here. Plus the row the release step writes, field for field, and a
// real compile of the copy the runtime image runs (tsconfig.food-seed.json), with the no-database refusals.
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { foodKey, oneLine, parseSeedFoods, seedFoodRow, type SeedFood } from '../scripts/seed-built-in-foods';

const ROOT = join(__dirname, '..');
const SEED_FILE = 'prisma/data/seed-foods.json';
const raw = readFileSync(join(ROOT, SEED_FILE), 'utf8');
const foods = parseSeedFoods(raw);

// name + brand key → reason. A food listed here is exempt from the 191-S4 energy check only, and is listed in READY.
const KNOWN_EXCEPTIONS: Record<string, string> = {};

const label = (f: SeedFood) => (f.brand === null ? f.name : `${f.name} (${f.brand})`);
const atwater = (f: SeedFood) => 4 * f.protein_g + 4 * f.carbs_g + 9 * f.fat_g;
const overKcal = (list: SeedFood[]) => list.filter((f) => f.calories > 900).map(label);
const overGrams = (list: SeedFood[]) => list.filter((f) => f.protein_g > 100 || f.carbs_g > 100 || f.fat_g > 100).map(label);
const energyOff = (list: SeedFood[]) =>
  list
    .filter((f) => !(foodKey(f.name, f.brand) in KNOWN_EXCEPTIONS))
    .filter((f) => {
      const diff = Math.abs(f.calories - atwater(f));
      return diff > 40 && diff > 0.3 * atwater(f);
    })
    .map((f) => `${label(f)}: ${f.calories} kcal vs ${atwater(f).toFixed(1)} from macros`);

describe('prisma/data/seed-foods.json — the built-in foods (F3)', () => {
  it('lists exactly 65 foods, each name + brand once', () => {
    expect(foods).toHaveLength(65);
    expect(new Set(foods.map((f) => foodKey(f.name, f.brand))).size).toBe(65);
  });

  it('every food has the fields the release row needs, with sane types', () => {
    const bad = foods.filter(
      (f) =>
        typeof f.name !== 'string' ||
        f.name.trim() !== f.name ||
        f.name === '' ||
        !(f.brand === null || (typeof f.brand === 'string' && f.brand !== '')) ||
        typeof f.serving_description !== 'string' ||
        f.serving_description === '' ||
        !(f.serving_size_grams > 0) ||
        typeof f.food_category !== 'string' ||
        f.food_category === '' ||
        !(f.tags === undefined || (Array.isArray(f.tags) && f.tags.every((t) => typeof t === 'string'))) ||
        ![f.calories, f.protein_g, f.carbs_g, f.fat_g].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
        ![f.fiber_g, f.sugar_g].every((n) => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0)),
    );
    expect(bad.map(label)).toEqual([]);
  });

  it('no food is over 900 kcal per 100 g', () => {
    expect(overKcal(foods)).toEqual([]);
  });

  it('no food has over 100 g of protein, carbs or fat per 100 g', () => {
    expect(overGrams(foods)).toEqual([]);
  });

  it('calories are within 30% or 40 kcal of 4·protein + 4·carbs + 9·fat (191-S4), known exceptions named', () => {
    expect(energyOff(foods)).toEqual([]);
    // Every named exception is a food in the file.
    for (const key of Object.keys(KNOWN_EXCEPTIONS)) {
      expect(foods.some((f) => foodKey(f.name, f.brand) === key)).toBe(true);
    }
  });

  it('the checks above name a food that breaks them (each check bites)', () => {
    const base = foods[0];
    expect(overKcal([{ ...base, calories: 901 }])).toEqual([label(base)]);
    expect(overGrams([{ ...base, fat_g: 100.5 }])).toEqual([label(base)]);
    // 10 g protein, 10 g carbs, 10 g fat = 170 kcal: 205 is within 30% (51), 230 is 60 over and 35% over → named.
    const macro = { ...base, protein_g: 10, carbs_g: 10, fat_g: 10 };
    expect(energyOff([{ ...macro, calories: 205 }])).toEqual([]);
    expect(energyOff([{ ...macro, calories: 230 }])).toEqual([`${label(base)}: 230 kcal vs 170.0 from macros`]);
    // Small foods use the 40 kcal floor: 4 g carbs = 16 kcal, 50 kcal is 34 over → passes; 60 is 44 over → named.
    const small = { ...base, protein_g: 0, carbs_g: 4, fat_g: 0 };
    expect(energyOff([{ ...small, calories: 50 }])).toEqual([]);
    expect(energyOff([{ ...small, calories: 60 }])).toHaveLength(1);
  });

  it('npm run seed:foods reads this same file', () => {
    expect(readFileSync(join(ROOT, 'prisma/seed-foods.ts'), 'utf8')).toContain(
      "path.join(__dirname, 'data', 'seed-foods.json')",
    );
  });
});

describe('seed-built-in-foods — the row the release step writes (F1)', () => {
  const sample: SeedFood = {
    name: 'Banana, raw',
    brand: null,
    calories: 89,
    protein_g: 1.1,
    carbs_g: 22.8,
    fat_g: 0.3,
    fiber_g: 2.6,
    sugar_g: 12.2,
    serving_size_grams: 118,
    serving_description: '1 medium (118g)',
    food_category: 'Fruits and Fruit Juices',
    tags: ['fruit'],
  };

  it('is the row `npm run seed:foods` creates (prisma/seed-foods.ts), field for field', () => {
    expect(seedFoodRow(sample)).toEqual({
      name: 'Banana, raw',
      brand_or_restaurant: null,
      category: 'generic',
      serving_description: '1 medium (118g)',
      serving_size_grams: 118,
      calories: 89,
      protein_g: 1.1,
      carbs_g: 22.8,
      fat_g: 0.3,
      fiber_g: 2.6,
      sugar_g: 12.2,
      tags: ['fruit', 'category:Fruits and Fruit Juices', 'seed:common-foods'],
      search_aliases: [],
      nutrient_basis: 'PER_100G',
    });
    expect(seedFoodRow({ ...sample, tags: undefined }).tags).toEqual(['category:Fruits and Fruit Juices', 'seed:common-foods']);
  });

  it('never sets an owner, id, barcode or source on the row (shared catalog only)', () => {
    for (const f of foods) {
      const row: Record<string, unknown> = seedFoodRow(f);
      for (const k of ['id', 'created_by_user_id', 'created_by', 'barcode', 'source', 'source_id']) expect(row).not.toHaveProperty(k);
    }
  });

  it('keys name + brand so a NULL brand never matches a text brand', () => {
    expect(foodKey('Oats', null)).not.toBe(foodKey('Oats', 'null'));
    expect(foodKey('Oats', null)).not.toBe(foodKey('Oats', ''));
    expect(foodKey('a","b', null)).not.toBe(foodKey('a', 'b'));
  });

  it('prints a failure as one deploy-log line, whatever the error looks like', () => {
    expect(oneLine(new Error('\nInvalid `tx.foodItem.createMany()` invocation:\n\n\n  ERROR: refused\n'))).toBe(
      'Invalid `tx.foodItem.createMany()` invocation: | ERROR: refused',
    );
    expect(oneLine('plain')).toBe('plain');
    expect(oneLine(new Error('x'.repeat(900)))).toHaveLength(801);
  });

  it('refuses an empty, malformed or duplicated seed file (an empty catalog can never pass)', () => {
    expect(() => parseSeedFoods('[]')).toThrow(/non-empty JSON array/);
    expect(() => parseSeedFoods('{}')).toThrow(/non-empty JSON array/);
    expect(() => parseSeedFoods('[{"brand":null}]')).toThrow(/without a name/);
    expect(() => parseSeedFoods(JSON.stringify([sample, sample]))).toThrow(/twice/);
    expect(() => parseSeedFoods('not json')).toThrow();
  });
});

describe('compiled copy — what the runtime image runs (F1, F4)', () => {
  const cfgPath = join(ROOT, 'tsconfig.food-seed.json');
  const { config, error } = ts.readConfigFile(cfgPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, cfgPath);

  it('tsconfig.food-seed.json emits only the step, at the path release.sh and the Dockerfile name', () => {
    expect(error).toBeUndefined();
    expect(parsed.errors).toEqual([]);
    expect(parsed.fileNames.map((f) => relative(ROOT, f))).toEqual(['scripts/seed-built-in-foods.ts']);
    const js = ts.getOutputFileNames(parsed, join(ROOT, 'scripts/seed-built-in-foods.ts'), false).find((f) => f.endsWith('.js'));
    expect(relative(ROOT, js ?? '')).toBe('dist/food-seed/scripts/seed-built-in-foods.js');
    expect(readFileSync(join(ROOT, 'scripts/release.sh'), 'utf8')).toContain('dist/food-seed/scripts/seed-built-in-foods.js');
  });

  it('compiles with no errors, and the compiled step refuses to run without DIRECT_URL or with an empty file', () => {
    const out = mkdtempSync(join(tmpdir(), 'food-seed-'));
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir: out });
    expect(program.emit().emitSkipped).toBe(false);
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const js = join(out, 'scripts', 'seed-built-in-foods.js');
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), NODE_PATH: join(ROOT, 'node_modules') };

    const noUrl = spawnSync('node', [js, join(ROOT, SEED_FILE)], { cwd: ROOT, env, encoding: 'utf8' });
    expect(noUrl.status).toBe(1);
    expect(noUrl.stdout).toContain('[release] built-in foods FAILED: DIRECT_URL is not set');

    const empty = join(out, 'empty.json');
    writeFileSync(empty, '[]');
    const r = spawnSync('node', [js, empty], { cwd: ROOT, env: { ...env, DIRECT_URL: 'postgresql://127.0.0.1:1/none' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[release] built-in foods FAILED: seed file is not a non-empty JSON array of foods');

    const noFile = spawnSync('node', [js], { cwd: ROOT, env, encoding: 'utf8' });
    expect(noFile.status).toBe(1);
    expect(noFile.stdout).toContain('usage: seed-built-in-foods');
  }, 120_000);
});
