// B-AIASSIGN-125: start day for an approved AI workout program.
import { aiProgramStartIso } from '../../src/ai/coach/ai-program-start';

describe('aiProgramStartIso', () => {
  it('starts on the next Monday at 09:00 in the client zone', () => {
    // Tue 2026-10-06 15:00 PDT -> Mon 2026-10-12 09:00 PDT.
    expect(aiProgramStartIso(new Date('2026-10-06T22:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-10-12T16:00:00.000Z',
    );
  });

  it('on a Monday it starts the following Monday', () => {
    expect(aiProgramStartIso(new Date('2026-10-12T18:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-10-19T16:00:00.000Z',
    );
  });

  it("uses the draft's own start_date when it is a real date", () => {
    expect(aiProgramStartIso(new Date('2026-10-06T22:00:00Z'), 'America/New_York', '2026-10-08')).toBe(
      '2026-10-08T13:00:00.000Z',
    );
    expect(aiProgramStartIso(new Date('2026-10-06T22:00:00Z'), 'America/Los_Angeles', '2026-02-30')).toBe(
      '2026-10-12T16:00:00.000Z',
    );
  });

  it('falls back to UTC when the zone is unknown', () => {
    expect(aiProgramStartIso(new Date('2026-10-06T22:00:00Z'), null)).toBe('2026-10-12T09:00:00.000Z');
    expect(aiProgramStartIso(new Date('2026-10-06T22:00:00Z'), 'Not/AZone')).toBe('2026-10-12T09:00:00.000Z');
  });
});
