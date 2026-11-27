/**
 * PLAN-SWAPS-MACROS-BE L1: on a live database (the replayed migration chain), each swap GET /me/meal-plan/today
 * sends carries the swap meal's stored carbs_g and fats_g with its calories_kcal and protein_g, and the read still
 * sends only the client's own coach's live meals: never an archived one, never another coach's meal even when the
 * coach's stored list names it (CANARY is linked on purpose, so "no CANARY" tests the read's coach_id clause).
 *
 * The rls-live-tests runner gives this suite a superuser connection to a copy of the replayed chain, so L1 proves
 * the select and the where on the real schema and rows. It is not a row security proof of this change.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { RealMealPlansService } from '../../src/real-meal-plans/real-meal-plans.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const url = liveTestDatabaseUrl();
if (!url && process.env.CI === 'true') {
  throw new Error('PLAN-SWAPS-MACROS-BE live proof requires TEST_DATABASE_URL under CI.');
}

(url ? describe : describe.skip)(
  'PLAN-SWAPS-MACROS-BE L1: each swap carries its stored carbs and fat',
  () => {
    const prisma = new PrismaClient({ datasources: { db: { url } } });
    const plans = new RealMealPlansService(prisma as any);
    const k = randomUUID();
    const l = randomUUID();
    const c = randomUUID();
    const d = randomUUID();
    const canary = randomUUID();
    const granola = randomUUID();
    const riceCakes = randomUUID();
    const old = randomUUID();
    const shake = randomUUID();
    const planK = randomUUID();
    const planL = randomUUID();

    beforeAll(async () => {
      for (const coach of [k, l]) {
        await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role")
        VALUES (${coach}, ${randomUUID()}, ${`plan-swaps-macros-${coach}`}, 'Swap coach', 'coach'::"Role")`;
      }
      const clients: [string, string][] = [
        [c, k],
        [d, l],
      ];
      for (const [client, coach] of clients) {
        await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${client}, ${randomUUID()}, ${`plan-swaps-macros-${client}`}, 'Swap client', 'student'::"Role", ${coach})`;
      }
      // L's meal first, so K's stored list can name it.
      await prisma.mealTemplate.create({
        data: {
          id: canary,
          coach_id: l,
          name: 'Theirs CANARY',
          calories_kcal: 500,
          protein_g: 30,
          carbs_g: 45,
          fats_g: 18,
        },
      });
      await prisma.mealTemplate.create({
        data: {
          id: granola,
          coach_id: k,
          name: 'Greek yoghurt and granola',
          calories_kcal: 260,
          protein_g: 22,
          carbs_g: 34,
          fats_g: 5,
        },
      });
      await prisma.mealTemplate.create({
        data: {
          id: riceCakes,
          coach_id: k,
          name: 'Rice cakes, honey and whey',
          calories_kcal: 240,
          protein_g: 26,
          carbs_g: 30,
          fats_g: 2,
        },
      });
      await prisma.mealTemplate.create({
        data: {
          id: old,
          coach_id: k,
          name: 'Old swap',
          calories_kcal: 300,
          protein_g: 20,
          carbs_g: 30,
          fats_g: 10,
        },
      });
      await prisma.mealTemplate.create({
        data: {
          id: shake,
          coach_id: k,
          name: 'Banana and whey shake',
          calories_kcal: 250,
          protein_g: 25,
          carbs_g: 32,
          fats_g: 3,
          swap_template_ids: [granola, riceCakes, old, canary],
        },
      });
      // Linked while live, archived after: the coach's stored list keeps naming it (LO-1221 C1).
      await prisma.mealTemplate.update({ where: { id: old }, data: { archived_at: new Date() } });
      await prisma.dailyMealPlan.create({
        data: {
          id: planK,
          coach_id: k,
          name: 'Training day',
          slots: {
            create: { meal_template_id: shake, slot_label: 'preworkout', time_of_day: '17:30' },
          },
        },
      });
      await prisma.dailyMealPlan.create({
        data: {
          id: planL,
          coach_id: l,
          name: 'Their day',
          slots: {
            create: { meal_template_id: canary, slot_label: 'dinner', time_of_day: '19:30' },
          },
        },
      });
      const holds: [string, string, string][] = [
        [c, planK, k],
        [d, planL, l],
      ];
      for (const [client, plan, coach] of holds) {
        await prisma.dailyMealPlanAssignment.create({
          data: {
            daily_meal_plan_id: plan,
            client_id: client,
            assigned_by_coach_id: coach,
            starts_on: new Date('2026-01-01T00:00:00Z'),
          },
        });
      }
    });
    afterAll(() => prisma.$disconnect());

    it("L1 a client's swaps carry all four stored numbers; never an archived meal or another coach's", async () => {
      const mine = JSON.parse(JSON.stringify(await plans.getTodayForClient(c)));
      const theirs = JSON.parse(JSON.stringify(await plans.getTodayForClient(d)));
      // Which swaps: main's, on the real rows.
      expect(JSON.stringify(mine)).not.toContain('CANARY');
      expect(JSON.stringify(mine)).not.toContain('Old swap');
      expect(theirs.assignments).toHaveLength(1);
      for (const id of [k, shake, granola, riceCakes, old, planK])
        expect(JSON.stringify(theirs)).not.toContain(id);
      expect(mine.assignments).toHaveLength(1);
      const [slot] = mine.assignments[0].daily_meal_plan.slots;
      expect(slot.swaps).toStrictEqual([
        {
          id: granola,
          name: 'Greek yoghurt and granola',
          calories_kcal: 260,
          protein_g: 22,
          carbs_g: 34,
          fats_g: 5,
        },
        {
          id: riceCakes,
          name: 'Rice cakes, honey and whey',
          calories_kcal: 240,
          protein_g: 26,
          carbs_g: 30,
          fats_g: 2,
        },
      ]);
    });
  },
);
