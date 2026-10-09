/**
 * B31 (agent 133) live proof on real Postgres: Roman's per-turn grounding
 * bundle builds for a coachless student whose UserProfile list columns are
 * NULL in the database (production shape: the baseline created
 * preferred_snacks TEXT[] with no default; dietary_restrictions and
 * equipment_access have a default but no NOT NULL).
 *
 * It also builds RomanService through Nest DI (as RomanModule does) and proves
 * a grounded turn gets the bundle, and that a coachless client's own-tenant
 * plan and targets (the CONSULT-ALL-BE-133 house clone tenant) reach Roman
 * while a coached client never reads their own-tenant rows.
 *
 * Gated on MWB3_TEST_DATABASE_URL (the mwb-3-live-tests CI job); skipped
 * with a logged reason elsewhere.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/prisma.service';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { AuditService } from '../../src/audit/audit.service';
import { RomanService, type RomanCaller } from '../../src/roman/roman.service';
import { ROMAN_SAFETY_INTAKE_SOURCE } from '../../src/roman/context/roman-client-context.types';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { RomanConsultationIntakeSource } from '../../src/roman/context/roman-consultation.source';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[roman-context-null-lists.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.',
  );
}

const CLIENT = 'b31-live-coachless';
const COACHED = 'b31-live-coached';
const COACH = 'b31-live-coach';
const NOW = new Date('2026-10-08T21:48:14.000Z');
const TODAY = '2026-10-08';

liveDescribe('B31 live: Roman context for a coachless client with NULL profile lists', () => {
  let prisma: PrismaService;
  let ctx: RomanClientContextService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    ctx = new RomanClientContextService(prisma, new RomanConsultationIntakeSource(prisma));
    await prisma.user.create({
      data: {
        id: CLIENT,
        supabase_id: `sb-${CLIENT}`,
        email: `${CLIENT}@example.test`,
        name: 'Avery Stone',
        role: 'student',
      },
    });
    await prisma.userProfile.create({
      data: {
        user_id: CLIENT,
        macro_target_calories: 2100,
        macro_target_protein_g: 150,
        macro_target_carbs_g: 210,
        macro_target_fat_g: 70,
      },
    });
    // Production shape: the list columns are NULL, not '{}'.
    await prisma.$executeRawUnsafe(
      `UPDATE "UserProfile" SET preferred_snacks = NULL, dietary_restrictions = NULL, equipment_access = NULL WHERE user_id = $1`,
      CLIENT,
    );
    const food = await prisma.foodItem.create({
      data: {
        name: 'Greek yogurt',
        serving_description: '1 cup',
        serving_size_grams: 245,
        calories: 150,
        protein_g: 25,
        carbs_g: 9,
        fat_g: 0,
      },
    });
    await prisma.loggedFoodEntry.create({
      data: {
        user_id: CLIENT,
        date: new Date(`${TODAY}T00:00:00.000Z`),
        meal_type: 'breakfast',
        food_item_id: food.id,
        logged_at: new Date('2026-10-08T15:00:00.000Z'),
      },
    });
    await prisma.checkIn.create({
      data: {
        user_id: CLIENT,
        date: new Date(`${TODAY}T00:00:00.000Z`),
        soreness: 2,
        energy: 4,
        sleep_hours: 7.5,
      },
    });
  }, 180_000);

  async function selfPlan(userId: string, planName: string): Promise<void> {
    const program = await prisma.workoutProgram.create({
      data: {
        coach_id: userId,
        owner_user_id: userId,
        name: 'Foundation Strength',
        weeks: 4,
        days_per_week: 3,
      },
    });
    const plan = await prisma.workoutPlan.create({
      data: { coach_id: userId, name: planName, type: 'strength', program_id: program.id },
    });
    await prisma.clientWorkoutAssignment.create({
      data: {
        workout_plan_id: plan.id,
        client_id: userId,
        assigned_by_coach_id: userId,
        scheduled_for: new Date('2026-10-09T00:30:00.000Z'), // 17:30 PT, same local day
      },
    });
    await prisma.macroTarget.create({
      data: {
        client_id: userId,
        coach_id: userId,
        calories_kcal: 2400,
        protein_g: 180,
        carbs_g: 240,
        fats_g: 80,
        effective_from: new Date('2026-10-01T00:00:00.000Z'),
      },
    });
  }

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('the fixture really holds NULL lists (production shape)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ snacks_null: boolean; dr_null: boolean }[]>(
      `SELECT preferred_snacks IS NULL AS snacks_null, dietary_restrictions IS NULL AS dr_null FROM "UserProfile" WHERE user_id = $1`,
      CLIENT,
    );
    expect(rows).toEqual([{ snacks_null: true, dr_null: true }]);
  });

  it('builds the bundle (no throw), with name, targets, food log and check-ins', async () => {
    const bundle = await ctx.buildFresh({ id: CLIENT, role: 'student' }, NOW);
    const c = bundle.context;
    expect(c.identity.first_name).toBe('Avery');
    expect(c.targets).toMatchObject({
      source: 'onboarding_calculated',
      calories: 2100,
      protein_g: 150,
    });
    expect(c.today.meals_logged).toBe(1);
    expect(c.today.kcal).toBe(150);
    expect(c.check_ins).toHaveLength(1);
    expect(c.coach.has_coach).toBe(false);
    expect(c.profile.preferred_snacks).toEqual([]);
    expect(c.profile.dietary_restrictions).toEqual([]);
    expect(c.profile.equipment_access).toEqual([]);
    expect(bundle.rendered).toContain('Avery');
  });

  it('through Nest DI, a grounded turn gets the bundle (no degraded mode)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RomanService,
        RomanClientContextService,
        RomanConsultationIntakeSource,
        { provide: ROMAN_SAFETY_INTAKE_SOURCE, useExisting: RomanConsultationIntakeSource },
        { provide: PrismaService, useValue: prisma },
        { provide: AiEgressService, useValue: grantAllEgress() },
        { provide: AuditService, useValue: { write: jest.fn() } },
      ],
    }).compile();
    const svc = moduleRef.get(RomanService);
    const caller: RomanCaller = { id: CLIENT, role: 'student', tier: 'free' };
    const load: (c: RomanCaller) => Promise<RomanClientContextBundle | null> = Reflect.get(
      svc,
      'loadTurnBundle',
    );
    const bundle = await load.call(svc, caller);
    expect(bundle).not.toBeNull();
    expect(bundle!.rendered).toContain('Avery');
    expect(bundle!.context.targets.calories).not.toBeNull();
  });

  it("a coachless client's own-tenant plan and targets reach Roman", async () => {
    await selfPlan(CLIENT, 'Day A Lower');
    const c = (await ctx.buildFresh({ id: CLIENT, role: 'student' }, NOW)).context;
    expect(c.coach.has_coach).toBe(false);
    expect(c.targets).toMatchObject({
      source: 'onboarding_calculated',
      calories: 2400,
      protein_g: 180,
    });
    expect(c.plan).not.toBeNull();
    expect(JSON.stringify(c.plan)).toContain('Day A Lower');
    expect(c.data_quality.missing).not.toContain('plan');
  });

  it('a coached client never reads their own-tenant rows (coach side only)', async () => {
    await prisma.user.create({
      data: {
        id: COACH,
        supabase_id: `sb-${COACH}`,
        email: `${COACH}@example.test`,
        name: 'Coach Lee',
        role: 'coach',
      },
    });
    await prisma.user.create({
      data: {
        id: COACHED,
        supabase_id: `sb-${COACHED}`,
        email: `${COACHED}@example.test`,
        name: 'Jordan Reyes',
        role: 'student',
        coach_id: COACH,
      },
    });
    await selfPlan(COACHED, 'Self Day');
    const c = (await ctx.buildFresh({ id: COACHED, role: 'student' }, NOW)).context;
    expect(c.coach.has_coach).toBe(true);
    expect(c.plan).toBeNull();
    expect(c.targets.source).toBe('none');
    expect(JSON.stringify(c)).not.toContain('Self Day');
  });
});
