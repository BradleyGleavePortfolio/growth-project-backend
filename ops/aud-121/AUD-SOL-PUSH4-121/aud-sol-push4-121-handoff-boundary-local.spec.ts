import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  LEASE_MS,
  PushDeliveryService,
} from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const CLOCK = new Date('2026-06-02T18:00:00Z');
const NY = 'America/New_York';

class Clocked extends PushDeliveryService {
  clock = CLOCK;
  protected now(): Date {
    return new Date(this.clock);
  }
}

function world() {
  let clock = CLOCK;
  const w = pushOutboxWorld({
    now: () => clock,
    tokens: { 'client-1': TOKEN },
    prefs: {
      'client-1': {
        timezone: NY,
        timezone_updated_at: CLOCK,
        muted: false,
        message_push: true,
        milestone_push: true,
      },
    },
  });
  const client = {
    send: jest.fn(
      async (_messages: ExpoPushMessage[], _signal: AbortSignal): Promise<ExpoPushTicket[]> => [
        { status: 'ok', id: 'boundary-ticket' },
      ],
    ),
    getReceipts: jest.fn(
      async (
        _ids: string[],
        _signal: AbortSignal,
      ): Promise<Record<string, ExpoPushReceipt>> => ({}),
    ),
  };
  const delivery = new Clocked(Object.create(w.db), client);
  Object.defineProperty(delivery, 'clock', {
    get: () => clock,
    set: (value: Date) => {
      clock = value;
    },
  });
  delivery.autoDrain = false;
  return { ...w, client, delivery };
}

const message = {
  userId: 'client-1',
  kind: NotificationKind.MESSAGE_RECEIVED,
  title: 'New message',
  body: 'New message',
  data: { actionScreen: 'Messages' },
  collapseKey: 'message:thread-1',
  timeZone: NY,
};

/**
 * Suspend the handoff call BEFORE the database evaluates its predicate.
 * This models query queueing/lock wait, not erasure after an external send.
 */
function beforeHandoffUpdate(
  w: ReturnType<typeof world>,
  change: () => void | Promise<void>,
) {
  const original = w.db.pushOutbox.updateMany.getMockImplementation();
  let paused = false;
  w.db.pushOutbox.updateMany.mockImplementation(async (args) => {
    if (!paused && args.data.handed_off_at instanceof Date) {
      paused = true;
      await change();
    }
    return original ? original(args) : { count: 0 };
  });
}

beforeAll(() => {
  for (const level of ['warn', 'error', 'log'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

describe('AUD-SOL-PUSH4-121: replay PUSH3 probe 1 with separate replica accounting', () => {
  it('a final token read that outlasts the lease permits only the replica to send once', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    let reads = 0;
    const replicaClient = {
      ...w.client,
      send: jest.fn(
        async (_messages: ExpoPushMessage[], _signal: AbortSignal): Promise<ExpoPushTicket[]> => [
          { status: 'ok', id: 'replica-ticket' },
        ],
      ),
    };
    const replica = new Clocked(Object.create(w.db), replicaClient);
    Object.defineProperty(replica, 'clock', {
      get: () => w.delivery.clock,
      set: (value: Date) => {
        w.delivery.clock = value;
      },
    });
    replica.autoDrain = false;
    w.db.user.findUnique.mockImplementation(async (args) => {
      const captured = original ? await original(args) : { expo_push_token: TOKEN };
      reads += 1;
      if (reads === 2) {
        w.delivery.clock = new Date(CLOCK.getTime() + LEASE_MS + 1_000);
        expect((await replica.sweep()).expired).toBe(1);
      }
      return captured;
    });
    expect(await w.delivery.drain()).toBe(0);
    expect(reads).toBe(4);
    expect(replicaClient.send).toHaveBeenCalledTimes(1);
    expect(w.client.send).not.toHaveBeenCalled();
    expect(w.rows[0]).toMatchObject({ status: 'sent', result_code: 'sent' });
  });
});

describe('AUD-SOL-PUSH4-121: consent committed before the final handoff predicate', () => {
  it.each(['master mute', 'message switch'] as const)(
    '%s committed during the handoff wait still suppresses the provider call',
    async (switchName) => {
      const w = world();
      await w.delivery.enqueue(message);
      beforeHandoffUpdate(w, () => {
        w.delivery.clock = new Date(CLOCK.getTime() + 70_000);
        if (switchName === 'master mute') w.prefs['client-1'].muted = true;
        else w.prefs['client-1'].message_push = false;
      });
      expect(await w.delivery.drain()).toBe(0);
      expect(w.client.send).not.toHaveBeenCalled();
    },
  );

  it('control: changing an unrelated kind during that wait still permits this message', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    beforeHandoffUpdate(w, () => {
      w.delivery.clock = new Date(CLOCK.getTime() + 70_000);
      w.prefs['client-1'].milestone_push = false;
    });
    expect(await w.delivery.drain()).toBe(1);
    expect(w.client.send).toHaveBeenCalledTimes(1);
  });

  it('control: sign-out committed before that predicate permits no provider call', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    beforeHandoffUpdate(w, () => {
      w.tokens['client-1'] = null;
    });
    expect(await w.delivery.drain()).toBe(0);
    expect(w.client.send).not.toHaveBeenCalled();
  });

  it('control: deleting the outbox row before that predicate permits no provider call', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    beforeHandoffUpdate(w, async () => {
      await w.db.pushOutbox.deleteMany({ where: { user_id: 'client-1' } });
    });
    expect(await w.delivery.drain()).toBe(0);
    expect(w.client.send).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(0);
  });
});

describe('AUD-SOL-PUSH4-121: lease validity while the final CAS itself waits', () => {
  it.each([LEASE_MS, LEASE_MS + 1_000])(
    'a %i ms handoff wait cannot use a lease predicate bound to the pre-wait clock',
    async (delay) => {
      const w = world();
      await w.delivery.enqueue(message);
      beforeHandoffUpdate(w, () => {
        w.delivery.clock = new Date(CLOCK.getTime() + delay);
      });
      expect(await w.delivery.drain()).toBe(0);
      expect(w.client.send).not.toHaveBeenCalled();
    },
  );

  it('control: a 70-second handoff wait inside the lease sends once', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    beforeHandoffUpdate(w, () => {
      w.delivery.clock = new Date(CLOCK.getTime() + 70_000);
    });
    expect(await w.delivery.drain()).toBe(1);
    expect(w.client.send).toHaveBeenCalledTimes(1);
  });
});
