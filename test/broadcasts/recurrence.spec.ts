import {
  localDateString,
  nextOccurrence,
  parseRecurrence,
  type RecurrenceRule,
} from '../../src/broadcasts/recurrence';
import { BroadcastHttpError } from '../../src/broadcasts/broadcast-errors';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('parseRecurrence', () => {
  it('accepts the coaching cadences and normalises weekdays', () => {
    expect(parseRecurrence({ freq: 'weekly', local_time: '07:30', by_weekday: [5, 1, 1] })).toEqual(
      {
        freq: 'weekly',
        interval: 1,
        local_time: '07:30',
        by_weekday: [1, 5],
      },
    );
  });

  it.each([
    [{ freq: 'hourly', local_time: '07:00' }, 'freq'],
    [{ freq: 'daily', local_time: '7:00' }, 'local_time'],
    [{ freq: 'daily', local_time: '24:00' }, 'local_time'],
    [{ freq: 'daily', local_time: '07:00', interval: 0 }, 'interval'],
    [{ freq: 'daily', local_time: '07:00', by_weekday: [1] }, 'by_weekday_needs_weekly'],
    [{ freq: 'monthly', local_time: '07:00', by_month_day: 32 }, 'by_month_day'],
    [{ freq: 'daily', local_time: '07:00', count: 0 }, 'count'],
    [
      { freq: 'daily', local_time: '07:00', anchor_date: '2026-01-01' },
      'unknown_field:anchor_date',
    ],
  ])('rejects %j with a coded error (%s)', (input, reason) => {
    try {
      parseRecurrence(input);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BroadcastHttpError);
      expect((err as BroadcastHttpError).getResponse()).toMatchObject({
        code: 'broadcast.recurrence_invalid',
        reason,
      });
    }
  });
});

describe('nextOccurrence', () => {
  const tz = 'America/New_York';

  it('daily at local 07:00 across the spring-forward DST change keeps the wall time', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      local_time: '07:00',
      anchor_date: '2027-03-12',
    };
    // 2027-03-13 07:00 EST = 12:00Z ; 2027-03-14 07:00 EDT = 11:00Z
    const a = nextOccurrence(rule, tz, new Date('2027-03-12T13:00:00Z'));
    expect(iso(a)).toBe('2027-03-13T12:00:00.000Z');
    const b = nextOccurrence(rule, tz, a as Date);
    expect(iso(b)).toBe('2027-03-14T11:00:00.000Z');
  });

  it('weekly Mon/Thu every 2 weeks counts weeks from the anchor week', () => {
    // Anchor Monday 2027-01-04.
    const rule: RecurrenceRule = {
      freq: 'weekly',
      interval: 2,
      local_time: '18:00',
      by_weekday: [1, 4],
      anchor_date: '2027-01-04',
    };
    const at = (s: string) => nextOccurrence(rule, 'UTC', new Date(s));
    expect(iso(at('2027-01-04T00:00:00Z'))).toBe('2027-01-04T18:00:00.000Z');
    expect(iso(at('2027-01-04T18:00:00Z'))).toBe('2027-01-07T18:00:00.000Z');
    // The off week (11th / 14th) is skipped.
    expect(iso(at('2027-01-07T18:00:00Z'))).toBe('2027-01-18T18:00:00.000Z');
  });

  it('monthly on the 31st uses the last day of shorter months', () => {
    const rule: RecurrenceRule = {
      freq: 'monthly',
      interval: 1,
      local_time: '09:00',
      by_month_day: 31,
      anchor_date: '2027-01-31',
    };
    const feb = nextOccurrence(rule, 'UTC', new Date('2027-01-31T10:00:00Z'));
    expect(iso(feb)).toBe('2027-02-28T09:00:00.000Z');
    expect(iso(nextOccurrence(rule, 'UTC', feb as Date))).toBe('2027-03-31T09:00:00.000Z');
  });

  it('stops after until', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      local_time: '09:00',
      until: '2027-01-02T12:00:00.000Z',
      anchor_date: '2027-01-01',
    };
    expect(iso(nextOccurrence(rule, 'UTC', new Date('2027-01-01T10:00:00Z')))).toBe(
      '2027-01-02T09:00:00.000Z',
    );
    expect(nextOccurrence(rule, 'UTC', new Date('2027-01-02T09:00:00Z'))).toBeNull();
  });

  it('is evaluated in the broadcast time zone, not UTC', () => {
    const rule: RecurrenceRule = {
      freq: 'daily',
      interval: 1,
      local_time: '08:00',
      anchor_date: '2027-06-01',
    };
    expect(iso(nextOccurrence(rule, 'Asia/Tokyo', new Date('2027-06-01T00:00:00Z')))).toBe(
      '2027-06-01T23:00:00.000Z',
    );
    expect(localDateString(new Date('2027-06-01T23:00:00Z'), 'Asia/Tokyo')).toBe('2027-06-02');
  });
});
