import { Injectable, Logger } from '@nestjs/common';

// B-TRIALS-2 (OR-113-2) — is there a checkout on this server that really
// gives the client the free trial a package advertises?
//
// This PR (#656) owns CoachPackage.trial_days, its validation, the one-trial
// rule data and the trial-ending notice. Lane B-RECUR (#654) owns the native
// subscription checkout that sends `trial_period_days` to Stripe. The two can
// merge in either order:
//
//   * #656 on main without #654: the only recurring checkout is the hosted
//     Checkout Session, which charges at once and sends no trial. A coach can
//     already store trial days, but no client is told "free trial" because
//     nothing would honor it: every trial_offer reads
//     { available: false, reason: 'not_offered_yet' }.
//   * #654 present: its SubscriptionCheckoutService calls
//     `register('subscription-checkout')` once at boot (one line, added by
//     whichever PR lands second), and trial_offer reflects the client's real
//     eligibility (offered / already_used).
//
// One instance per process (PackagesModule provider, exported). Not a flag:
// nothing to switch in production, and it can never claim a trial that no
// code path would honor.

/** The name the B-RECUR subscription checkout registers with. */
export const SUBSCRIPTION_CHECKOUT_OWNER = 'subscription-checkout';

@Injectable()
export class TrialCheckoutCapability {
  private readonly logger = new Logger(TrialCheckoutCapability.name);
  private owner: string | null = null;

  /**
   * Called by the checkout that sends the package's trial to Stripe
   * (trial_period_days + missing_payment_method=cancel, card collected up
   * front) and reserves the client's one trial with TrialUsageService.
   */
  register(owner: string): void {
    if (this.owner === owner) return;
    this.owner = owner;
    this.logger.log(`free trials are sold by ${owner}`);
  }

  /** True once a checkout that honors free trials is wired in. */
  isReady(): boolean {
    return this.owner !== null;
  }

  /** Which checkout registered (support / diagnostics). */
  registeredBy(): string | null {
    return this.owner;
  }
}
