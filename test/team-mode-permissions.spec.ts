import {
  PERMISSION_MATRIX,
  can,
  canAll,
} from '../src/common/team-mode/permissions';
import {
  TEAM_ACTIONS,
  TEAM_ROLES,
  TeamAction,
  TeamRole,
  TeamScope,
} from '../src/common/team-mode/roles';

// These tests cover the pure permission resolver shipped in the
// foundation PR. They are intentionally exhaustive on the matrix:
// any drift between the ADR table and the code will surface here.
//
// Nothing in the runtime calls this resolver yet (see the directory
// README); these tests exist so the contract is locked in before
// the wiring PR.

const PLATFORM_OWNER = { teamRole: null, isPlatformOwner: true } as const;
const NO_TEAM = { teamRole: null, isPlatformOwner: false } as const;

function actor(teamRole: TeamRole) {
  return { teamRole, isPlatformOwner: false };
}

describe('team-mode permissions — platform OWNER bypass', () => {
  it.each(TEAM_ACTIONS)('platform OWNER may perform %s at any scope', (action) => {
    const scopes: TeamScope[] = ['self', 'assigned', 'team', 'global'];
    for (const scope of scopes) {
      expect(
        can({
          actor: PLATFORM_OWNER,
          action,
          scope,
          context: { isAssigned: false, sameTeam: false },
        }),
      ).toBe(true);
    }
  });

  it('platform OWNER bypasses the explicit deny on team.transfer_ownership', () => {
    expect(
      can({
        actor: PLATFORM_OWNER,
        action: 'team.transfer_ownership',
        scope: 'team',
        context: { sameTeam: false },
      }),
    ).toBe(true);
  });
});

describe('team-mode permissions — actors with no team role', () => {
  it.each(TEAM_ACTIONS)('non-platform-owner with no team role is denied %s', (action) => {
    expect(
      can({
        actor: NO_TEAM,
        action,
        scope: 'self',
        context: { sameTeam: true, isAssigned: true },
      }),
    ).toBe(false);
  });
});

describe('team-mode permissions — team_owner', () => {
  const a = actor('team_owner');

  it('can manage staff team-wide', () => {
    for (const action of [
      'staff.invite',
      'staff.revoke',
      'staff.promote_to_head_coach',
      'staff.demote_head_coach',
    ] as TeamAction[]) {
      expect(can({ actor: a, action, scope: 'team', context: { sameTeam: true } })).toBe(true);
    }
  });

  it('cannot transfer ownership of their own team — platform OWNER only', () => {
    expect(
      can({
        actor: a,
        action: 'team.transfer_ownership',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
  });

  it('can view team metrics with sameTeam=true', () => {
    expect(
      can({ actor: a, action: 'metrics.view_team', scope: 'team', context: { sameTeam: true } }),
    ).toBe(true);
  });

  it('cannot view team metrics in a different team', () => {
    expect(
      can({ actor: a, action: 'metrics.view_team', scope: 'team', context: { sameTeam: false } }),
    ).toBe(false);
  });

  it('can open billing portal team-wide', () => {
    expect(
      can({
        actor: a,
        action: 'team.open_billing_portal',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(true);
  });
});

describe('team-mode permissions — head_coach', () => {
  const a = actor('head_coach');

  it('can view client health team-wide', () => {
    expect(
      can({
        actor: a,
        action: 'client.view_health',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(true);
  });

  it('can reassign a client', () => {
    expect(
      can({
        actor: a,
        action: 'client.reassign',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(true);
  });

  it('cannot invite or revoke staff', () => {
    expect(
      can({ actor: a, action: 'staff.invite', scope: 'team', context: { sameTeam: true } }),
    ).toBe(false);
    expect(
      can({ actor: a, action: 'staff.revoke', scope: 'team', context: { sameTeam: true } }),
    ).toBe(false);
  });

  it('cannot edit branding or open billing portal', () => {
    expect(
      can({
        actor: a,
        action: 'team.edit_branding',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
    expect(
      can({
        actor: a,
        action: 'team.open_billing_portal',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
  });
});

describe('team-mode permissions — junior_coach', () => {
  const a = actor('junior_coach');

  it('can view a client only when assigned and same team', () => {
    const yes = can({
      actor: a,
      action: 'client.view_profile',
      scope: 'assigned',
      context: { sameTeam: true, isAssigned: true },
    });
    expect(yes).toBe(true);

    const noUnassigned = can({
      actor: a,
      action: 'client.view_profile',
      scope: 'assigned',
      context: { sameTeam: true, isAssigned: false },
    });
    expect(noUnassigned).toBe(false);

    const noOtherTeam = can({
      actor: a,
      action: 'client.view_profile',
      scope: 'assigned',
      context: { sameTeam: false, isAssigned: true },
    });
    expect(noOtherTeam).toBe(false);
  });

  it('cannot reassign clients', () => {
    expect(
      can({
        actor: a,
        action: 'client.reassign',
        scope: 'assigned',
        context: { sameTeam: true, isAssigned: true },
      }),
    ).toBe(false);
  });

  it('cannot view team-wide metrics', () => {
    expect(
      can({ actor: a, action: 'metrics.view_team', scope: 'team', context: { sameTeam: true } }),
    ).toBe(false);
  });

  it('can view their own metrics', () => {
    expect(can({ actor: a, action: 'metrics.view_self', scope: 'self' })).toBe(true);
  });

  it('cannot escalate by asking for team scope on an assigned-only grant', () => {
    expect(
      can({
        actor: a,
        action: 'client.view_profile',
        scope: 'team',
        context: { sameTeam: true, isAssigned: true },
      }),
    ).toBe(false);
  });
});

describe('team-mode permissions — setter', () => {
  const a = actor('setter');

  it('can message leads team-wide', () => {
    expect(
      can({ actor: a, action: 'lead.message', scope: 'team', context: { sameTeam: true } }),
    ).toBe(true);
  });

  it('cannot view client profiles or message paying clients', () => {
    expect(
      can({
        actor: a,
        action: 'client.view_profile',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
    expect(
      can({
        actor: a,
        action: 'client.message',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
  });

  it('cannot view roster', () => {
    expect(
      can({ actor: a, action: 'roster.view', scope: 'team', context: { sameTeam: true } }),
    ).toBe(false);
  });
});

describe('team-mode permissions — ops', () => {
  const a = actor('ops');

  it('can edit branding and manage invite codes', () => {
    expect(
      can({
        actor: a,
        action: 'team.edit_branding',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(true);
    expect(
      can({
        actor: a,
        action: 'team.manage_invite_codes',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(true);
  });

  it('cannot view client health', () => {
    expect(
      can({
        actor: a,
        action: 'client.view_health',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
  });

  it('cannot open billing portal', () => {
    expect(
      can({
        actor: a,
        action: 'team.open_billing_portal',
        scope: 'team',
        context: { sameTeam: true },
      }),
    ).toBe(false);
  });
});

describe('team-mode permissions — client', () => {
  const a = actor('client');

  it.each(TEAM_ACTIONS)('client has no team-management permission for %s', (action) => {
    expect(
      can({
        actor: a,
        action,
        scope: 'self',
        context: { sameTeam: true, isAssigned: true },
      }),
    ).toBe(false);
  });
});

describe('team-mode permissions — matrix completeness', () => {
  it('every TeamRole has a row in the matrix', () => {
    for (const role of TEAM_ROLES) {
      expect(PERMISSION_MATRIX[role]).toBeDefined();
    }
  });

  it('every staff role row uses only known TeamAction keys', () => {
    const known = new Set(TEAM_ACTIONS);
    for (const role of TEAM_ROLES) {
      for (const key of Object.keys(PERMISSION_MATRIX[role])) {
        expect(known.has(key as TeamAction)).toBe(true);
      }
    }
  });

  it('staff roles (excluding client) cover every TeamAction explicitly', () => {
    // Catches drift: if a new TeamAction is added to roles.ts, the
    // matrix must be updated. `client` is intentionally exempt.
    const staff: TeamRole[] = [
      'team_owner',
      'head_coach',
      'junior_coach',
      'setter',
      'ops',
    ];
    for (const role of staff) {
      const row = PERMISSION_MATRIX[role];
      const missing = TEAM_ACTIONS.filter((action) => !(action in row));
      expect(missing).toEqual([]);
    }
  });
});

describe('team-mode permissions — canAll composer', () => {
  it('returns true only when every action passes', () => {
    const a = actor('team_owner');
    expect(
      canAll(
        { actor: a, scope: 'team', context: { sameTeam: true } },
        ['client.view_profile', 'client.message'],
      ),
    ).toBe(true);

    expect(
      canAll(
        { actor: a, scope: 'team', context: { sameTeam: true } },
        ['client.view_profile', 'team.transfer_ownership'],
      ),
    ).toBe(false);
  });
});
