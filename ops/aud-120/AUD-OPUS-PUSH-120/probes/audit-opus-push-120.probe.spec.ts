/**
 * AUD-OPUS-PUSH-120 (Claude Opus 5.5 lens) probes on backend #693 @ 13417e7b
 * (tree includes #692 @ 27156167). Audit-only file: never merge.
 *
 * Expected results at the audited head:
 *   U1 [B-693-1]  FAILS: the worker sends Android channelId 'default', which the
 *                 mobile app never creates (it registers coach-messages,
 *                 client-bot, milestones, system: mobile src/notifications/
 *                 push-channels.ts). Expo: a channelId that does not exist on
 *                 the device means the notification is not displayed.
 *   U2 [C-693-3]  FAILS: a quiet-hours-deferred "Session confirmed" for a
 *                 session cancelled overnight still reaches the lock screen at
 *                 08:00 (only reminders are re-checked at send).
 *   U3 [C-693-4]  FAILS: a connection refused before any byte reached Expo is
 *                 dropped for good instead of retried.
 *   U4 [control]  PASSES: lock-screen copy of every kind sendPush is called
 *                 with carries no health value and no message text.
 */
import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { ExpoPushClient, PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { FetchExpoPushClient } from '../src/notifications/push/expo-push-client';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { NotificationKind } from '../src/notifications/notification-kind';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const NY = 'America/New_York';
const NY_AFTERNOON = new Date('2026-06-02T18:00:00Z'); // 14:00 EDT
const NY_2300 = new Date('2026-06-03T03:00:00Z'); // 23:00 EDT Jun 2
const NY_0800 = new Date('2026-06-03T12:00:00Z'); // 08:00 EDT Jun 3

// mobile main src/notifications/push-channels.ts PUSH_CHANNEL values.
const MOBILE_ANDROID_CHANNELS = new Set(['coach-messages', 'client-bot', 'milestones', 'system']);

class Clocked extends PushDeliveryService {
  constructor(
    db: unknown,
    client: ExpoPushClient,
    private readonly clock: { at: Date },
  ) {
    super(db as never, client);
    this.autoDrain = false;
  }
  protected now(): Date {
    return new Date(this.clock.at.getTime());
  }
}

function recordingExpo() {
  const sent: ExpoPushMessage[] = [];
  let n = 0;
  const client: ExpoPushClient = {
    send: async (m: ExpoPushMessage[]) => {
      sent.push(...m);
      return m.map(() => ({ status: 'ok', id: `ticket-${++n}` }) as ExpoPushTicket);
    },
    getReceipts: async () => ({}) as Record<string, ExpoPushReceipt>,
  };
  return { client, sent };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('AUD-OPUS-PUSH-120 probes (#693 @ 13417e7b)', () => {
  it('U1 [B-693-1]: every Android channelId the worker sends is one the mobile app creates (or none)', async () => {
    const clock = { at: NY_AFTERNOON };
    const w = pushOutboxWorld({ now: () => clock.at, tokens: { 'u-1': TOKEN } });
    const { client, sent } = recordingExpo();
    const svc = new Clocked(Object.create(w.db), client, clock);
    for (const [kind, key] of [
      [NotificationKind.MESSAGE_RECEIVED, 'tgp://messages/u-1'],
      [NotificationKind.COACH_ALERT, 'tgp://coach/alerts'],
      [NotificationKind.MILESTONE_REACHED, 'tgp://timeline'],
    ] as const) {
      await svc.enqueue({
        userId: 'u-1',
        kind,
        title: 't',
        body: 'b',
        data: {},
        collapseKey: `${kind}:${key}`,
        timeZone: NY,
      });
    }
    await svc.drain();
    expect(sent).toHaveLength(3);
    const channels = sent.map((m) => m.channelId);
    const unknown = channels.filter((c) => c !== undefined && !MOBILE_ANDROID_CHANNELS.has(c));
    expect(unknown).toEqual([]);
  });

  it('U2 [C-693-3]: a deferred "Session confirmed" whose session was cancelled overnight is not put on the lock screen at 08:00', async () => {
    const clock = { at: NY_2300 };
    const w = pushOutboxWorld({
      now: () => clock.at,
      tokens: { 'client-1': TOKEN },
      sessions: { 's-1': { status: 'cancelled', start_at: new Date('2026-06-06T15:00:00Z') } },
    });
    const { client, sent } = recordingExpo();
    const svc = new Clocked(Object.create(w.db), client, clock);
    const r = await svc.enqueue({
      userId: 'client-1',
      kind: NotificationKind.BOOKING_CONFIRMED,
      title: 'Session confirmed',
      body: 'Coach K confirmed your session on Sat, Jun 6 at 11:00 AM EDT.',
      data: {},
      context: { sessionId: 's-1', scheduledAt: '2026-06-06T15:00:00.000Z', timeZone: NY },
      dedupeKey: 'booking_confirmed:s-1:2026-06-06T15:00:00.000Z',
      collapseKey: 'booking_confirmed:tgp://client/sessions/s-1',
      timeZone: NY,
    });
    expect(r.code).toBe('deferred');
    clock.at = NY_0800;
    await svc.drain();
    expect(sent.map((m) => m.title)).toEqual([]);
  });

  it('U3 [C-693-4]: a connection refused before the request reached Expo is retried, not dropped', async () => {
    const clock = { at: NY_AFTERNOON };
    const w = pushOutboxWorld({ now: () => clock.at, tokens: { 'u-1': TOKEN } });
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }),
    });
    const client = new FetchExpoPushClient(async () => {
      throw refused;
    });
    const svc = new Clocked(Object.create(w.db), client, clock);
    await svc.enqueue({
      userId: 'u-1',
      kind: NotificationKind.MESSAGE_RECEIVED,
      title: 'New message',
      body: 'New message from Coach K',
      data: {},
      collapseKey: 'message_received:tgp://messages/u-1',
      timeZone: NY,
    });
    await svc.drain();
    expect(w.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'provider_retry' });
  });

  it('U4 [control]: lock-screen copy for every emitter kind carries no health value and no message text', () => {
    const cases: Array<[string, string]> = [
      [NotificationKind.WEIGHT_TREND_ALERT, 'Your weight is down 4.2 lb this week'],
      [NotificationKind.MILESTONE_REACHED, 'Milestone reached: 30 day streak, 12 lb lost'],
      [NotificationKind.MISSED_CHECKIN, 'Jane Doe has missed 3 check-ins. Last active: 3 days ago.'],
      [NotificationKind.CHECKIN_SUBMITTED, 'Jane Doe checked in: mood 2/10, weight 181 lb'],
      [NotificationKind.COACH_ALERT, 'Jane Doe reported chest pain after the workout'],
      [NotificationKind.BUILD_WEEK_DAY_UNLOCKED, 'Day 3: Gut health and fasting glucose'],
      [NotificationKind.MESSAGE_RECEIVED, 'New message from Coach K'],
      ['some_future_kind', 'Your A1C result is 7.9'],
    ];
    for (const [kind, inbox] of cases) {
      const c = lockScreenCopy(kind, inbox, null);
      const text = `${c.title} ${c.body}`;
      expect(text).not.toMatch(/\d+(\.\d+)?\s*(lb|kg|%)|chest|glucose|A1C|mood|streak|Jane/i);
      expect(text).not.toMatch(/!|[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});
