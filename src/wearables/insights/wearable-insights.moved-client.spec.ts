import { ForbiddenException } from '@nestjs/common';
import { WearableMetricBucket } from '@prisma/client';
import { WearableInsightsService } from './wearable-insights.service';
import { InsightCacheService } from './insight-cache.service';
import type { PrismaService } from '../../prisma.service';
import type { AiGatewayService } from '../../ai/gateway/ai-gateway.service';
import { CoachInsight, isEmptyInsight } from './insight-output.schema';
import { grantAllEgress } from '../../../test/ai-egress/ai-egress.fakes';

// Owner 4 (A1H): "A client who moves: the old coach loses everything at once;
// history stays with the client." A coach-side wearable insight cached for
// the old coach (up to 6 hours) is not served to anyone else after the move.
// The real WearableInsightsService and InsightCacheService run over an
// in-memory store; only the model gateway is a double.

const OLD_COACH = 'coach-old-1111-1111-111111111111';
const NEW_COACH = 'coach-new-2222-2222-222222222222';
const CLIENT = 'client-3333-3333-3333-333333333333';
const BUCKET = WearableMetricBucket.SLEEP_RECOVERY;

type Row = Record<string, unknown>;

function insight(draft: string): CoachInsight {
  return {
    observation: 'HRV trended down across five of the last seven nights.',
    hypothesis: 'Accumulated training load alongside shorter sleep windows.',
    suggested_action: 'Pull back tonight session intensity and protect sleep.',
    suggested_message_draft: draft,
    confidence_level: 'confident',
    source_metrics: ['HRV_MS', 'SLEEP_TOTAL_MIN'],
  };
}

const OLD_INSIGHT = insight('Draft written for the old coach.');
const NEW_INSIGHT = insight('Draft written for the new coach.');

function fixture() {
  const users: Row[] = [
    { id: OLD_COACH, role: 'coach', coach_id: null, deleted_at: null, name: 'Olive Old' },
    { id: NEW_COACH, role: 'coach', coach_id: null, deleted_at: null, name: 'Nina New' },
    { id: CLIENT, role: 'student', coach_id: OLD_COACH, deleted_at: null, name: 'Alex Carter' },
  ];
  const cache = new Map<string, Row>();
  const keyOf = (where: Row) => {
    const k = where.WearableInsight_subject_side_bucket_window_key as Row;
    return `${k.user_id}|${k.side}|${k.bucket}|${k.window_days}`;
  };
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const hit = users.find((u) => Object.entries(where).every(([k, v]) => u[k] === v));
        return hit ? { id: hit.id } : null;
      }),
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const hit = users.find((u) => u.id === where.id);
        return hit ? { name: hit.name, profile: null } : null;
      }),
    },
    wearableSample: {
      findMany: jest.fn().mockResolvedValue([
        {
          metric: 'HRV_MS',
          value: 42,
          unit: 'ms',
          start_at: new Date('2026-06-01T06:00:00Z'),
          end_at: new Date('2026-06-01T06:00:00Z'),
        },
      ]),
    },
    wearableInsightCache: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => cache.get(keyOf(where)) ?? null),
      upsert: jest.fn(async ({ where, create, update }: Record<string, Row>) => {
        const k = keyOf(where);
        cache.set(k, { ...(cache.get(k) ?? create), ...update });
        return cache.get(k);
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const gateway = { invoke: jest.fn() };
  const reply = (payload: CoachInsight) => ({
    provider: 'anthropic',
    model: 'claude-sonnet-4.5',
    reply: JSON.stringify(payload),
  });
  const svc = new WearableInsightsService(
    prisma as unknown as PrismaService,
    gateway as unknown as AiGatewayService,
    new InsightCacheService(prisma as unknown as PrismaService),
    grantAllEgress(),
  );
  // The controller's order: current-coach check, then generate.
  const readAs = async (coachId: string) => {
    await svc.assertCoachOwnsClient(coachId, CLIENT, 'coach');
    return svc.generateForCoach(coachId, CLIENT, BUCKET);
  };
  const move = (to: string) => {
    const client = users.find((u) => u.id === CLIENT) as Row;
    client.coach_id = to;
  };
  return { prisma, gateway, reply, readAs, move, cache };
}

describe('A1H: a coach-side wearable insight cached before a move', () => {
  it('the old coach is refused at once after the move, with no read of the cache', async () => {
    const f = fixture();
    f.gateway.invoke.mockResolvedValueOnce(f.reply(OLD_INSIGHT));
    await expect(f.readAs(OLD_COACH)).resolves.toEqual(OLD_INSIGHT);
    expect(f.cache.size).toBe(1);

    f.move(NEW_COACH);

    const cacheReads = f.prisma.wearableInsightCache.findUnique.mock.calls.length;
    await expect(f.readAs(OLD_COACH)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.wearableInsightCache.findUnique).toHaveBeenCalledTimes(cacheReads);
    expect(f.gateway.invoke).toHaveBeenCalledTimes(1);
  });

  it('the new coach never gets the old coach insight or draft, and gets their own', async () => {
    const f = fixture();
    f.gateway.invoke.mockResolvedValueOnce(f.reply(OLD_INSIGHT));
    await f.readAs(OLD_COACH);

    f.move(NEW_COACH);
    f.gateway.invoke.mockResolvedValueOnce(f.reply(NEW_INSIGHT));

    const out = await f.readAs(NEW_COACH);
    expect(out).toEqual(NEW_INSIGHT);
    expect(JSON.stringify(out)).not.toContain('old coach');
    // A cache miss for the new coach: a fresh generation, as the new coach.
    expect(f.gateway.invoke).toHaveBeenCalledTimes(2);
    expect(f.gateway.invoke.mock.calls[1][0].requester).toEqual({ id: NEW_COACH, role: 'coach' });
    // Their next read is served from their own row.
    await expect(f.readAs(NEW_COACH)).resolves.toEqual(NEW_INSIGHT);
    expect(f.gateway.invoke).toHaveBeenCalledTimes(2);
  });

  it('on a failed generation the new coach gets the empty state, not the old row', async () => {
    const f = fixture();
    f.gateway.invoke.mockResolvedValueOnce(f.reply(OLD_INSIGHT));
    await f.readAs(OLD_COACH);

    f.move(NEW_COACH);
    f.gateway.invoke.mockRejectedValue(new Error('provider timeout'));

    const out = await f.readAs(NEW_COACH);
    expect(isEmptyInsight(out)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('old coach');
  });
});
