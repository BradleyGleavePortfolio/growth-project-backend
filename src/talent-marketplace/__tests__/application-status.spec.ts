import {
  APPLICATION_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
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

    it('a terminal state allows no further transition', () => {
      for (const from of TERMINAL_STATUSES) {
        for (const to of APPLICATION_STATUSES) {
          expect(canTransition(from, to)).toBe(false);
        }
      }
    });
  });

  describe('transition matrix', () => {
    it('allows the forward hirer path', () => {
      expect(canTransition('submitted', 'screening')).toBe(true);
      expect(canTransition('screening', 'shortlisted')).toBe(true);
      expect(canTransition('shortlisted', 'offered')).toBe(true);
      expect(canTransition('offered', 'placed')).toBe(true);
    });

    it('allows withdraw from any non-terminal state', () => {
      expect(canTransition('submitted', 'withdrawn')).toBe(true);
      expect(canTransition('offered', 'withdrawn')).toBe(true);
    });

    it('rejects backward / illegal transitions', () => {
      expect(canTransition('offered', 'submitted')).toBe(false);
      expect(canTransition('placed', 'screening')).toBe(false);
      expect(canTransition('submitted', 'placed')).toBe(false);
    });
  });
});
