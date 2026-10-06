import { NotificationKind } from '../src/notifications/notification-kind';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';

// B-692-1 (Sol): the lock screen shows only fixed per-kind templates. No
// caller text (inbox body, display name, message text) can reach it.

const PRIVATE = 'Jamie jamie@example.test diagnosis: diabetes, 212 lb, "please call me"';
const LEAK = /@|diabetes|diagnosis|jamie|212|lb|please/i;
const NOW = new Date('2026-06-02T18:00:00Z');

const ALL_KINDS = [
  ...Object.values(NotificationKind),
  'unknown_kind',
];
const BOOKING_KINDS = ALL_KINDS.filter((k) => k.startsWith('booking_'));

describe('lock-screen copy is template-only (B-692-1)', () => {
  it('never shows the inbox body or a display name, for every kind, with and without context', () => {
    for (const kind of ALL_KINDS) {
      for (const context of [
        null,
        {
          sessionId: 's-1',
          scheduledAt: '2026-06-03T19:00:00Z',
          newScheduledAt: '2026-06-03T19:00:00Z',
          oldScheduledAt: '2026-06-02T19:00:00Z',
          timeZone: 'America/New_York',
          otherPartyDisplayName: PRIVATE,
        },
      ]) {
        const copy = lockScreenCopy(kind, `New message from ${PRIVATE}`, context, NOW);
        expect(`${copy.title} ${copy.body}`).not.toMatch(LEAK);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('message pushes say only that a message arrived', () => {
    expect(lockScreenCopy(NotificationKind.MESSAGE_RECEIVED, `New message from ${PRIVATE}`)).toEqual({
      title: 'New message',
      body: 'You have a new message. Open the app to read it.',
    });
  });

  it('every booking kind has its own fixed template, whatever the inbox text', () => {
    for (const kind of BOOKING_KINDS) {
      const a = lockScreenCopy(kind, 'Coach K moved the session to Tue at 3:00 PM EDT.');
      const b = lockScreenCopy(kind, PRIVATE);
      expect(a).toEqual(b);
      expect(a.title).not.toBe('The Growth Project');
    }
  });

  it('reminders keep the session time, rendered from the stored instant in the recipient zone', () => {
    const context = {
      scheduledAt: '2026-06-03T19:00:00Z',
      timeZone: 'America/New_York',
      otherPartyDisplayName: PRIVATE,
    };
    expect(lockScreenCopy(NotificationKind.BOOKING_REMINDER_24H, PRIVATE, context, NOW)).toEqual({
      title: 'Session reminder',
      body: 'Your session is tomorrow at 3:00 PM EDT.',
    });
    expect(lockScreenCopy(NotificationKind.BOOKING_REMINDER_1H, PRIVATE, context, NOW)).toEqual({
      title: 'Session starting soon',
      body: 'Your session starts at 3:00 PM EDT.',
    });
    // No usable zone: no clock time, still no caller text.
    expect(
      lockScreenCopy(NotificationKind.BOOKING_REMINDER_1H, PRIVATE, { ...context, timeZone: 'UTC' }, NOW).body,
    ).toBe('Your session starts in about an hour. Open the app to see the details.');
  });

  it('AUDIT-09-125: content-unlocked and new-purchase pushes carry fixed copy only', () => {
    expect(lockScreenCopy(NotificationKind.DRIP_RELEASED, 'New content unlocked: PCOS meal plan')).toEqual({
      title: 'New content',
      body: 'New content from your coach is ready. Open the app to see it.',
    });
    expect(lockScreenCopy(NotificationKind.COACH_NEW_PURCHASE, 'Alex Buyer just bought Pro ($99.00)')).toEqual({
      title: 'New purchase',
      body: 'A client bought a package. Open the app to see it.',
    });
  });

  it('unknown kinds get the generic line', () => {
    expect(lockScreenCopy('something_new', PRIVATE)).toEqual({
      title: 'The Growth Project',
      body: 'You have a new notification. Open the app to see it.',
    });
  });

  it('copy rules: no exclamation marks, no emojis, no first person', () => {
    for (const kind of ALL_KINDS) {
      const { title, body } = lockScreenCopy(kind, '');
      const text = `${title} ${body}`;
      expect(text).not.toMatch(/!/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\b(we|our|us|I)\b/);
    }
  });
});
