import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { AiTriageFeatureFlagGuard } from '../../../src/community/ai-triage/ai-triage-flag.guard';
import {
  FEATURE_COMMUNITY_AI_TRIAGE_ENV,
  aiTriageEnabled,
} from '../../../src/community/ai-triage/ai-triage.feature';

// v2-4 — kill-switch guard tests. Default OFF; flag ON only when the env var
// is exactly 'true'; byte-identical 404 when OFF so the route reads as
// "no such route" off the wire.

function ctx(userId: string | null): ExecutionContext {
  const req = { user: userId ? { id: userId } : undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('aiTriageEnabled (default OFF)', () => {
  const original = process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV];
    else process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV] = original;
  });

  it('is OFF when the env var is absent', () => {
    delete process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV];
    expect(aiTriageEnabled()).toBe(false);
  });

  it("is OFF for any value other than exactly 'true'", () => {
    for (const v of ['false', '1', 'TRUE', 'True', 'yes', '']) {
      process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV] = v;
      expect(aiTriageEnabled()).toBe(false);
    }
  });

  it("is ON only when the env var is exactly 'true'", () => {
    process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV] = 'true';
    expect(aiTriageEnabled()).toBe(true);
  });
});

describe('AiTriageFeatureFlagGuard (disabled-state fallback)', () => {
  const original = process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV];
  const guard = new AiTriageFeatureFlagGuard();
  afterEach(() => {
    if (original === undefined) delete process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV];
    else process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV] = original;
  });

  it('throws a byte-identical 404 when the flag is OFF', () => {
    delete process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV];
    let thrown: unknown;
    try {
      guard.canActivate(ctx('coach-1'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getResponse()).toEqual({
      error: 'not_found',
      code: 'community.ai_triage.disabled',
    });
  });

  it('returns true (route active) when the flag is ON', () => {
    process.env[FEATURE_COMMUNITY_AI_TRIAGE_ENV] = 'true';
    expect(guard.canActivate(ctx('coach-1'))).toBe(true);
  });
});
