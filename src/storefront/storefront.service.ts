import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import type {
  BillingCycle,
  PublicPackageData,
} from './storefront.types';

@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name);

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

    // Phase 1 uses destination charges on the PLATFORM account
    // (transfer_data[destination] with no Stripe-Account header). The
    // browser must confirm with the platform publishable key, not the
    // connected account's publishable key — those are two different
    // Stripe contexts and mixing them is rejected by Stripe.js.
    const publishableKey = this.config.get<string>('STRIPE_PUBLISHABLE_KEY');
    if (!publishableKey || publishableKey.trim().length === 0) {
      this.logger.error(
        'STRIPE_PUBLISHABLE_KEY unset — public storefront cannot confirm payments.',
      );
      throw new ServiceUnavailableException({
        error: 'STRIPE_UNAVAILABLE',
        message: 'Payment processing temporarily unavailable.',
      });
    }

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
