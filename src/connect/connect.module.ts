import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import { ConnectController } from './connect.controller';
import { ConnectModuleState } from './connect.module-state';
import { ConnectService } from './connect.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from './stripe-connect-api.service';

// Phase 1 Connect module — Stripe Express account creation, onboarding/login
// links, and webhook-driven mirror. See /CONNECT_MASTER_PLAN.md §Phase 1.
//
// onModuleInit performs the "real or flagged" boot gate:
//   - STRIPE_SECRET_KEY present + shaped correctly (sk_test_* / sk_live_*)
//   - Stripe Connect platform-enabled probe (GET /v1/accounts?limit=1)
//
// On failure we log a clear warning AND set ConnectModuleState.ready=false
// so every controller route returns 503 + an actionable message. We do NOT
// crash the process — the rest of the backend (SaaS billing, etc.) must
// still boot.
@Module({
  controllers: [ConnectController],
  providers: [
    ConnectService,
    StripeConnectApiService,
    ConnectModuleState,
    // JwtAuthGuard (provided globally in AppModule via APP_GUARD) injects
    // JwksVerifierService. Controllers that mount JwtAuthGuard via
    // @UseGuards must have it in scope; BillingModule does the same.
    JwksVerifierService,
  ],
  exports: [ConnectService, ConnectModuleState],
})
export class ConnectModule implements OnModuleInit {
  private readonly logger = new Logger(ConnectModule.name);

  constructor(
    private readonly state: ConnectModuleState,
    private readonly stripeConnect: StripeConnectApiService,
  ) {}

  async onModuleInit() {
    // Skip the live probe during unit tests — Jest sets NODE_ENV=test and
    // tests inject their own fixture state via ConnectModuleState directly.
    if (process.env.NODE_ENV === 'test') {
      this.state.ready = !!process.env.STRIPE_SECRET_KEY;
      this.state.reason = this.state.ready ? null : 'STRIPE_SECRET_KEY unset (test mode)';
      return;
    }

    try {
      this.stripeConnect.requireSecret();
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Stripe Connect: secret not usable';
      this.logger.warn(`Connect routes disabled: ${msg}`);
      this.state.ready = false;
      this.state.reason = msg;
      return;
    }

    try {
      await this.stripeConnect.assertPlatformEnabled();
    } catch (err) {
      const msg =
        err instanceof StripeConnectApiError
          ? err.message
          : (err as Error)?.message ?? 'Stripe Connect platform check failed';
      this.logger.warn(`Connect routes disabled: ${msg}`);
      this.state.ready = false;
      this.state.reason = msg;
      return;
    }

    // Required URL env vars are validated at link-creation time (so the
    // module can still serve GET /v1/connect/accounts/me as a status read
    // even before deep links are configured). The check below is a soft
    // warning so the operator sees it in the boot log.
    if (!process.env.STRIPE_CONNECT_REFRESH_URL?.trim()) {
      this.logger.warn(
        'STRIPE_CONNECT_REFRESH_URL is unset — POST /v1/connect/accounts/onboarding-link will return 503 until it is set.',
      );
    }
    if (!process.env.STRIPE_CONNECT_RETURN_URL?.trim()) {
      this.logger.warn(
        'STRIPE_CONNECT_RETURN_URL is unset — POST /v1/connect/accounts/onboarding-link will return 503 until it is set.',
      );
    }

    this.state.ready = true;
    this.state.reason = null;
    this.logger.log('Stripe Connect platform check passed — routes enabled.');
  }
}
