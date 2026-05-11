import { ForbiddenException } from '@nestjs/common';
import {
  assertCanApproveOrDecline,
  assertCanCancel,
  assertCanCompleteOrNoShow,
  assertCanManageAvailability,
  assertCanRequestSession,
  assertCanViewSession,
} from '../src/scheduling/scheduling.permissions';

const COACH = { id: 'coach-1', role: 'coach' as const, coach_id: null };
const OTHER_COACH = { id: 'coach-2', role: 'coach' as const, coach_id: null };
const CLIENT = { id: 'client-1', role: 'student' as const, coach_id: 'coach-1' };
const FOREIGN_CLIENT = {
  id: 'client-9',
  role: 'student' as const,
  coach_id: 'coach-2',
};
const OWNER = { id: 'owner-1', role: 'owner' as const, coach_id: null };

const TARGET = { coach_id: 'coach-1', client_id: 'client-1' };

describe('Scheduling permissions', () => {
  describe('assertCanViewSession', () => {
    it('lets the lead coach view', () => {
      expect(() => assertCanViewSession(COACH, TARGET)).not.toThrow();
    });
    it('lets the lead client view', () => {
      expect(() => assertCanViewSession(CLIENT, TARGET)).not.toThrow();
    });
    it('lets owners view everything', () => {
      expect(() => assertCanViewSession(OWNER, TARGET)).not.toThrow();
    });
    it('blocks a coach for a session that is not theirs', () => {
      expect(() => assertCanViewSession(OTHER_COACH, TARGET)).toThrow(
        ForbiddenException,
      );
    });
    it('blocks a client whose coach_id does not match', () => {
      expect(() => assertCanViewSession(FOREIGN_CLIENT, TARGET)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('assertCanRequestSession', () => {
    it('allows a client to request a session with their coach', () => {
      expect(() => assertCanRequestSession(CLIENT, 'coach-1')).not.toThrow();
    });
    it('rejects a client requesting against a foreign coach', () => {
      expect(() => assertCanRequestSession(CLIENT, 'coach-2')).toThrow(
        ForbiddenException,
      );
    });
    it('rejects a coach trying to use the client request flow', () => {
      // Coaches must use the coach-side direct booking; the request
      // flow exists for clients, and audit clarity matters.
      expect(() => assertCanRequestSession(COACH, 'coach-1')).toThrow(
        ForbiddenException,
      );
    });
    it('allows owner-level booking', () => {
      expect(() => assertCanRequestSession(OWNER, 'coach-1')).not.toThrow();
    });
  });

  describe('assertCanApproveOrDecline', () => {
    it('allows the lead coach', () => {
      expect(() => assertCanApproveOrDecline(COACH, TARGET)).not.toThrow();
    });
    it('blocks the client', () => {
      expect(() => assertCanApproveOrDecline(CLIENT, TARGET)).toThrow(
        ForbiddenException,
      );
    });
    it('blocks a foreign coach', () => {
      expect(() => assertCanApproveOrDecline(OTHER_COACH, TARGET)).toThrow(
        ForbiddenException,
      );
    });
    it('allows owner', () => {
      expect(() => assertCanApproveOrDecline(OWNER, TARGET)).not.toThrow();
    });
  });

  describe('assertCanCancel', () => {
    it('allows both parties + owner', () => {
      expect(() => assertCanCancel(COACH, TARGET)).not.toThrow();
      expect(() => assertCanCancel(CLIENT, TARGET)).not.toThrow();
      expect(() => assertCanCancel(OWNER, TARGET)).not.toThrow();
    });
    it('blocks a foreign client', () => {
      expect(() => assertCanCancel(FOREIGN_CLIENT, TARGET)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('assertCanCompleteOrNoShow', () => {
    it('blocks the client', () => {
      expect(() => assertCanCompleteOrNoShow(CLIENT, TARGET)).toThrow(
        ForbiddenException,
      );
    });
    it('allows the lead coach', () => {
      expect(() => assertCanCompleteOrNoShow(COACH, TARGET)).not.toThrow();
    });
  });

  describe('assertCanManageAvailability', () => {
    it('lets a coach edit their own availability', () => {
      expect(() => assertCanManageAvailability(COACH, 'coach-1')).not.toThrow();
    });
    it("blocks a coach from editing another coach's availability", () => {
      expect(() => assertCanManageAvailability(COACH, 'coach-2')).toThrow(
        ForbiddenException,
      );
    });
    it('lets owner edit anyone', () => {
      expect(() => assertCanManageAvailability(OWNER, 'coach-9')).not.toThrow();
    });
  });
});
