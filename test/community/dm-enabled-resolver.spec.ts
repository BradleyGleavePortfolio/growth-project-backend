/**
 * Unit test for the G3 dm_enabled tri-state contract.
 *
 * CommunityService.resolveDmEnabled(membership, workspace) collapses the
 * nullable per-membership override against the workspace default:
 *   - membership.dm_enabled === true   → true  (explicit opt-in)
 *   - membership.dm_enabled === false  → false (explicit opt-out)
 *   - membership.dm_enabled === null   → workspace.dm_enabled_default
 *   - no membership                    → workspace.dm_enabled_default
 *   - no workspace + null/absent       → false (safe default)
 *
 * No database required — the resolver is pure.
 */

import { CommunityService } from '../../src/community/community.service';

// resolveDmEnabled is pure — it never reads `this.prisma` or `this.repo`, so
// the method is exercised off the prototype without constructing the service
// (which would otherwise require injecting Prisma + repository dependencies).
const resolveDmEnabled = CommunityService.prototype.resolveDmEnabled.bind(
  CommunityService.prototype,
);

describe('CommunityService.resolveDmEnabled (G3 tri-state)', () => {
  const service = { resolveDmEnabled };

  it('explicit true on membership wins over a false workspace default', () => {
    expect(
      service.resolveDmEnabled(
        { dm_enabled: true },
        { dm_enabled_default: false },
      ),
    ).toBe(true);
  });

  it('explicit false on membership wins over a true workspace default', () => {
    expect(
      service.resolveDmEnabled(
        { dm_enabled: false },
        { dm_enabled_default: true },
      ),
    ).toBe(false);
  });

  it('null membership override inherits the workspace default (true)', () => {
    expect(
      service.resolveDmEnabled(
        { dm_enabled: null },
        { dm_enabled_default: true },
      ),
    ).toBe(true);
  });

  it('null membership override inherits the workspace default (false)', () => {
    expect(
      service.resolveDmEnabled(
        { dm_enabled: null },
        { dm_enabled_default: false },
      ),
    ).toBe(false);
  });

  it('no membership falls back to the workspace default', () => {
    expect(
      service.resolveDmEnabled(null, { dm_enabled_default: true }),
    ).toBe(true);
  });

  it('no workspace and null override is a safe false', () => {
    expect(service.resolveDmEnabled({ dm_enabled: null }, null)).toBe(false);
    expect(service.resolveDmEnabled(null, null)).toBe(false);
  });
});
