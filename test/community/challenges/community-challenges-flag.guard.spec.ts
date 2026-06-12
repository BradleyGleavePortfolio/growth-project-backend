/**
 * Unit tests for the v3-1 challenge write kill-switch
 * (CommunityChallengesEnabledGuard).
 *
 * The flag defaults OFF: any value other than the literal 'true' (unset, '1',
 * 'false', 'TRUE') resolves OFF and the guard rejects WRITE handlers with a 503
 * disabled body. GET handlers do not carry this guard, so this only governs
 * writes — active progress stays readable when the surface is killed.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CommunityChallengesEnabledGuard,
  FEATURE_COMMUNITY_CHALLENGES,
  resolveChallengesFlag,
} from '../../../src/community/challenges/community-challenges-flag.guard';

function ctx(): never {
  // The guard ignores its context entirely (env-only decision).
  return {} as never;
}

describe('CommunityChallengesEnabledGuard', () => {
  const original = process.env[FEATURE_COMMUNITY_CHALLENGES];

  afterEach(() => {
    if (original === undefined) delete process.env[FEATURE_COMMUNITY_CHALLENGES];
    else process.env[FEATURE_COMMUNITY_CHALLENGES] = original;
  });

  it('defaults OFF when the env var is unset', () => {
    delete process.env[FEATURE_COMMUNITY_CHALLENGES];
    expect(resolveChallengesFlag()).toBe(false);
    const guard = new CommunityChallengesEnabledGuard();
    expect(() => guard.canActivate(ctx())).toThrow(HttpException);
  });

  it.each(['1', 'false', 'TRUE', 'yes', ''])(
    'stays OFF for the non-literal-true value %p',
    (value) => {
      process.env[FEATURE_COMMUNITY_CHALLENGES] = value;
      expect(resolveChallengesFlag()).toBe(false);
      const guard = new CommunityChallengesEnabledGuard();
      expect(() => guard.canActivate(ctx())).toThrow(HttpException);
    },
  );

  it('allows the write only for the literal "true"', () => {
    process.env[FEATURE_COMMUNITY_CHALLENGES] = 'true';
    expect(resolveChallengesFlag()).toBe(true);
    const guard = new CommunityChallengesEnabledGuard();
    expect(guard.canActivate(ctx())).toBe(true);
  });

  it('throws a 503 SERVICE_UNAVAILABLE when disabled', () => {
    delete process.env[FEATURE_COMMUNITY_CHALLENGES];
    const guard = new CommunityChallengesEnabledGuard();
    try {
      guard.canActivate(ctx());
      throw new Error('guard should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  });
});
