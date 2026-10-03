/**
 * B-643-1: pure local-time helpers used by notification copy.
 */
import {
  dayLabel,
  formatClock,
  formatDateTime,
  usableTimeZone,
} from '../src/notifications/local-time';
import {
  resolveRecipientTimeZone,
  resolveRecipientTimeZoneWithSource,
} from '../src/notifications/recipient-timezone';
import type { PrismaService } from '../src/prisma.service';

describe('usableTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(usableTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(usableTimeZone(' Europe/London ')).toBe('Europe/London');
  });

  it('rejects UTC aliases (the mobile fallback value), junk and non-strings', () => {
    for (const tz of ['UTC', 'utc', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Zulu', 'Universal', 'UCT']) {
      expect([tz, usableTimeZone(tz)]).toEqual([tz, null]);
    }
    for (const tz of ['', 'Mars/Olympus', 'x'.repeat(65), null, undefined, 42]) {
      expect(usableTimeZone(tz)).toBeNull();
    }
  });
});

describe('formatClock / formatDateTime', () => {
  const d = new Date('2026-06-02T15:30:00Z');
  it('render in the zone, with the zone named and a plain space', () => {
    expect(formatClock(d, 'America/Los_Angeles')).toBe('8:30 AM PDT');
    expect(formatClock(d, 'America/New_York')).toBe('11:30 AM EDT');
    expect(formatDateTime(d, 'America/Los_Angeles')).toBe('Tue, Jun 2 at 8:30 AM PDT');
    expect(formatClock(d, 'America/Los_Angeles')).not.toMatch(/[\u202f\u00a0]/);
  });

  it('follow daylight saving (winter is PST)', () => {
    expect(formatClock(new Date('2026-12-02T16:30:00Z'), 'America/Los_Angeles')).toBe(
      '8:30 AM PST',
    );
  });
});

describe('dayLabel', () => {
  const tz = 'America/Los_Angeles';
  it('today / tomorrow follow the LOCAL calendar, not "24 hours from now"', () => {
    // 00:05 PDT; a session 23 h 50 m later is 11:55 PM the SAME local day.
    const now = new Date('2026-06-02T07:05:00Z');
    expect(dayLabel(new Date('2026-06-03T06:55:00Z'), tz, now)).toBe('today');
    // 5:30 PM PDT; 24 h later is tomorrow.
    const evening = new Date('2026-06-02T00:30:00Z');
    expect(dayLabel(new Date('2026-06-03T00:30:00Z'), tz, evening)).toBe('tomorrow');
  });

  it('weekday within a week, short date beyond', () => {
    const now = new Date('2026-06-01T18:00:00Z'); // Mon Jun 1
    expect(dayLabel(new Date('2026-06-04T18:00:00Z'), tz, now)).toBe('on Thursday');
    expect(dayLabel(new Date('2026-06-12T18:00:00Z'), tz, now)).toBe('on Jun 12');
  });
});

describe('resolveRecipientTimeZone', () => {
  function prisma(over: {
    prefs?: string | null;
    /** false = a toggle-created row: the zone was never supplied. */
    prefsStamped?: boolean;
    own?: string | null;
    sessionCoach?: string | null;
    assignedCoach?: string | null;
    fail?: boolean;
  }): PrismaService {
    // Object.create keeps the fake typed as PrismaService without a cast.
    return Object.create({
      notificationPreferences: {
        findUnique: jest.fn(async () => {
          if (over.fail) throw new Error('db down');
          if (over.prefs === undefined) return null;
          return {
            timezone: over.prefs,
            timezone_updated_at:
              over.prefsStamped === false ? null : new Date('2026-05-01T00:00:00Z'),
          };
        }),
      },
      coachProfile: {
        findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) => {
          if (where.user_id === 'u') return over.own === undefined ? null : { timezone: over.own };
          if (where.user_id === 'assigned-coach') {
            return over.assignedCoach === undefined ? null : { timezone: over.assignedCoach };
          }
          return over.sessionCoach === undefined ? null : { timezone: over.sessionCoach };
        }),
      },
      coachingSession: { findUnique: jest.fn(async () => ({ coach_id: 'coach' })) },
      user: { findUnique: jest.fn(async () => ({ coach_id: 'assigned-coach' })) },
    });
  }

  it('prefers the stored preference, then the own coach profile, then the booking coach', async () => {
    expect(
      await resolveRecipientTimeZone(
        prisma({ prefs: 'America/Denver', own: 'America/Chicago' }),
        'u',
        's',
      ),
    ).toBe('America/Denver');
    expect(
      await resolveRecipientTimeZone(prisma({ prefs: 'UTC', own: 'America/Chicago' }), 'u', 's'),
    ).toBe('America/Chicago');
    expect(
      await resolveRecipientTimeZone(prisma({ sessionCoach: 'America/Phoenix' }), 'u', 's'),
    ).toBe('America/Phoenix');
  });

  it('returns null with nothing usable, without Prisma, or when the lookup fails', async () => {
    expect(await resolveRecipientTimeZone(prisma({}), 'u', 's')).toBeNull();
    expect(await resolveRecipientTimeZone(undefined, 'u', 's')).toBeNull();
    expect(await resolveRecipientTimeZone(prisma({ fail: true }), 'u', 's')).toBeNull();
  });

  // Opus B-647-1 / Sol B-647-2: provenance. Fails on 3a93fbde, which
  // trusted any stored row (including the schema default).
  it('ignores a stored zone that was never supplied (toggle-created default row)', async () => {
    expect(
      await resolveRecipientTimeZone(
        prisma({ prefs: 'America/Los_Angeles', prefsStamped: false, own: 'America/New_York' }),
        'u',
        's',
      ),
    ).toBe('America/New_York');
    expect(
      await resolveRecipientTimeZone(
        prisma({ prefs: 'America/Los_Angeles', prefsStamped: false }),
        'u',
        's',
      ),
    ).toBeNull();
  });

  it('honours a genuinely supplied LA zone', async () => {
    expect(
      await resolveRecipientTimeZone(
        prisma({ prefs: 'America/Los_Angeles', own: 'America/New_York' }),
        'u',
        's',
      ),
    ).toBe('America/Los_Angeles');
  });

  it('outside a booking, a client falls back to their own coach zone, with the source named', async () => {
    expect(
      await resolveRecipientTimeZoneWithSource(prisma({ assignedCoach: 'America/Denver' }), 'u'),
    ).toEqual({ timeZone: 'America/Denver', source: 'assigned_coach' });
    expect(
      await resolveRecipientTimeZoneWithSource(
        prisma({ sessionCoach: 'America/Phoenix', assignedCoach: 'America/Denver' }),
        'u',
        's',
      ),
    ).toEqual({ timeZone: 'America/Phoenix', source: 'booking_coach' });
  });
});
