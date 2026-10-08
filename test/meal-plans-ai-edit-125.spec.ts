/**
 * AUDIT-08-125 — a coach's edit of an AI-approved meal plan reaches the client.
 *
 * CoachAiService.materializeMealPlan stores flat `items` (time_of_day
 * "Day N – slot") AND the per-day `days`; the client app renders `days`
 * first. Before this fix PATCH /coach/meal-plans/:id updated `items` only,
 * so the client kept seeing the original AI meals, and the 50-item cap
 * refused the save of a default 7-day AI plan outright.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { MealPlansService, daysFromItems } from '../src/meal-plans/meal-plans.service';
import { UpdateMealPlanDto } from '../src/meal-plans/meal-plans.dto';

type Row = { id: string; coach_id: string; days: unknown; items: unknown };

function makePrisma(row: Row) {
  return {
    mealPlan: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; coach_id: string } }) =>
        where.id === row.id && where.coach_id === row.coach_id
          ? { id: row.id, days: row.days }
          : null,
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function svcFor(prisma: any) {
  return new MealPlansService(prisma);
}

const aiDays = [{ day: 1, meals: [{ slot: 'breakfast', items: [{ name: 'Oats', serving: '40 g' }] }] }];

describe('MealPlansService.updateByCoach on an AI-approved plan (AUDIT-08-125)', () => {
  it('rebuilds days from the edited items so the client sees the edit', async () => {
    const row: Row = { id: 'p1', coach_id: 'coach-A', days: aiDays, items: [] };
    const prisma = makePrisma(row);
    await svcFor(prisma).updateByCoach('coach-A', 'p1', {
      items: [
        { name: 'Eggs (2 large)', calories: 140, protein: 12, time_of_day: 'day 1 – breakfast' },
        { name: 'Toast (1 slice)', calories: 80, protein: 3, time_of_day: 'day 1 – breakfast' },
        { name: 'Salmon (5 oz)', calories: 300, protein: 34, time_of_day: 'Day 2 - dinner' },
      ],
    });
    expect(row.days).toEqual([
      {
        day: 1,
        meals: [
          {
            slot: 'breakfast',
            items: [
              { name: 'Eggs (2 large)', serving: '', calories: 140, protein_g: 12 },
              { name: 'Toast (1 slice)', serving: '', calories: 80, protein_g: 3 },
            ],
          },
        ],
        daily_totals: { calories: 220, protein_g: 15 },
      },
      {
        day: 2,
        meals: [
          { slot: 'dinner', items: [{ name: 'Salmon (5 oz)', serving: '', calories: 300, protein_g: 34 }] },
        ],
        daily_totals: { calories: 300, protein_g: 34 },
      },
    ]);
  });

  it('an empty value stays empty, not "0 kcal", and a day total needs every item (SMALL-BE-COPY-132)', async () => {
    const row: Row = { id: 'p1', coach_id: 'coach-A', days: aiDays, items: [] };
    const prisma = makePrisma(row);
    await svcFor(prisma).updateByCoach('coach-A', 'p1', {
      items: [
        { name: 'Eggs (2 large)', calories: 140, time_of_day: 'Day 1 – breakfast' },
        { name: 'Coffee', time_of_day: 'Day 1 – breakfast' },
        { name: 'Salmon (5 oz)', calories: 300, protein: 34, time_of_day: 'Day 2 – dinner' },
        { name: 'Water', calories: 0, protein: 0, time_of_day: 'Day 2 – dinner' },
      ],
    });
    expect(row.days).toEqual([
      {
        day: 1,
        meals: [
          {
            slot: 'breakfast',
            items: [
              { name: 'Eggs (2 large)', serving: '', calories: 140, protein_g: null },
              { name: 'Coffee', serving: '', calories: null, protein_g: null },
            ],
          },
        ],
        daily_totals: { calories: null, protein_g: null },
      },
      {
        day: 2,
        meals: [
          {
            slot: 'dinner',
            items: [
              { name: 'Salmon (5 oz)', serving: '', calories: 300, protein_g: 34 },
              { name: 'Water', serving: '', calories: 0, protein_g: 0 },
            ],
          },
        ],
        daily_totals: { calories: 300, protein_g: 34 },
      },
    ]);
  });

  it('falls back to the flat items when an edited item has no day label', async () => {
    const row: Row = { id: 'p1', coach_id: 'coach-A', days: aiDays, items: [] };
    const prisma = makePrisma(row);
    await svcFor(prisma).updateByCoach('coach-A', 'p1', {
      items: [{ name: 'Apple', time_of_day: 'snack' }],
    });
    expect(row.days).toBe(Prisma.DbNull);
  });

  it('leaves days alone on a manual plan and on a title-only edit', async () => {
    const manual: Row = { id: 'p1', coach_id: 'coach-A', days: null, items: [] };
    const p1 = makePrisma(manual);
    await svcFor(p1).updateByCoach('coach-A', 'p1', { items: [{ name: 'Rice' }] });
    expect(p1.mealPlan.update.mock.calls[0][0].data).not.toHaveProperty('days');

    const ai: Row = { id: 'p2', coach_id: 'coach-A', days: aiDays, items: [] };
    const p2 = makePrisma(ai);
    await svcFor(p2).updateByCoach('coach-A', 'p2', { title: 'Week 2' });
    expect(p2.mealPlan.update.mock.calls[0][0].data).not.toHaveProperty('days');
  });

  it('daysFromItems returns null for an item without a label', () => {
    expect(daysFromItems([{ name: 'Rice' }])).toBeNull();
  });
});

describe('UpdateMealPlanDto item cap (AUDIT-08-125)', () => {
  it('accepts a default 7-day AI plan of 84 items', async () => {
    const items = Array.from({ length: 84 }, (_, i) => ({
      name: `Item ${i}`,
      time_of_day: `day ${(i % 7) + 1} – lunch`,
    }));
    const dto = plainToInstance(UpdateMealPlanDto, { items });
    expect(await validate(dto)).toEqual([]);
  });
});
