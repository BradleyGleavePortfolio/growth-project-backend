/**
 * LS-1212 B2: missing source measurements are not measured zero values.
 * This source row is already in the PR's real USDA CSV cut and full catalog.
 * With the existing non-null core-macro schema, omit an incomplete food.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseUsdaFoods, type UsdaFood } from '../scripts/load-usda-foods';

const ROOT = join(__dirname, '..');
const FIXTURE = join(ROOT, 'test/fixtures/usda-foods');
const nutrientRows = readFileSync(join(FIXTURE, 'foundation/food_nutrient.csv'), 'utf8')
  .split('\n').filter((line) => /^"[^"]*","746775",/.test(line));

describe('LS-1212 B2: no source-absent macro is published as a measured zero', () => {
  let dir: string;
  let built: UsdaFood[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ls1212-missing-'));
    const out = join(dir, 'catalog.gz');
    const result = spawnSync('python3', ['scripts/usda-foods/build.py',
      join(FIXTURE, 'sr-legacy'), join(FIXTURE, 'foundation'),
      join(ROOT, 'prisma/data/usda-built-in-map.json'), out], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
    built = parseUsdaFoods(readFileSync(out));
  });

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it.each([
    ['protein_g', '1003'],
    ['carbs_g', '1005'],
    ['fat_g', '1004'],
  ] as const)('does not invent %s=0 for Foundation salt with no USDA measurement', (field, nutrientId) => {
    expect(nutrientRows.length).toBeGreaterThan(0);
    expect(nutrientRows.some((line) => line.split(',')[2] === `"${nutrientId}"`)).toBe(false);
    expect(built.find((food) => food.fdc_id === 746775)?.[field]).toBeUndefined();
  });
});
