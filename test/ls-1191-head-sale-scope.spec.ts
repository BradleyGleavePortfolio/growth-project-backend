import 'reflect-metadata';
import { CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { asConfig, asPrismaService, makeMockConfig, makeMockPrisma } from './_fixtures/coach-brief-mocks';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

function matches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([key, expected]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((c) => matches(value, c));
    if (key === 'OR') return Array.isArray(expected) && expected.some((c) => matches(value, c));
    if (key === 'NOT') return !(Array.isArray(expected) ? expected : [expected]).some((c) => matches(value, c));
    if (key === 'in') return Array.isArray(expected) && expected.includes(value);
    if (key === 'not') return !matches(value, expected);
    if (key === 'gte' || key === 'lte') {
      if (!(value instanceof Date) || !(expected instanceof Date)) return false;
      return key === 'gte' ? value >= expected : value <= expected;
    }
    return value !== null && typeof value === 'object'
      && matches((value as Record<string, unknown>)[key], expected);
  });
}

describe('LS-1191 B4: a moved client does not transfer the former seller money records', () => {
  it.each([false, true])(
    'LS-1191 B4: head revenue excludes another coach sale (delegated client: %s)',
    async (delegated) => {
      const prisma = makeMockPrisma();
      const createdAt = new Date('2026-10-01T09:00:00Z');
      const client = { id: 'review-client', created_at: createdAt };
      prisma.user.findUnique.mockResolvedValue({ name: 'Test Head' });
      prisma.user.findMany.mockResolvedValue([client]);
      prisma.teamSubCoachAssignment.findMany.mockResolvedValue([
        { sub_coach_id: 'review-sub', sub_coach: { id: 'review-sub', name: 'Test Sub' } },
      ]);
      prisma.subCoachAssignment.findMany.mockResolvedValue(
        delegated ? [{ sub_coach_id: 'review-sub', client_id: client.id }] : [],
      );
      const at = new Date('2026-10-30T09:00:00Z');
      const settlements = [
        {
          gross_cents: 14900, created_at: at,
          purchase: {
            coach_user_id: 'review-former-coach', client_user_id: client.id,
            moved_away_at: at,
          },
        },
        {
          gross_cents: 4900, created_at: at,
          purchase: {
            coach_user_id: delegated ? 'review-sub' : 'review-head',
            client_user_id: client.id, moved_away_at: null,
          },
        },
      ];
      prisma.chargeSettlement.aggregate.mockImplementation(async ({ where }: { where: unknown }) => {
        const rows = settlements.filter((s) => matches(s, where));
        return { _sum: { gross_cents: rows.reduce((sum, s) => sum + s.gross_cents, 0) }, _count: { _all: rows.length } };
      });
      prisma.$queryRaw.mockResolvedValue([{ mrr_cents: 0n, count: 0n, total: 0n }]);
      const service = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()), grantAllEgress());
      const { context } = await service['aggregateHeadCoachContext']('review-head', 'UTC', '2026-10-30');
      expect(context.team_clients_total).toBe(1);
      expect(context).toMatchObject({
        total_revenue_today_cents: 4900, paid_today_count: 1, team_revenue_30d_cents: 4900,
      });
    },
  );
});
