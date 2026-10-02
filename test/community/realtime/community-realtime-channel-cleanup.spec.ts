/**
 * C-610-4 (found by the community live suites): a failed Realtime broadcast
 * must still release its channel.
 *
 * broadcastCommunityEvent subscribes a channel, sends, then removes it. It
 * used to remove the channel only on success, so every broadcast that timed
 * out (Supabase Realtime unreachable) or failed to send left a subscribed
 * channel behind, and the Realtime socket kept reconnecting forever: one more
 * retry timer per failed broadcast during an outage, and a live handle that
 * kept the community live suites (realtime on, no Realtime server in CI) from
 * exiting until the job timed out. The channel is now removed in `finally`.
 */
import { Logger } from '@nestjs/common';
import { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import { SupabaseService } from '../../../src/supabase/supabase.service';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../../../src/community/community-events';
import type { MessageCreatedPayload } from '../../../src/community/realtime/community-realtime.types';

type SubscribeCb = (status: string) => void | Promise<void>;

function makeHarness(opts: {
  subscribe: (cb: SubscribeCb) => void;
  send?: () => Promise<unknown>;
  removeChannel?: () => Promise<unknown>;
}) {
  const channel = {
    subscribe: jest.fn((cb: SubscribeCb) => {
      opts.subscribe(cb);
      return channel;
    }),
    send: jest.fn(opts.send ?? (async () => 'ok')),
  };
  const client = {
    channel: jest.fn(() => channel),
    removeChannel: jest.fn(opts.removeChannel ?? (async () => 'ok')),
  };
  // Real class instances (no constructor side effects) with only the members
  // the service touches replaced.
  const supabase: SupabaseService = Object.assign(Object.create(SupabaseService.prototype), {
    getClient: () => client,
  });
  const analytics: AnalyticsService = Object.assign(Object.create(AnalyticsService.prototype), {
    capture: jest.fn(),
  });
  const service = new CommunityRealtimeService(supabase, analytics);
  return { service, client, channel };
}

const EVENT = COMMUNITY_BROADCAST_EVENTS.messageCreated;
const META = { distinctId: 'u-1', channelKind: 'cohort' } satisfies {
  distinctId: string;
  channelKind: 'cohort';
};
const PAYLOAD: MessageCreatedPayload = {
  id: 'm-1',
  cohortId: 'c-1',
  authorId: 'u-1',
  createdAt: '2026-10-02T00:00:00.000Z',
};

describe('CommunityRealtimeService.broadcastCommunityEvent channel cleanup', () => {
  const prevFlag = process.env.FEATURE_COMMUNITY_REALTIME;

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_REALTIME = 'true';
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (prevFlag === undefined) delete process.env.FEATURE_COMMUNITY_REALTIME;
    else process.env.FEATURE_COMMUNITY_REALTIME = prevFlag;
  });

  it('removes the channel after a successful send', async () => {
    const { service, client, channel } = makeHarness({
      subscribe: (cb) => void cb('SUBSCRIBED'),
    });
    await service.broadcastCommunityEvent('community:ws:1', EVENT, PAYLOAD, META);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it('removes the channel when subscribe never completes (Realtime unreachable)', async () => {
    jest.useFakeTimers();
    const { service, client, channel } = makeHarness({ subscribe: () => undefined });
    const done = service.broadcastCommunityEvent('community:ws:1', EVENT, PAYLOAD, META);
    await jest.advanceTimersByTimeAsync(1500);
    await done;
    expect(channel.send).not.toHaveBeenCalled();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it('removes the channel when send fails', async () => {
    const { service, client } = makeHarness({
      subscribe: (cb) => void cb('SUBSCRIBED'),
      send: async () => {
        throw new Error('send failed');
      },
    });
    await service.broadcastCommunityEvent('community:ws:1', EVENT, PAYLOAD, META);
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('never throws when the cleanup itself fails', async () => {
    const { service, client } = makeHarness({
      subscribe: (cb) => void cb('SUBSCRIBED'),
      removeChannel: async () => {
        throw new Error('socket gone');
      },
    });
    await expect(
      service.broadcastCommunityEvent('community:ws:1', EVENT, PAYLOAD, META),
    ).resolves.toBeUndefined();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('never opens a channel while the realtime flag is off', async () => {
    process.env.FEATURE_COMMUNITY_REALTIME = 'false';
    const { service, client } = makeHarness({ subscribe: (cb) => void cb('SUBSCRIBED') });
    await service.broadcastCommunityEvent('community:ws:1', EVENT, PAYLOAD, META);
    expect(client.channel).not.toHaveBeenCalled();
    expect(client.removeChannel).not.toHaveBeenCalled();
  });
});
