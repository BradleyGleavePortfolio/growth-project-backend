/**
 * LO-1198 B1 (audit of b#1198 @ be847235): a search for "oatmeal" shows
 * "Bread, oatmeal" first. rankFoodResults puts every basic food (USDA SR
 * Legacy) that holds the query word anywhere above every other unbranded food,
 * so oatmeal bread and oatmeal cookies (SR Legacy) come before "Oatmeal, NFS"
 * (USDA Survey). The USDA answer here is the real one for "oatmeal" (FoodData
 * Central search, 20 rows, read 2026-10-31), trimmed to the fields the mapper
 * reads.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const usda: unknown[] = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lo-1198-usda-oatmeal.json'), 'utf8'));

describe('LO-1198 B1 oatmeal first', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) =>
      stub<Response>({
        ok: true,
        status: 200,
        json: async () => (new URL(String(url)).hostname === 'api.nal.usda.gov' ? { foods: usda } : { products: [] }),
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it('oatmeal: the first row is oatmeal, not oatmeal bread', async () => {
    const prisma = { foodItem: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([]) };
    const { results } = await new FoodService(stub<PrismaService>(prisma)).search('oatmeal', 25, 'member-a');

    expect(results[0].name.toLowerCase().startsWith('oatmeal')).toBe(true);
  });
});
