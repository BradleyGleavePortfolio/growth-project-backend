import {
  APPLICATION_STATUSES,
  TERMINAL_STATUSES,
  isApplicationStatus,
  isTerminalStatus,
} from '../application-status';

describe('application-status — TM-9 lifecycle', () => {
  it('exposes exactly the persisted Prisma ApplicationStatus values', () => {
    expect([...APPLICATION_STATUSES]).toEqual([
      'submitted',
      'screening',
      'shortlisted',
      'offered',
      'placed',
      'rejected',
      'withdrawn',
    ]);
  });

  describe('isApplicationStatus', () => {
    it('accepts known values', () => {
      expect(isApplicationStatus('submitted')).toBe(true);
    });
    it('rejects unknown / non-string', () => {
      expect(isApplicationStatus('interview')).toBe(false);
      expect(isApplicationStatus(42)).toBe(false);
      expect(isApplicationStatus(undefined)).toBe(false);
    });
  });

  describe('terminal states', () => {
    it('placed / rejected / withdrawn are terminal', () => {
      expect([...TERMINAL_STATUSES].sort()).toEqual([
        'placed',
        'rejected',
        'withdrawn',
      ]);
      for (const s of TERMINAL_STATUSES) expect(isTerminalStatus(s)).toBe(true);
    });

    it('non-terminal states are not terminal', () => {
      expect(isTerminalStatus('submitted')).toBe(false);
      expect(isTerminalStatus('screening')).toBe(false);
      expect(isTerminalStatus('shortlisted')).toBe(false);
      expect(isTerminalStatus('offered')).toBe(false);
    });
  });
});
