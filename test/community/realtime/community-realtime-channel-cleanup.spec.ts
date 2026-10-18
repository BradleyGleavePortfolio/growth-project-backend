/**
 * C10RT: every ping is a REST broadcast on the PRIVATE topic of one person
 * (`community:user:<id>`), sent to the audience decided at that moment; there
 * are no shared topics. C-610-4 still holds: the channel object is released
 * after every send, also when the send failed, and a failure never throws.
 * Who passes the rule is proven on a real database in
 * test/rls/community-realtime-private-rls.spec.ts.
 */
import { Logger } from '@nestjs/common';
import { CommunityRealtimeService, type CommunityAudience } from '../../../src/community/realtime/community-realtime.service';
import { SupabaseService } from '../../../src/supabase/supabase.service';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import type { PrismaService } from '../../../src/prisma.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../../../src/community/community-events';
import type { MessageCreatedPayload } from '../../../src/community/realtime/community-realtime.types';
import { stub } from '../../utils/trial-fakes';

function makeHarness(opts: { httpSend?: () => Promise<unknown>; removeChannel?: () => Promise<unknown> } = {}) {
  const channels: { topic: string; config: unknown; httpSend: jest.Mock }[] = [];
  const client = {
    channel: jest.fn((topic: string, params: { config: unknown }) => {
      const ch = { topic, config: params.config, httpSend: jest.fn(opts.httpSend ?? (async () => ({ success: true }))) };
      channels.push(ch);
      return ch;
    }),
    removeChannel: jest.fn(opts.removeChannel ?? (async () => 'ok')),
  };
  const supabase: SupabaseService = Object.assign(Object.create(SupabaseService.prototype), { getClient: () => client });
  const analytics: AnalyticsService = Object.assign(Object.create(AnalyticsService.prototype), { capture: jest.fn() });
  const prisma = {
    $queryRaw: jest.fn(async () => [{ id: 'r-1' }, { id: 'r-2' }]),
    communityWorkspace: { findUnique: jest.fn(async () => ({ coach_id: 'coach-1' })) },
  };
  const service = new CommunityRealtimeService(supabase, analytics, stub<PrismaService>(prisma));
  return { service, client, channels, prisma };
}

const EVENT = COMMUNITY_BROADCAST_EVENTS.messageCreated;
const META = { distinctId: 'u-1', channelKind: 'cohort' } as const;
const PAYLOAD: MessageCreatedPayload = {
  id: 'm-1',
  cohortId: 'c-1',
  authorId: 'u-1',
  createdAt: '2026-10-02T00:00:00.000Z',
};

describe('CommunityRealtimeService.broadcastCommunityEvent: private per-person topics', () => {
  const prevFlag = process.env.FEATURE_COMMUNITY_REALTIME;

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_REALTIME = 'true';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (prevFlag === undefined) delete process.env.FEATURE_COMMUNITY_REALTIME;
    else process.env.FEATURE_COMMUNITY_REALTIME = prevFlag;
  });

  const cases: [string, CommunityAudience, string[]][] = [
    ['named people, once each', { people: ['p-1', 'p-2', 'p-1'] }, ['p-1', 'p-2']],
    ['the readers of a space now', { workspaceId: 'w-1', cohortId: 'c-1' }, ['r-1', 'r-2']],
    ['the readers of the Hall now', { workspaceId: 'w-1', cohortId: null }, ['r-1', 'r-2']],
    ['the workspace coach', { coachOf: 'w-1' }, ['coach-1']],
  ];
  it.each(cases)('sends to %s, each on their own private topic, and releases every channel', async (_, audience, people) => {
    const { service, client, channels } = makeHarness();
    await service.broadcastCommunityEvent(audience, EVENT, PAYLOAD, META);
    expect(channels.map((c) => c.topic)).toEqual(people.map((id) => `community:user:${id}`));
    for (const c of channels) {
      expect(c.config).toEqual({ private: true });
      expect(c.httpSend).toHaveBeenCalledWith(EVENT, PAYLOAD, { timeout: 1500 });
    }
    expect(client.removeChannel).toHaveBeenCalledTimes(people.length);
  });

  it('asks the rule for a space or Hall audience at send time, one query', async () => {
    const { service, prisma } = makeHarness();
    await service.broadcastCommunityEvent({ workspaceId: 'w-1', cohortId: 'c-1' }, EVENT, PAYLOAD, META);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0]).toEqual(expect.arrayContaining(['w-1', 'c-1']));
  });

  it('opens nothing when nobody may read it', async () => {
    const { service, client, prisma } = makeHarness();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await service.broadcastCommunityEvent({ workspaceId: 'w-1', cohortId: 'c-1' }, EVENT, PAYLOAD, META);
    expect(client.channel).not.toHaveBeenCalled();
  });

  it('releases every channel and never throws when a send fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, client } = makeHarness({ httpSend: async () => ({ success: false, status: 500, error: 'down' }) });
    await expect(service.broadcastCommunityEvent({ people: ['p-1', 'p-2'] }, EVENT, PAYLOAD, META)).resolves.toBeUndefined();
    expect(client.removeChannel).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broadcastCommunityEvent failed'));
  });

  it('never throws when the cleanup itself fails', async () => {
    const { service, client } = makeHarness({
      removeChannel: async () => {
        throw new Error('socket gone');
      },
    });
    await expect(service.broadcastCommunityEvent({ people: ['p-1'] }, EVENT, PAYLOAD, META)).resolves.toBeUndefined();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('never queries or opens a channel while the realtime flag is off', async () => {
    process.env.FEATURE_COMMUNITY_REALTIME = 'false';
    const { service, client, prisma } = makeHarness();
    await service.broadcastCommunityEvent({ workspaceId: 'w-1', cohortId: null }, EVENT, PAYLOAD, META);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(client.channel).not.toHaveBeenCalled();
  });
});
