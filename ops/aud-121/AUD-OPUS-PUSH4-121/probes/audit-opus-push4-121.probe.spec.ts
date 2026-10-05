/**
 * AUD-OPUS-PUSH4-121 (Claude Opus 5.5 lens, agent 121) unit probes on backend
 * #693 @ cc0a167f (tree includes #692 @ 346cf4a8). Audit-only file: never merge.
 *
 * Replay of AUD-OPUS-PUSH-120 (expected at this head):
 *   U1 [B-693-1, fixed]   PASS: every channelId is one the mobile app creates.
 *   U2 [C-693-3, ruled C] FAIL by design: a deferred "Session confirmed" for a
 *                         session cancelled overnight is still sent at 08:00.
 *   U3 [C-693-4, ruled C] FAIL by design: connection refused is dropped.
 *   U4 [control]          PASS: lock-screen copy has no health value / text.
 * New at PUSH4:
 *   U5  every NotificationKind (and an unknown kind), fed PII inbox text and a
 *       PII display name in the context: lock screen shows no name, email,
 *       health value, exclamation mark, emoji or first person.
 *   U6  ruling: reminder pushes show the session time and no name.
 *   U7  quiet hours open between the handoff CAS and the send: nothing is
 *       sent, handed_off_at is cleared (sweep releases, never closes), the
 *       attempt is refunded, the row waits for 08:00.
 *   U8  a handoff CAS write that throws: zero provider calls, bounded retry.
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
const NY_205959 = new Date('2026-06-03T00:59:59Z'); // 20:59:59 EDT Jun 2
const NY_2100_30 = new Date('2026-06-03T01:00:30Z'); // 21:00:30 EDT Jun 2

// mobile main b79ca594 src/notifications/push-channels.ts PUSH_CHANNEL values.
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

describe('AUD-OPUS-PUSH4-121 replay of AUD-OPUS-PUSH-120 (#693 @ cc0a167f)', () => {
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
      await svc.enqueue({ userId: 'u-1', kind, title: 't', body: 'b', data: {}, collapseKey: `${kind}:${key}`, timeZone: NY });
    }
    await svc.drain();
    expect(sent).toHaveLength(3);
    const unknown = sent.map((m) => m.channelId).filter((c) => c !== undefined && !MOBILE_ANDROID_CHANNELS.has(c));
    expect(unknown).toEqual([]);
  });

  it('U2 [C-693-3, ruled C]: a deferred "Session confirmed" whose session was cancelled overnight is not put on the lock screen at 08:00', async () => {
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
      body: 'Your session is confirmed. Open the app to see the details.',
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

  it('U3 [C-693-4, ruled C]: a connection refused before the request reached Expo is retried, not dropped', async () => {
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
      body: 'x',
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
      expect(text).not.toMatch(/\d+(\.\d+)?\s*(lb|kg|%)|chest|glucose|A1C|mood|streak|Jane|Coach K/i);
      expect(text).not.toMatch(/!|[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});

describe('AUD-OPUS-PUSH4-121 new probes (#692 @ 346cf4a8 + #693 @ cc0a167f)', () => {
  const PII_INBOX = 'Jane Doe <jane.doe@example.com> weighs 181 lb, A1C 7.9, said: call me at 555-0100!';
  const PII_CONTEXT = {
    sessionId: 's-1',
    scheduledAt: '2026-06-03T17:30:00.000Z',
    newScheduledAt: '2026-06-04T17:30:00.000Z',
    oldScheduledAt: '2026-06-03T17:30:00.000Z',
    timeZone: NY,
    otherPartyDisplayName: 'Jane Doe jane.doe@example.com 181 lb',
  };

  it('U5: every kind, fed PII inbox text and a PII display name, shows only fixed copy on the lock screen', () => {
    const kinds = [...Object.values(NotificationKind), 'some_future_kind'];
    const leaks: string[] = [];
    for (const kind of kinds) {
      for (const ctx of [null, PII_CONTEXT]) {
        const c = lockScreenCopy(kind, PII_INBOX, ctx, NY_AFTERNOON);
        const text = `${c.title} ${c.body}`;
        if (/jane|doe|example\.com|@|181|A1C|7\.9|555/i.test(text)) leaks.push(`${kind}: PII ${text}`);
        if (/!|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) leaks.push(`${kind}: punct/emoji ${text}`);
        if (/\b(I|I'm|me|my|we|our|us)\b/.test(text)) leaks.push(`${kind}: first person ${text}`);
        if (c.title.length === 0 || c.body.length === 0 || c.body.length > 178) leaks.push(`${kind}: length ${text}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('U6 [ruling]: reminder pushes show the session time and no name', () => {
    const r24 = lockScreenCopy(NotificationKind.BOOKING_REMINDER_24H, PII_INBOX, PII_CONTEXT, NY_AFTERNOON);
    const r1 = lockScreenCopy(NotificationKind.BOOKING_REMINDER_1H, PII_INBOX, PII_CONTEXT, NY_AFTERNOON);
    expect(r24).toEqual({ title: 'Session reminder', body: 'Your session is tomorrow at 1:30 PM EDT.' });
    expect(r1).toEqual({ title: 'Session starting soon', body: 'Your session starts at 1:30 PM EDT.' });
  });

  it('U7: quiet hours open between the handoff CAS and the send: zero sends, handoff cleared, attempt refunded, waits for 08:00', async () => {
    const clock = { at: NY_205959 };
    const w = pushOutboxWorld({ now: () => clock.at, tokens: { 'u-1': TOKEN } });
    const { client, sent } = recordingExpo();
    const svc = new Clocked(Object.create(w.db), client, clock);
    const r = await svc.enqueue({
      userId: 'u-1',
      kind: NotificationKind.MESSAGE_RECEIVED,
      title: 'New message',
      body: 'x',
      data: {},
      collapseKey: 'message_received:tgp://messages/u7',
      timeZone: NY,
    });
    expect(r.code).toBe('queued');
    const original = w.db.pushOutbox.updateMany.getMockImplementation();
    let jumped = false;
    w.db.pushOutbox.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      const out = original ? await original(args as never) : { count: 0 };
      if (args.data.handed_off_at instanceof Date && !jumped) {
        jumped = true;
        clock.at = NY_2100_30;
      }
      return out;
    });
    expect(await svc.drain()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(w.rows[0]).toMatchObject({
      status: 'pending',
      handed_off_at: null,
      lease_token: null,
      deferred_reason: 'quiet_hours',
      result_code: 'quiet-deferred',
      attempts: 0,
    });
    expect(w.rows[0].not_before.toISOString()).toBe('2026-06-03T12:00:00.000Z');
    // Next morning it is sent once.
    clock.at = NY_0800;
    expect(await svc.sweep()).toEqual({ sent: 1, expired: 0 });
    expect(sent).toHaveLength(1);
  });

  it('U8: a handoff CAS write that throws sends nothing and schedules a bounded worker retry', async () => {
    const clock = { at: NY_AFTERNOON };
    const w = pushOutboxWorld({ now: () => clock.at, tokens: { 'u-1': TOKEN } });
    const { client, sent } = recordingExpo();
    const svc = new Clocked(Object.create(w.db), client, clock);
    await svc.enqueue({
      userId: 'u-1',
      kind: NotificationKind.MILESTONE_REACHED,
      title: 't',
      body: 'b',
      data: {},
      collapseKey: 'milestone_reached:u8',
      timeZone: NY,
    });
    const original = w.db.pushOutbox.updateMany.getMockImplementation();
    let thrown = 0;
    w.db.pushOutbox.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (args.data.handed_off_at instanceof Date && thrown === 0) {
        thrown += 1;
        throw new Error('connection reset');
      }
      return original ? original(args as never) : { count: 0 };
    });
    expect(await svc.drain()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(w.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'worker_retry', handed_off_at: null });
  });
});
