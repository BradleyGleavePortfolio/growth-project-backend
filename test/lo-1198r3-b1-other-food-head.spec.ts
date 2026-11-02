/**
 * LO-1198R3 B1 (audit of b#1198 @ 698d0725): a USDA basic row whose head is the
 * food but whose later part names another food that holds the head word again
 * ("Fish, fish sticks, frozen, prepared", "Butter, Clarified butter (ghee)",
 * "Beans, liquid from stewed kidney beans", "Pork, cured, salt pork, raw")
 * counts as naming the food at level 2 and, as a basic food, leads ahead of the
 * unbranded row for the food itself that is in the same answer ("Fish, raw",
 * "Butter, NFS", "Beans, NFS", "Pork, NFS"). Real USDA answers (FoodData Central
 * search, first 20 rows, read 2026-11-02, trimmed to the fields the mapper
 * reads); no built-in foods (as in production today); fresh and cached.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T {
  return value as T;
}

const answers: Record<string, unknown[]> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'lo-1198r3', 'b1-usda-words.json'), 'utf8'),
);

function service(): FoodService {
  const prisma = { foodItem: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([]) };
  return new FoodService(stub<PrismaService>(prisma));
}

const cases: [string, string, string][] = [
  ['fish', 'Fish, raw', 'Fish, fish sticks, frozen, prepared'],
  ['butter', 'Butter, NFS', 'Butter, Clarified butter (ghee)'],
  ['beans', 'Beans, NFS', 'Beans, liquid from stewed kidney beans'],
  ['pork', 'Pork, NFS', 'Pork, cured, salt pork, raw'],
];

describe('LO-1198R3 B1: a basic row for another food does not lead the plain food', () => {
  const env = process.env.USDA_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.USDA_API_KEY = 'test-key';
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      const foods = u.hostname === 'api.nal.usda.gov' ? answers[u.searchParams.get('query') ?? ''] ?? [] : [];
      return stub<Response>({ ok: true, status: 200, json: async () => ({ foods, products: [] }) });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.USDA_API_KEY = env;
  });

  it.each(cases)('%s: "%s" ranks before "%s", fresh and cached', async (word, plain, other) => {
    const s = service();
    for (const pass of ['fresh', 'cached']) {
      const names = (await s.search(word, 25, 'member-a')).results.map((r) => r.name);
      expect(names).toContain(plain);
      expect(names).toContain(other);
      expect({ pass, first: names[0], plainBeforeOther: names.indexOf(plain) < names.indexOf(other) }).toEqual({
        pass,
        first: expect.not.stringMatching(new RegExp(`^${other.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`)),
        plainBeforeOther: true,
      });
    }
  });
});
