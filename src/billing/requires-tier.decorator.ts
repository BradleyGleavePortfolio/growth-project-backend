import { SetMetadata } from '@nestjs/common';

export const REQUIRES_TIER_KEY = 'requires_tier';

export type RequiredTier = 'pro' | 'enterprise';

/**
 * Marks a controller class or route handler as requiring a minimum CoachTier.
 *
 * Usage — class-level (all handlers inherit):
 *
 *   @RequiresTier('pro')
 *   @UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
 *   export class CoachAiController { ... }
 *
 * Usage — handler-level (overrides class-level if both present):
 *
 *   @RequiresTier('pro')
 *   @Get('some-route')
 *   someHandler() { ... }
 *
 * Precedence (via Reflector.getAllAndOverride):
 *   handler-level decorator wins over class-level decorator.
 *   Absent from both = treated as 'free' by SubscriptionGuard.
 *
 * The type 'RequiredTier' intentionally excludes 'free': free is the
 * implicit default and must never be explicitly decorated (it would be
 * a no-op and confuse reviewers). SubscriptionGuard falls back to 'free'
 * when no decorator is present.
 */
export const RequiresTier = (tier: RequiredTier) =>
  SetMetadata(REQUIRES_TIER_KEY, tier);
