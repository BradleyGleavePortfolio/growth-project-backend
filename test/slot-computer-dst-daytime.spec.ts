import {
  computeOpenSlots,
  isIntervalBookable,
  type ComputeInput,
} from '../src/scheduling/slot-computer.service';

function sunday(date: string): ComputeInput {
  return {
    from: new Date(`${date}T00:00:00Z`),
    to: new Date(`${date}T23:59:59Z`),
    durationMinutes: 60,
    coachTimezone: 'America/Los_Angeles',
    windows: [{ day_of_week: 0, start_minute: 540, end_minute: 660 }],
    overrides: [],
    bookings: [],
  };
}

describe('ordinary daytime bookings on a DST change day', () => {
  it('lists the saved 9–11 AM hours on November 1, not 8–10 AM', () => {
    expect(computeOpenSlots(sunday('2026-11-01'))).toEqual([
      { start_at: '2026-11-01T17:00:00.000Z', end_at: '2026-11-01T18:00:00.000Z' },
      { start_at: '2026-11-01T18:00:00.000Z', end_at: '2026-11-01T19:00:00.000Z' },
    ]);
  });

  it('does not let a client request 8 AM outside the coach’s 9 AM opening', () => {
    const input = sunday('2026-11-01');
    expect(isIntervalBookable(
      input, new Date('2026-11-01T16:00:00Z'), new Date('2026-11-01T17:00:00Z'),
    )).toBe(false);
    expect(isIntervalBookable(
      input, new Date('2026-11-01T18:00:00Z'), new Date('2026-11-01T19:00:00Z'),
    )).toBe(true);
  });

  it('applies a saved 10–11 AM block in the same local hours as the window', () => {
    const input = sunday('2026-11-01');
    input.overrides = [
      { date: '2026-11-01', kind: 'block', start_minute: 600, end_minute: 660 },
    ];
    expect(computeOpenSlots(input)).toEqual([
      { start_at: '2026-11-01T17:00:00.000Z', end_at: '2026-11-01T18:00:00.000Z' },
    ]);
  });

  it('lists the saved 9–11 AM hours on spring-forward day, not 10–12 PM', () => {
    expect(computeOpenSlots(sunday('2026-03-08'))).toEqual([
      { start_at: '2026-03-08T16:00:00.000Z', end_at: '2026-03-08T17:00:00.000Z' },
      { start_at: '2026-03-08T17:00:00.000Z', end_at: '2026-03-08T18:00:00.000Z' },
    ]);
  });
});
