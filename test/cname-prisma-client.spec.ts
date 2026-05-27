/**
 * Prisma client regen sanity check (CNAME Phase 4).
 *
 * This test is intentionally tiny — its purpose is to FAIL TO COMPILE
 * if `npx prisma generate` was not run, or if the schema regressed and
 * the CNAME-related fields disappeared from the generated client.  We
 * import the typed model from `@prisma/client` and reference each
 * Phase-4 field on a value of that type. ts-jest will refuse to
 * transpile this file on drift.
 */

import type { CoachLandingPage, CoachSubscription, CoachTier } from '@prisma/client';

describe('Prisma client — CNAME Phase 4 fields are generated', () => {
  it('CoachLandingPage exposes custom_domain + custom_domain_verified_at', () => {
    // Type-only construction: assert the shape, not the runtime behaviour.
    const sample: Pick<
      CoachLandingPage,
      'id' | 'custom_domain' | 'custom_domain_verified_at'
    > = {
      id: 'page-1',
      custom_domain: 'coaching.example.com',
      custom_domain_verified_at: new Date(),
    };
    expect(sample.custom_domain).toBe('coaching.example.com');
    expect(sample.custom_domain_verified_at).toBeInstanceOf(Date);
  });

  it('CoachSubscription exposes the tier field used for Pro+ gating', () => {
    const tier: CoachTier = 'pro';
    const sample: Pick<CoachSubscription, 'coach_id' | 'tier'> = {
      coach_id: 'coach-1',
      tier,
    };
    expect(sample.tier).toBe('pro');
  });
});
