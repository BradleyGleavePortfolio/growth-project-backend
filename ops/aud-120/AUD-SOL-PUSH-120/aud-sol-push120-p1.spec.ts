import { NotificationKind } from '../src/notifications/notification-kind';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { pushAllowedByPreferences } from '../src/notifications/push/push-preferences';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { FetchExpoPushClient } from '../src/notifications/push/expo-push-client';

describe('AUD-SOL-PUSH-120 P1 independent boundaries', () => {
  const privateDisplayName = 'Jamie jamie@example.test diagnosis: diabetes';

  it('does not forward arbitrary message-kind text onto a lock screen', () => {
    const copy = lockScreenCopy(
      NotificationKind.MESSAGE_RECEIVED,
      'New message from ' + privateDisplayName,
    );
    expect(copy.body).not.toMatch(/@|diabetes|diagnosis/i);
  });

  it('does not expose private text embedded in a booking display name', () => {
    const copy = lockScreenCopy(NotificationKind.BOOKING_REMINDER_1H, 'Reminder', {
      scheduledAt: '2026-06-02T19:00:00Z',
      timeZone: 'America/New_York',
      otherPartyDisplayName: privateDisplayName,
    });
    expect(copy.body).not.toMatch(/@|diabetes|diagnosis/i);
  });

  it('health kinds and unknown kinds replace rather than trust the inbox body', () => {
    for (const kind of [NotificationKind.WEIGHT_TREND_ALERT, NotificationKind.COACH_ALERT, 'unknown']) {
      expect(lockScreenCopy(kind, 'diagnosis: diabetes, jamie@example.test').body).not.toMatch(
        /@|diabetes|diagnosis/i,
      );
    }
  });

  it('master mute and individual switches override delivery', () => {
    expect(pushAllowedByPreferences({ muted: true }, NotificationKind.MESSAGE_RECEIVED)).toBe(false);
    expect(
      pushAllowedByPreferences({ muted: false, message_push: false }, NotificationKind.MESSAGE_RECEIVED),
    ).toBe(false);
    expect(pushAllowedByPreferences({ booking_push: true }, NotificationKind.BOOKING_REMINDER_1H)).toBe(
      true,
    );
  });

  it('quiet hours use the supplied client zone, including DST', () => {
    const q = quietHoursFor({
      kind: NotificationKind.MESSAGE_RECEIVED,
      timeZone: 'America/New_York',
      now: new Date('2026-11-01T02:00:00Z'),
    });
    expect(q.deferred).toBe(true);
    expect(q.deliverAt.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('the receipt transport forwards the cancellable signal and returns receipts', async () => {
    const controller = new AbortController();
    const fetcher = jest.fn(async (_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBe(controller.signal);
      return { ok: true, status: 200, json: async () => ({ data: { t1: { status: 'ok' } } }) };
    });
    const client = new FetchExpoPushClient(fetcher);
    await expect(client.getReceipts(['t1'], controller.signal)).resolves.toEqual({
      t1: { status: 'ok' },
    });
  });
});
