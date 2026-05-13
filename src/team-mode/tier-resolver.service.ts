import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// Three canonical tier names. Verified from public /llms.txt:
//   Growth     $1,079/mo
//   Pro        $2,499/mo
//   Enterprise $6,225/mo
//
// Returned by resolveTier() and consumed by the team-mode controllers
// for the tier gate (Q6) and by the staff-seat service for the
// billing posture decision (Q1).
export type CoachTier = 'growth' | 'pro' | 'enterprise' | 'unknown';

// Env-var mapping. Stripe price IDs land in production secrets; the
// resolver matches the head coach's CoachSubscription.stripe_price_id
// against the configured ids and returns the matching tier label.
//
// `unknown` fires when:
//   - the head coach has no CoachSubscription row yet (still on
//     legacy/grandfathered path), OR
//   - the price id does not match any of the three configured ids
//     (e.g. a custom enterprise contract with its own price id).
//
// Callers must treat `unknown` as "deny by default" for paid features.
export interface TierResolveResult {
  tier: CoachTier;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
}

@Injectable()
export class TeamModeTierResolverService {
  private readonly logger = new Logger(TeamModeTierResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveTier(coachId: string): Promise<TierResolveResult> {
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
      select: { stripe_subscription_id: true, stripe_price_id: true },
    });
    if (!sub || !sub.stripe_price_id) {
      return {
        tier: 'unknown',
        stripe_subscription_id: sub?.stripe_subscription_id ?? null,
        stripe_price_id: null,
      };
    }
    const tier = this.priceIdToTier(sub.stripe_price_id);
    return {
      tier,
      stripe_subscription_id: sub.stripe_subscription_id ?? null,
      stripe_price_id: sub.stripe_price_id,
    };
  }

  // Pure mapping. Public so the audit-event writer and tests can
  // validate the tier label without a DB round-trip.
  priceIdToTier(priceId: string): CoachTier {
    if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
    return 'unknown';
  }

  // Pre-flight check: returns which tier price-id env vars are configured
  // and which are missing/empty/duplicates. Called by the boot-time resolver
  // smoke test and the OWNER /admin/stripe/events endpoint so operators
  // can confirm production secrets are wired before flipping enforcement.
  //
  // The check intentionally does NOT call Stripe — it only inspects env.
  // A misconfigured Stripe dashboard (price exists but env points to the
  // wrong id) is caught downstream when `priceIdToTier` returns "unknown".
  configuredTiers(): {
    growth: string | null;
    pro: string | null;
    enterprise: string | null;
    missing: CoachTier[];
    duplicates: CoachTier[][];
  } {
    const raw = {
      growth: (process.env.STRIPE_PRICE_GROWTH ?? '').trim() || null,
      pro: (process.env.STRIPE_PRICE_PRO ?? '').trim() || null,
      enterprise: (process.env.STRIPE_PRICE_ENTERPRISE ?? '').trim() || null,
    };
    const missing: CoachTier[] = [];
    if (!raw.growth) missing.push('growth');
    if (!raw.pro) missing.push('pro');
    if (!raw.enterprise) missing.push('enterprise');

    // Detect operator copy-paste mistake: same price id wired into two
    // tiers. Without this check, priceIdToTier returns the first match
    // (growth) and the second tier is invisibly demoted.
    const byId = new Map<string, CoachTier[]>();
    for (const [tier, id] of Object.entries(raw) as [CoachTier, string | null][]) {
      if (!id) continue;
      (byId.get(id) ?? byId.set(id, []).get(id))!.push(tier);
    }
    const duplicates: CoachTier[][] = [];
    for (const tiers of byId.values()) {
      if (tiers.length > 1) duplicates.push(tiers);
    }

    return { ...raw, missing, duplicates };
  }
}
