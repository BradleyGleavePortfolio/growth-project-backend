// test/team-mode-controller-tier-gate.spec.ts
//
// Owner TM-P1 (2026-10-12): zero locks. Team Mode has no tier gate:
// every tier, including Growth and unknown (no CoachSubscription row),
// reaches every Team Mode route.

import 'reflect-metadata';
import { TeamModeController } from '../src/team-mode/team-mode.controller';

function makeController(tier: 'growth' | 'pro' | 'enterprise' | 'unknown') {
  const teamModeService = {
    assignSubCoach: jest.fn(async () => ({
      assignmentId: 'asn-1',
      stripeSubscriptionItemId: null,
      tier,
    })),
    removeSubCoach: jest.fn(async () => ({
      removed: true,
      reassignedClientCount: 0,
      stripeSubscriptionItemId: null,
    })),
    listSubCoaches: jest.fn(async () => []),
    listAuditEvents: jest.fn(async () => ({ data: [], next_cursor: null })),
  };
  const ctrl = new TeamModeController(teamModeService as never);
  const req = { user: { id: 'head-1' } } as never;
  return { ctrl, req, teamModeService };
}

describe('TeamModeController has no tier gate', () => {
  it('allows Pro tier to assign a sub-coach', async () => {
    const { ctrl, req, teamModeService } = makeController('pro');
    await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    expect(teamModeService.assignSubCoach).toHaveBeenCalled();
  });

  it('allows Enterprise tier to assign a sub-coach', async () => {
    const { ctrl, req, teamModeService } = makeController('enterprise');
    await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    expect(teamModeService.assignSubCoach).toHaveBeenCalled();
  });

  it.each(['growth', 'unknown'] as const)('TM-P1: allows %s tier on every route', async (tier) => {
    const { ctrl, req, teamModeService } = makeController(tier);
    await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    await ctrl.listSubCoaches(req);
    await ctrl.removeSubCoach(req, 'sub-1');
    await ctrl.listAuditEvents(req);
    expect(teamModeService.assignSubCoach).toHaveBeenCalled();
    expect(teamModeService.listSubCoaches).toHaveBeenCalled();
    expect(teamModeService.removeSubCoach).toHaveBeenCalled();
    expect(teamModeService.listAuditEvents).toHaveBeenCalled();
  });

  it('Q4: invalid event_kind returns 400 BadRequest, not 403 Forbidden', async () => {
    const { ctrl, req, teamModeService } = makeController('pro');
    let thrown: unknown = null;
    try {
      await ctrl.listAuditEvents(
        req,
        undefined,
        undefined,
        'not_a_real_event_kind',
      );
    } catch (err) {
      thrown = err;
    }
    // 400 is the right semantic for a malformed query parameter.
    const { BadRequestException } = await import('@nestjs/common');
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as InstanceType<typeof BadRequestException>).getResponse() as {
      kind: string;
      allowed: string[];
    };
    expect(body.kind).toBe('invalid_event_kind');
    expect(Array.isArray(body.allowed)).toBe(true);
    expect(teamModeService.listAuditEvents).not.toHaveBeenCalled();
  });
});
