// test/team-mode-controller-tier-gate.spec.ts
//
// ADR-0001 §10 Q6 — controller tier gate.
//
// Pro and Enterprise pass through. Growth and unknown produce a 403
// with a structured envelope { kind: 'team_mode_locked', current_tier,
// required_tier: 'pro', upsell_url: '/pricing' }.

import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
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
  const tierResolver = {
    resolveTier: jest.fn(async () => ({
      tier,
      stripe_subscription_id: tier === 'unknown' ? null : 'sub_X',
      stripe_price_id: tier === 'unknown' ? null : `price_${tier}`,
    })),
  };
  const ctrl = new TeamModeController(
    teamModeService as never,
    tierResolver as never,
  );
  const req = { user: { id: 'head-1' } } as never;
  return { ctrl, req, teamModeService, tierResolver };
}

describe('TeamModeController tier gate', () => {
  it('Q6: allows Pro tier to assign a sub-coach', async () => {
    const { ctrl, req, teamModeService } = makeController('pro');
    await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    expect(teamModeService.assignSubCoach).toHaveBeenCalled();
  });

  it('Q6: allows Enterprise tier to assign a sub-coach', async () => {
    const { ctrl, req, teamModeService } = makeController('enterprise');
    await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    expect(teamModeService.assignSubCoach).toHaveBeenCalled();
  });

  it('Q6: blocks Growth tier with structured upsell envelope', async () => {
    const { ctrl, req, teamModeService } = makeController('growth');
    let thrown: unknown = null;
    try {
      await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    const body = (thrown as ForbiddenException).getResponse() as Record<string, unknown>;
    expect(body.kind).toBe('team_mode_locked');
    expect(body.current_tier).toBe('growth');
    expect(body.required_tier).toBe('pro');
    expect(body.upsell_url).toBe('/pricing');
    expect(teamModeService.assignSubCoach).not.toHaveBeenCalled();
  });

  it('Q6: blocks unknown tier (no CoachSubscription row) with the same envelope', async () => {
    const { ctrl, req, teamModeService } = makeController('unknown');
    let thrown: unknown = null;
    try {
      await ctrl.assignSubCoach(req, { sub_coach_id: 'sub-1' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    const body = (thrown as ForbiddenException).getResponse() as { kind: string; current_tier: string };
    expect(body.kind).toBe('team_mode_locked');
    expect(body.current_tier).toBe('unknown');
    expect(teamModeService.assignSubCoach).not.toHaveBeenCalled();
  });

  it('Q6: blocks Growth tier on the audit-events endpoint as well', async () => {
    const { ctrl, req } = makeController('growth');
    await expect(
      ctrl.listAuditEvents(req),
    ).rejects.toThrow(ForbiddenException);
  });

  it('Q6: blocks Growth tier on the remove-sub-coach endpoint', async () => {
    const { ctrl, req } = makeController('growth');
    await expect(
      ctrl.removeSubCoach(req, 'sub-1'),
    ).rejects.toThrow(ForbiddenException);
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
    // 400 is the right semantic for a malformed query parameter; a
    // mobile client must not treat this as an upsell prompt.
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
