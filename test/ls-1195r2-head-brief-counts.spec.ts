import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  buildFallbackNarrative,
} from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import { noClientDataSubject } from '../src/ai-egress/ai-egress.types';
import {
  asAnthropic,
  asConfig,
  asPrismaService,
  makeMockAnthropic,
  makeMockConfig,
  makeMockPrisma,
} from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

describe('LS-1195R2 head-coach waiting counts (his own Stripe account, R-1195-C1) reach fresh fallback and AI briefs', () => {
  it.each([0, 1, 2, 101])('keeps %i held renewals separate from failed payments', async (count) => {
    const prisma = makeMockPrisma();
    prisma.user.findUnique.mockResolvedValue({ name: 'Alex Review' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'team-buyer', created_at: new Date() },
    ]);
    prisma.teamSubCoachAssignment.findMany.mockResolvedValue([
      { sub_coach_id: 'seated-sub', sub_coach: { id: 'seated-sub', name: 'Review Sub' } },
    ]);
    prisma.subCoachAssignment.findMany.mockResolvedValue([]);
    prisma.chargeSettlement.aggregate.mockResolvedValue({
      _sum: { gross_cents: 0 },
      _count: { _all: 0 },
    });
    let heldQuery: Prisma.Sql | undefined;
    prisma.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (!query.strings.join('?').includes('"DunningState"')) {
        return [{ mrr_cents: 0n }];
      }
      heldQuery = query;
      return [{
        count: 0n,
        total: 0n,
        locked: 0n,
        locked_total: 0n,
        on_hold: 0n,
        waiting: BigInt(count),
      }];
    });
    const service = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      grantAllEgress(),
    );
    const { context } = await service['aggregateHeadCoachContext'](
      'head-review',
      'America/Los_Angeles',
      '2026-10-31',
    );
    expect(context.dunning_in_progress).toBe(0);
    expect(context.dunning_locked).toBe(0);
    expect(context.dunning_on_hold).toBe(0);
    expect(context.coach_account_waiting).toBe(count || undefined);
    const sqlText = heldQuery!.strings.join('?');
    expect(sqlText).toContain('cp."client_user_id" = ANY');
    expect(sqlText).toContain('cp."coach_user_id" = ANY');
    expect(heldQuery!.values).toContainEqual(['team-buyer']);
    expect(heldQuery!.values).toContainEqual(['head-review', 'seated-sub']);
    // FR-1195R3 (ruling R-1195-C1): the waiting count is his own Stripe account's only.
    expect(sqlText).toContain('"client_canceled_at" IS NULL AND cp."coach_user_id" = ?');
    expect(heldQuery!.values).toContain('head-review');

    const base = buildFallbackNarrative({ ...context, coach_account_waiting: undefined });
    const ai = makeMockAnthropic(base);
    const aiService = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      grantAllEgress(),
      asAnthropic(ai),
    );
    const result = await aiService.callClaude(context, {
      ctx: context,
      subject: noClientDataSubject('coach_business_metrics', 'head-review'),
    });
    expect(result.generated_by).toBe('ai');
    for (const narrative of [buildFallbackNarrative(context), result.narrative]) {
      if (count > 0) expect(narrative).toContain(coachAccountWaitingLine(count));
      else expect(narrative).not.toContain('waiting on your Stripe account');
      expect(narrative).not.toMatch(/payments? failed|Access is paused|bank dispute/);
    }
  });
});
