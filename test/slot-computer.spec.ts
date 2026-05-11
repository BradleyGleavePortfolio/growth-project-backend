import {
  computeOpenSlots,
  validateRange,
  AvailabilityWindow,
  AvailabilityOverride,
  SessionInterval,
} from '../src/scheduling/slot-computer.service';

// Pure-function tests — no Nest, no Prisma, no mocks. Every input is
// a plain object; every assertion is on the returned shape.

const UTC = 'UTC';
const LA = 'America/Los_Angeles';

function iso(s: string): Date {
  return new Date(s);
}

describe('SlotComputerService', () => {
  describe('validateRange', () => {
    it('rejects from > to', () => {
      const err = validateRange(iso('2026-05-12T10:00:00Z'), iso('2026-05-11T10:00:00Z'));
      expect(err?.code).toBe('BAD_RANGE');
    });

    it('rejects range > 14 days', () => {
      const err = validateRange(iso('2026-05-01T00:00:00Z'), iso('2026-05-16T00:00:00Z'));
      expect(err?.code).toBe('RANGE_TOO_LARGE');
    });

    it('accepts a 7-day range', () => {
      expect(validateRange(iso('2026-05-01T00:00:00Z'), iso('2026-05-08T00:00:00Z'))).toBeNull();
    });

    it('rejects from === to (zero duration)', () => {
      const t = iso('2026-05-12T10:00:00Z');
      expect(validateRange(t, t)?.code).toBe('BAD_RANGE');
    });
  });

  describe('computeOpenSlots — empty inputs', () => {
    it('returns no slots when no windows', () => {
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-14T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows: [],
        overrides: [],
        bookings: [],
      });
      expect(slots).toEqual([]);
    });
  });

  describe('computeOpenSlots — basic window in UTC', () => {
    it('materializes a Mon 9-11am window into two 60-min slots', () => {
      // 2026-05-11 is a Monday.
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides: [],
        bookings: [],
      });
      expect(slots).toEqual([
        { start_at: '2026-05-11T09:00:00.000Z', end_at: '2026-05-11T10:00:00.000Z' },
        { start_at: '2026-05-11T10:00:00.000Z', end_at: '2026-05-11T11:00:00.000Z' },
      ]);
    });
  });

  describe('computeOpenSlots — full-day HOLIDAY removes the day entirely', () => {
    it('zeroes out the window on a holiday', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const overrides: AvailabilityOverride[] = [
        { date: '2026-05-11', start_minute: null, end_minute: null, kind: 'holiday' },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides,
        bookings: [],
      });
      expect(slots).toEqual([]);
    });
  });

  describe('computeOpenSlots — partial BLOCK trims a window', () => {
    it('subtracts a 10-11am block leaving a single 9-10 slot', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const overrides: AvailabilityOverride[] = [
        { date: '2026-05-11', start_minute: 10 * 60, end_minute: 11 * 60, kind: 'block' },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides,
        bookings: [],
      });
      expect(slots).toEqual([
        { start_at: '2026-05-11T09:00:00.000Z', end_at: '2026-05-11T10:00:00.000Z' },
      ]);
    });
  });

  describe('computeOpenSlots — EXTRA adds availability on a HOLIDAY day', () => {
    it('puts back a 14:00-15:00 slot on a holiday', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const overrides: AvailabilityOverride[] = [
        { date: '2026-05-11', start_minute: null, end_minute: null, kind: 'holiday' },
        { date: '2026-05-11', start_minute: 14 * 60, end_minute: 15 * 60, kind: 'extra' },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides,
        bookings: [],
      });
      expect(slots).toEqual([
        { start_at: '2026-05-11T14:00:00.000Z', end_at: '2026-05-11T15:00:00.000Z' },
      ]);
    });
  });

  describe('computeOpenSlots — existing booking is subtracted', () => {
    it('removes a slot overlapped by a booking', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const bookings: SessionInterval[] = [
        { start_at: iso('2026-05-11T09:00:00Z'), end_at: iso('2026-05-11T10:00:00Z') },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides: [],
        bookings,
      });
      expect(slots).toEqual([
        { start_at: '2026-05-11T10:00:00.000Z', end_at: '2026-05-11T11:00:00.000Z' },
      ]);
    });
  });

  describe('computeOpenSlots — duration > window yields no slot', () => {
    it('returns nothing when window is 1h but duration is 90m', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 10 * 60 },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 90,
        coachTimezone: UTC,
        windows,
        overrides: [],
        bookings: [],
      });
      expect(slots).toEqual([]);
    });
  });

  describe('computeOpenSlots — coach in LA, client in Tokyo, DST honored', () => {
    it('expands a Mon 9-11am LA window to the right UTC minute', () => {
      // 2026-05-11 LA is daylight time (UTC-7). 09:00 LA = 16:00 UTC.
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T08:00:00Z'),
        durationMinutes: 60,
        coachTimezone: LA,
        windows,
        overrides: [],
        bookings: [],
      });
      expect(slots).toEqual([
        { start_at: '2026-05-11T16:00:00.000Z', end_at: '2026-05-11T17:00:00.000Z' },
        { start_at: '2026-05-11T17:00:00.000Z', end_at: '2026-05-11T18:00:00.000Z' },
      ]);
    });
  });

  describe('computeOpenSlots — clipping to requested range', () => {
    it('drops slots outside [from, to]', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 11 * 60 },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T09:30:00Z'),
        to: iso('2026-05-11T12:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides: [],
        bookings: [],
      });
      // Slots are sliced from the clip point onward; a from=09:30
      // request produces 09:30-10:30 (the tail 10:30-11:00 is shorter
      // than one duration and is discarded).
      expect(slots).toEqual([
        { start_at: '2026-05-11T09:30:00.000Z', end_at: '2026-05-11T10:30:00.000Z' },
      ]);
    });
  });

  describe('computeOpenSlots — multiple bookings + overrides combined', () => {
    it('handles a realistic week-day mix', () => {
      const windows: AvailabilityWindow[] = [
        { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
      ];
      const overrides: AvailabilityOverride[] = [
        { date: '2026-05-11', start_minute: 12 * 60, end_minute: 13 * 60, kind: 'block' },
      ];
      const bookings: SessionInterval[] = [
        { start_at: iso('2026-05-11T15:00:00Z'), end_at: iso('2026-05-11T16:00:00Z') },
      ];
      const slots = computeOpenSlots({
        from: iso('2026-05-11T00:00:00Z'),
        to: iso('2026-05-12T00:00:00Z'),
        durationMinutes: 60,
        coachTimezone: UTC,
        windows,
        overrides,
        bookings,
      });
      // 9-10, 10-11, 11-12 (12-13 blocked), 13-14, 14-15 (15-16 booked), 16-17.
      expect(slots.map((s) => s.start_at)).toEqual([
        '2026-05-11T09:00:00.000Z',
        '2026-05-11T10:00:00.000Z',
        '2026-05-11T11:00:00.000Z',
        '2026-05-11T13:00:00.000Z',
        '2026-05-11T14:00:00.000Z',
        '2026-05-11T16:00:00.000Z',
      ]);
    });
  });
});
