import { FeatureFlagsService } from '../feature-flags.service';
import { FEATURE_FLAG_KEYS } from '../feature-flags.dto';

/**
 * FeatureFlagsService unit tests — server-side flag evaluation (D5 = B+γ).
 *
 * Covers the env-gate resolution, the community master-gate dependency
 * (resolveCommunityFlag via FEATURE_COMMUNITY_API), and the coach/owner
 * role gate on coach_community_wearable_prompts.
 */

const FLAG_ENVS = [
  'FEATURE_COMMUNITY_API',
  'FEATURE_COMMUNITY_API_ALLOWLIST',
  'FEATURE_COMMUNITY_SEARCH',
  'FEATURE_COMMUNITY_WEARABLE_PROMPTS',
  'FEATURE_COMMUNITY_CLASSROOM_POSTS',
  'FEATURE_COMMUNITY_EVENTS',
] as const;

describe('FeatureFlagsService', () => {
  const saved: Record<string, string | undefined> = {};
  let service: FeatureFlagsService;

  beforeEach(() => {
    for (const k of FLAG_ENVS) saved[k] = process.env[k];
    for (const k of FLAG_ENVS) delete process.env[k];
    service = new FeatureFlagsService();
  });

  afterEach(() => {
    for (const k of FLAG_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns exactly the declared flag keys, all booleans', () => {
    const flags = service.evaluate({ userId: 'u1', role: 'student' });
    expect(Object.keys(flags).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
    for (const v of Object.values(flags)) expect(typeof v).toBe('boolean');
  });

  it('all flags OFF when the community master gate is off (even if per-flag envs are on)', () => {
    process.env.FEATURE_COMMUNITY_API = 'false';
    process.env.FEATURE_COMMUNITY_SEARCH = 'true';
    process.env.FEATURE_COMMUNITY_CLASSROOM_POSTS = 'true';
    process.env.FEATURE_COMMUNITY_EVENTS = 'true';
    process.env.FEATURE_COMMUNITY_WEARABLE_PROMPTS = 'true';

    const flags = service.evaluate({ userId: 'u1', role: 'coach' });
    expect(flags).toEqual({
      community_search: false,
      coach_community_wearable_prompts: false,
      community_classroom: false,
      community_events: false,
    });
  });

  it('resolves per-flag env gates when the master gate is globally on', () => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    process.env.FEATURE_COMMUNITY_SEARCH = 'true';
    process.env.FEATURE_COMMUNITY_CLASSROOM_POSTS = 'false';
    process.env.FEATURE_COMMUNITY_EVENTS = 'true';

    const flags = service.evaluate({ userId: 'u1', role: 'owner' });
    expect(flags.community_search).toBe(true);
    expect(flags.community_classroom).toBe(false);
    expect(flags.community_events).toBe(true);
  });

  it('community_events is OFF when its own env is unset even with the master gate on', () => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    // FEATURE_COMMUNITY_EVENTS intentionally left unset.
    expect(
      service.evaluate({ userId: 'u1', role: 'owner' }).community_events,
    ).toBe(false);
  });

  it('community_search is OFF when its own env is off even with the master gate on', () => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    process.env.FEATURE_COMMUNITY_SEARCH = 'false';
    expect(
      service.evaluate({ userId: 'u1', role: 'owner' }).community_search,
    ).toBe(false);
  });

  it('honours the community allowlist when the global master gate is off', () => {
    process.env.FEATURE_COMMUNITY_API = 'false';
    process.env.FEATURE_COMMUNITY_API_ALLOWLIST = 'allowed-user, other';
    process.env.FEATURE_COMMUNITY_SEARCH = 'true';

    expect(
      service.evaluate({ userId: 'allowed-user', role: 'student' })
        .community_search,
    ).toBe(true);
    expect(
      service.evaluate({ userId: 'not-allowed', role: 'student' })
        .community_search,
    ).toBe(false);
  });

  describe('coach_community_wearable_prompts role gate', () => {
    beforeEach(() => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_WEARABLE_PROMPTS = 'true';
    });

    it('is true for coach', () => {
      expect(
        service.evaluate({ userId: 'u1', role: 'coach' })
          .coach_community_wearable_prompts,
      ).toBe(true);
    });

    it('is true for owner (hierarchy: owner >= coach)', () => {
      expect(
        service.evaluate({ userId: 'u1', role: 'owner' })
          .coach_community_wearable_prompts,
      ).toBe(true);
    });

    it('is OFF for student even when the env gate is on', () => {
      expect(
        service.evaluate({ userId: 'u1', role: 'student' })
          .coach_community_wearable_prompts,
      ).toBe(false);
    });
  });
});
