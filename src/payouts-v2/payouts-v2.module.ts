import { Module } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import { PrismaService } from '../prisma.service';
import { PayoutMethodController } from './payout-method.controller';
import { PayoutMethodService } from './payout-method.service';
import { PayoutRoutingService } from './payout-routing.service';
import { PayoutsV2WebhookController } from './payouts-v2-webhook.controller';
import { PlatformFeeService } from './platform-fee.service';
import {
  DefaultStripeConnect,
  STRIPE_CONNECT,
} from './stripe-connect.provider';

/**
 * Bank-Account Payouts v2 module (spec §2).
 *
 * A self-contained NestJS module that adds a PARALLEL payout-method layer; it
 * does NOT modify the existing `src/checkout/` payment-ops surface. The
 * existing Stripe webhook handler delegates to `PayoutRoutingService` for the
 * thin `payout.paid` routing branch (§2.5).
 *
 * EVERYTHING here is a no-op while `FEATURE_BANK_PAYOUTS_V2` is OFF (the
 * services check the flag internally and the controller returns 503), so
 * importing this module in app.module is safe ahead of the operator flip — no
 * v2 surface fires until the flag is `true`. Posture mirrors `DunningV2Module`.
 *
 * OPERATOR-LOCKED DECISION (A): `StripeConnect` is provided via standard NestJS
 * CONSTRUCTOR INJECTION under the `STRIPE_CONNECT` token (default impl
 * `DefaultStripeConnect`). NO service locator, NO global registry. Unit tests
 * override the provider with a fake.
 *
 * AWS S3 DI — DEFERRED TO PHASE B (Gate 8 note). Phase A (bank-payout method
 * linking + payout routing bookkeeping) does NOT use AWS S3: there is no object
 * storage on any Phase A code path. The S3Client constructor-injection
 * scaffolding lands in Phase B alongside 1099-K document storage, where it is
 * actually exercised. The `@aws-sdk/client-s3` dependency in package.json is
 * intentionally retained as a forward-declared dependency for that Phase B work
 * (cross-ref: AUDIT_R1_PR_374_REPORT.md Gate 8 / Gate 10) and MUST NOT be
 * removed. Adding an unused S3Client provider here now would be dead code with
 * no exercising code path, so it is deferred rather than stubbed.
 */
@Module({
  controllers: [PayoutMethodController, PayoutsV2WebhookController],
  providers: [
    PrismaService,
    PlatformFeeService,
    PayoutMethodService,
    PayoutRoutingService,
    // StripeConnect provider — constructor injection via the STRIPE_CONNECT token.
    { provide: STRIPE_CONNECT, useClass: DefaultStripeConnect },
    // JwtAuthGuard (mounted on the controller via @UseGuards) injects
    // JwksVerifierService; provide it locally as ConnectModule does.
    JwksVerifierService,
  ],
  exports: [
    PlatformFeeService,
    PayoutMethodService,
    PayoutRoutingService,
  ],
})
export class PayoutsV2Module {}
