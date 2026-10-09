/**
 * B31-D1 (agent 133, owner 17:58 "Wire roman up") live proof on real
 * Postgres: with the coach AI credit pool wired through Nest DI, Roman
 * admits and debits coached turns against the coach's monthly pool.
 *
 * - A coach whose pool was never initialised is NOT refused: the existing
 *   CoachAIBudgetService.getOrCreateCurrentPeriod creates the documented
 *   default period (base_actual_cents = resolveMaxActualCents(), 4000 by
 *   default, ai-credits.constants.ts). No new grant, no Stripe.
 * - A pool that was spent gets the existing 402 COACH_AI_BUDGET_EXHAUSTED.
 * - A coachless student has no pool and is never refused by it.
 * - The coach-method augmenter resolves the head coach (as the code defines).
 *
 * Gated on MWB3_TEST_DATABASE_URL; skipped with a logged reason elsewhere.
 */
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../src/prisma.service';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { AuditService } from '../../src/audit/audit.service';
import { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import {
  COACH_AI_BUDGET_EXHAUSTED_CODE,
  resolveMaxActualCents,
} from '../../src/ai-credits/ai-credits.constants';
import { RomanService, type RomanCaller } from '../../src/roman/roman.service';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { RomanCoachMethodAugmenter } from '../../src/roman/playbook/roman-coach-method.augmenter';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { bootstrapTestSchema } from '../utils/bootstrap-test-schema';
import { resetPublicSchema } from '../utils/reset-public-schema';

const TEST_DB_URL = process.env.MWB3_TEST_DATABASE_URL || '';
const liveDescribe = TEST_DB_URL ? describe : describe.skip;
if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('[roman-coach-pool-b31d1.live] MWB3_TEST_DATABASE_URL not set; live suite skipped.');
}

const COACH = 'b31d1-coach';
const CLIENT = 'b31d1-client';
const SOLO = 'b31d1-coachless';

liveDescribe('B31-D1 live: Roman uses the coach AI credit pool (Postgres)', () => {
  let prisma: PrismaService;
  let roman: RomanService;
  let augmenter: RomanCoachMethodAugmenter;

  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);
    const moduleRef = await Test.createTestingModule({
      providers: [
        RomanService,
        RomanCoachMethodAugmenter,
        CoachAIBudgetService,
        { provide: PrismaService, useValue: prisma },
        { provide: AiEgressService, useValue: grantAllEgress() },
        { provide: RomanClientContextService, useValue: {} },
        { provide: AuditService, useValue: { write: jest.fn() } },
      ],
    }).compile();
    roman = moduleRef.get(RomanService);
    augmenter = moduleRef.get(RomanCoachMethodAugmenter);
    await prisma.user.create({
      data: {
        id: COACH,
        supabase_id: `sb-${COACH}`,
        email: `${COACH}@example.test`,
        name: 'Coach Lee',
        role: 'coach',
      },
    });
    for (const [id, coach_id] of [
      [CLIENT, COACH],
      [SOLO, null],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          supabase_id: `sb-${id}`,
          email: `${id}@example.test`,
          name: 'Client',
          role: 'student',
          coach_id,
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  const client: RomanCaller = { id: CLIENT, role: 'student', tier: 'free' };

  it('a never-initialised pool gets the documented default period, and the turn is admitted', async () => {
    expect(await prisma.coachAIBudget.count({ where: { coach_user_id: COACH } })).toBe(0);
    await expect(roman.assertCoachPoolOpen(client)).resolves.toBe(COACH);
    const row = await prisma.coachAIBudget.findUniqueOrThrow({ where: { coach_user_id: COACH } });
    expect(row.base_actual_cents).toBe(resolveMaxActualCents());
    expect(row.total_pack_actual_cents).toBe(0);
    expect(row.actual_used_cents).toBe(0);
  });

  it('the coach on the coach surface uses the same pool', async () => {
    await expect(
      roman.assertCoachPoolOpen({ id: COACH, role: 'coach', tier: 'free' }),
    ).resolves.toBe(COACH);
  });

  it('a turn is debited from the pool', async () => {
    const debit: (c: string, i: number, o: number, r: string) => Promise<void> = Reflect.get(
      roman,
      'debitCoachPool',
    );
    await debit.call(roman, COACH, 20_000, 800, 'b31d1-req-1');
    const row = await prisma.coachAIBudget.findUniqueOrThrow({ where: { coach_user_id: COACH } });
    expect(row.actual_used_micro_cents > BigInt(0)).toBe(true);
    expect(row.actual_used_cents).toBeGreaterThan(0);
  });

  it('a spent pool gets the existing 402 for the client', async () => {
    await prisma.coachAIBudget.update({
      where: { coach_user_id: COACH },
      data: { actual_used_cents: resolveMaxActualCents() },
    });
    const err = await roman.assertCoachPoolOpen(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: COACH_AI_BUDGET_EXHAUSTED_CODE,
    });
  });

  it('a coachless student has no pool and is never refused by it', async () => {
    await expect(
      roman.assertCoachPoolOpen({ id: SOLO, role: 'student', tier: 'free' }),
    ).resolves.toBeNull();
  });

  it('the coach-method augmenter resolves the head coach (no block without an active playbook)', async () => {
    const headCoachOf: (c: { id: string; role: string }) => Promise<string | null> = Reflect.get(
      augmenter,
      'headCoachOf',
    );
    await expect(headCoachOf.call(augmenter, { id: CLIENT, role: 'student' })).resolves.toBe(COACH);
    await expect(headCoachOf.call(augmenter, { id: SOLO, role: 'student' })).resolves.toBeNull();
  });
});
