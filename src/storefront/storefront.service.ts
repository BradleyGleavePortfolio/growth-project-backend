import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { parseStorefrontBaseUrl } from '../common/env-validation';
import { SHARE_TOKEN_REGEX } from '../share-link/share-link.service';
import type {
  BillingCycle,
  PublicPackageData,
} from './storefront.types';

// Dev/test fallback used when STOREFRONT_BASE_URL is unset. Production
// must set the env var explicitly (enforced in prodHardenedFeatureVars).
const STOREFRONT_BASE_URL_DEV_FALLBACK = 'https://joingrowthproject.com';

// Re-export so other modules in the storefront surface (e.g. checkout
// service, public controller) can refer to a single canonical regex.
export { SHARE_TOKEN_REGEX };

// Audit #3 P1-8 — connected-account readiness gate. The previous build
// only checked `charges_enabled`, but a Stripe Connect account can be
// charges-enabled with `disabled_reason` set or `payouts_enabled` /
// `details_submitted` false, meaning Stripe is collecting fees we
// cannot pay out and may already be deferring the coach's payouts.
// Phase 1 storefront purchases must only be accepted when the coach can
// actually be paid: every readiness axis must be true.
//
// We expose the helper as a free function so the public package GET and
// the checkout POST both gate on the exact same predicate. The public
// surface intentionally returns a generic ACCOUNT_NOT_READY / 404 — no
// enumeration of which axis failed leaks through to the buyer.
export interface ReadinessAccount {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  disabled_reason: string | null;
}

export function isConnectAccountReadyForCheckout(
  account: ReadinessAccount | null | undefined,
): boolean {
  if (!account) return false;
  if (!account.charges_enabled) return false;
  if (!account.payouts_enabled) return false;
  if (!account.details_submitted) return false;
  if (account.disabled_reason !== null && account.disabled_reason !== undefined) {
    return false;
  }
  return true;
}

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
    // P1-3 / P2-1 — enforce the exact 21-char nanoid alphabet at the
    // service boundary. A malformed token never reaches the DB, which
    // prevents path-traversal-shaped tokens (`../../x`), all-zero
    // probing tokens, and brute-force scans from exercising Prisma.
    if (!token || typeof token !== 'string' || !SHARE_TOKEN_REGEX.test(token)) {
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
    // Audit #3 P1-8 — gate on full readiness, not just charges_enabled.
    // 404 is the public surface; the exact failing axis is logged
    // server-side so ops can debug without an enumeration leak.
    if (!isConnectAccountReadyForCheckout(connectAccount)) {
      if (connectAccount) {
        this.logger.warn(
          `Public package gate: connect account not ready (charges=${connectAccount.charges_enabled} payouts=${connectAccount.payouts_enabled} details=${connectAccount.details_submitted} disabled_reason=${connectAccount.disabled_reason ?? 'null'})`,
        );
      }
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
        // storefront layer (KYC + payouts proven). Mirrors the
        // isConnectAccountReadyForCheckout gate so the badge can't lie
        // about a coach who passed the gate.
        verified: isConnectAccountReadyForCheckout(connectAccount),
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
  // canonical value rather than re-querying process.env. Returns the
  // canonical (no trailing slash) form so callers can concat paths safely.
  getStorefrontBaseUrl(): string {
    const raw = this.config.get<string>('STOREFRONT_BASE_URL');
    const parsed = parseStorefrontBaseUrl(
      raw && raw.trim().length > 0 ? raw : STOREFRONT_BASE_URL_DEV_FALLBACK,
    );
    return parsed.ok ? parsed.canonical : STOREFRONT_BASE_URL_DEV_FALLBACK;
  }
}
