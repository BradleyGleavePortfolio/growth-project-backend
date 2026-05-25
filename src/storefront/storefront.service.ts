import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import type {
  BillingCycle,
  PublicPackageData,
} from './storefront.types';

// Stripe Express accounts return their own publishable key on the /accounts
// payload. Refreshing per-request would cost a Stripe round-trip on every
// storefront page load; cache for 5 minutes so the storefront stays snappy
// without holding stale keys across a Connect re-onboard.
interface CachedPublishableKey {
  key: string;
  expiresAt: number;
}
const PUBLISHABLE_KEY_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name);
  private readonly publishableKeyCache = new Map<string, CachedPublishableKey>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeConnect: StripeConnectApiService,
    private readonly config: ConfigService,
  ) {}

  // GET /v1/packages/public/join/:token — no auth. Returns 404 when the
  // token resolves to no package, the package is archived/inactive, or
  // the coach has paused acquisitions (share_link_enabled = false). We
  // deliberately collapse those cases into a single 404 so the storefront
  // can't be probed for valid-but-paused tokens.
  async getPublicPackageByToken(token: string): Promise<PublicPackageData> {
    if (!token || typeof token !== 'string' || token.length < 4) {
      // Defence-in-depth: a malformed token never reaches the DB.
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }

    const pkg = await this.prisma.coachPackage.findUnique({
      where: { share_token: token },
      include: {
        coach: {
          include: {
            profile: true,
            coach_profile: true,
            connect_account: true,
          },
        },
      },
    });

    if (
      !pkg ||
      !pkg.is_active ||
      pkg.archived_at !== null ||
      !pkg.share_link_enabled
    ) {
      throw new NotFoundException({
        error: 'TOKEN_NOT_FOUND',
        message: 'This link is not available.',
      });
    }

    const coach = pkg.coach;
    const connectAccount = coach.connect_account;
    if (!connectAccount || !connectAccount.charges_enabled) {
      // The coach has a package but cannot accept charges yet. 404 again —
      // same surface as a missing token, no enumeration signal.
      throw new NotFoundException({
        error: 'PACKAGE_UNAVAILABLE',
        message: 'This coach is not currently accepting new clients.',
      });
    }

    const publishableKey = await this.getPublishableKey(
      connectAccount.stripe_account_id,
    );

    const billingCycle = this.mapBillingCycle(
      pkg.billing_type,
      pkg.interval,
      pkg.interval_count,
    );

    return {
      package_id: pkg.id,
      package_name: pkg.name,
      description: pkg.description ?? null,
      price_cents: pkg.amount_cents,
      currency: pkg.currency,
      billing_cycle: billingCycle,
      // Stripe trial_period_days lives on the Price object — Phase 1 of the
      // storefront does not surface trials, so we serve null. Adding this
      // later is a value-only change.
      trial_days: null,
      // CoachPackage has no `features` JSON column yet (deferred to Phase 2,
      // see spec §20). Return an empty array so the storefront can render
      // a deterministic empty state without an extra null check.
      features: [],
      coach: {
        display_name: coach.name?.trim() || 'Your Coach',
        bio: coach.coach_profile?.bio ?? null,
        avatar_url: coach.profile?.avatar_url ?? null,
        // "verified" surfaces only when the coach is fully Connect-onboarded
        // — that's the strongest "real coach" signal we have at the public
        // storefront layer (KYC + payouts proven).
        verified:
          connectAccount.charges_enabled && connectAccount.details_submitted,
      },
      stripe_publishable_key: publishableKey,
      share_link_enabled: pkg.share_link_enabled,
    };
  }

  // Resolve the publishable key for a Stripe Express account. Cached on a
  // 5-min sliding TTL so the storefront's first paint hits memory, not
  // Stripe's network. The underlying Stripe call uses StripeConnectApiService
  // which already wraps every request in an AbortController(10s timeout).
  private async getPublishableKey(stripeAccountId: string): Promise<string> {
    const now = Date.now();
    const cached = this.publishableKeyCache.get(stripeAccountId);
    if (cached && cached.expiresAt > now) {
      return cached.key;
    }

    try {
      const account = await this.stripeConnect.retrieveAccount(stripeAccountId);
      // Express accounts expose `keys.publishable` or top-level
      // `publishable_key` depending on API version. Probe both shapes so
      // the resolver doesn't break on an SDK version bump.
      const acct = account as Record<string, unknown> & {
        keys?: { publishable?: unknown };
      };
      const direct =
        typeof acct.publishable_key === 'string'
          ? (acct.publishable_key as string)
          : null;
      const nested =
        acct.keys && typeof acct.keys.publishable === 'string'
          ? (acct.keys.publishable as string)
          : null;
      const pk = direct ?? nested;
      if (!pk) {
        // Stripe omits the publishable key on accounts that have not
        // finished onboarding. Surface as 503 so the storefront can render
        // a "Coach is finalising payments" message rather than a 500.
        throw new ServiceUnavailableException({
          error: 'STRIPE_UNAVAILABLE',
          message: 'Payment processing is being set up. Please try again soon.',
        });
      }
      this.publishableKeyCache.set(stripeAccountId, {
        key: pk,
        expiresAt: now + PUBLISHABLE_KEY_TTL_MS,
      });
      return pk;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      // Sanitise: never leak Stripe error messages to the public storefront.
      // Log structured details internally; return a generic 503.
      const reason =
        err instanceof StripeConnectApiError
          ? `stripe_${err.stripeCode ?? 'unknown'}`
          : 'unknown';
      this.logger.error(
        `Failed to retrieve publishable key (acct=${stripeAccountId}) reason=${reason}`,
      );
      throw new ServiceUnavailableException({
        error: 'STRIPE_UNAVAILABLE',
        message: 'Payment processing temporarily unavailable.',
      });
    }
  }

  private mapBillingCycle(
    billingType: string,
    interval: string | null,
    intervalCount: number,
  ): BillingCycle {
    if (billingType === 'one_time') return 'one_time';
    if (interval === 'year') return 'annual';
    if (interval === 'month' && intervalCount === 3) return 'quarterly';
    return 'monthly';
  }

  // Test seam: ConfigService access for the storefront base URL is exposed
  // here so other services in the module (welcome email) read a single
  // canonical value rather than re-querying process.env.
  getStorefrontBaseUrl(): string {
    return (
      this.config.get<string>('STOREFRONT_BASE_URL') ?? 'https://tgp.app'
    ).replace(/\/$/, '');
  }
}
