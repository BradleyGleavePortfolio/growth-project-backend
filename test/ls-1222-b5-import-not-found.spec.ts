import { NotFoundException } from '@nestjs/common';
import { FoodService } from '../src/food/food.service';
import { LogService } from '../src/log/log.service';
import type { PrismaService } from '../src/prisma.service';

function stub<T>(value: unknown): T { return value as T; }

describe('LS-1222 B5: unusable imports are terminal not-found, not retryable 500', () => {
  const key = process.env.USDA_API_KEY;
  beforeEach(() => { process.env.USDA_API_KEY = 'fixture-key'; });
  afterEach(() => {
    jest.restoreAllMocks();
    if (key === undefined) delete process.env.USDA_API_KEY;
    else process.env.USDA_API_KEY = key;
  });

  it.each(['USDA missing macro', 'USDA impossible numbers', 'OFF missing macro'] as const)(
    '%s on POST /log/food takes the existing 404 contract',
    async (kind) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(stub<Response>({
        ok: true, status: 200, json: async () => kind.startsWith('OFF') ? {
          product: { code: '1222005', product_name: 'Packaged cereal', nutriments: {
            'energy-kcal_100g': 60, carbohydrates_100g: 15, fat_100g: 0,
          } },
        } : {
          fdcId: 1222005, description: 'Packaged cereal', dataType: 'Branded', foodNutrients: [
            { nutrientName: 'Energy', unitName: 'KCAL', value: kind.includes('impossible') ? 950 : 60 },
            { nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 15 },
            { nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0 },
            ...(kind.includes('impossible') ? [{ nutrientName: 'Protein', unitName: 'G', value: 0 }] : []),
          ],
        },
      }));
      const prisma = stub<PrismaService>({
        foodItem: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
        loggedFoodEntry: { create: jest.fn() },
      });
      const service = new FoodService(prisma);
      const log = new LogService(
        prisma, service, stub({ capture: jest.fn() }), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }),
      );
      // The real LogController returns this promise unchanged. HttpExceptionFilter maps
      // a plain Error to 500, and the mobile queue retries 5xx instead of parking it.
      const error = await log.logFood('viewer', {
        food_item_id: `${kind.startsWith('OFF') ? 'off' : 'usda'}_1222005`,
        date: '2026-11-04', meal_type: 'breakfast',
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotFoundException);
    },
  );
});
