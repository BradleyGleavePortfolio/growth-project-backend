/**
 * S-SCHED-2: isIntervalBookable, the authoritative containment check the
 * booking and reschedule paths run (pure; no DB).
 */
import { computeOpenSlots, isIntervalBookable } from '../src/scheduling/slot-computer.service';

const TZ = 'America/Los_Angeles';
// Tuesday 2026-10-06 (PDT, UTC-7). day_of_week 2.
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 6, h + 7, m));
};

type Calendar = Omit<Parameters<typeof isIntervalBookable>[0], 'from' | 'to'>;

const base: Calendar = {
  coachTimezone: TZ,
  windows: [{ day_of_week: 2, start_minute: 9 * 60, end_minute: 12 * 60 }],
  overrides: [],
  bookings: [],
};

function bookable(start: string, end: string, extra: Partial<Calendar> = {}) {
  const s = at(start);
  const e = at(end);
  return isIntervalBookable({ ...base, ...extra, from: s, to: e }, s, e);
}

describe('isIntervalBookable', () => {
  it('accepts an interval fully inside a window, including its edges', () => {
    expect(bookable('09:00', '09:30')).toBe(true);
    expect(bookable('11:30', '12:00')).toBe(true);
  });

  it('refuses an interval that leaves the window on either side', () => {
    expect(bookable('08:45', '09:15')).toBe(false);
    expect(bookable('11:45', '12:15')).toBe(false);
  });

  it('refuses overlap with an occupying booking but allows back-to-back', () => {
    const bookings = [{ start_at: at('10:00'), end_at: at('10:30') }];
    expect(bookable('10:15', '10:45', { bookings })).toBe(false);
    expect(bookable('09:30', '10:00', { bookings })).toBe(true);
    expect(bookable('10:30', '11:00', { bookings })).toBe(true);
  });

  it('accepts an off-grid start that the slot list would not show (containment, not grid)', () => {
    const bookings = [{ start_at: at('09:00'), end_at: at('09:10') }];
    expect(bookable('09:10', '09:40', { bookings })).toBe(true);
    const listed = computeOpenSlots({
      ...base,
      bookings,
      from: at('09:00'),
      to: at('12:00'),
      durationMinutes: 30,
    }).map((s) => s.start_at);
    expect(listed[0]).toBe(at('09:10').toISOString());
  });

  it('honours holidays, blocks and extra hours', () => {
    expect(
      bookable('10:00', '10:30', {
        overrides: [{ date: '2026-10-06', kind: 'holiday', start_minute: null, end_minute: null }],
      }),
    ).toBe(false);
    expect(
      bookable('10:00', '10:30', {
        overrides: [{ date: '2026-10-06', kind: 'block', start_minute: 600, end_minute: 615 }],
      }),
    ).toBe(false);
    expect(
      bookable('12:00', '12:30', {
        overrides: [{ date: '2026-10-06', kind: 'extra', start_minute: 720, end_minute: 780 }],
      }),
    ).toBe(true);
  });

  it('merges a window with abutting extra hours', () => {
    expect(
      bookable('11:45', '12:15', {
        overrides: [{ date: '2026-10-06', kind: 'extra', start_minute: 720, end_minute: 780 }],
      }),
    ).toBe(true);
  });

  it('refuses empty, inverted or unreadable intervals', () => {
    const s = at('10:00');
    expect(isIntervalBookable({ ...base, from: s, to: s }, s, s)).toBe(false);
    expect(isIntervalBookable({ ...base, from: s, to: s }, at('10:30'), s)).toBe(false);
    expect(isIntervalBookable({ ...base, from: s, to: s }, new Date('x'), s)).toBe(false);
  });
});
