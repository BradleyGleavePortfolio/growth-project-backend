import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  StripeSignatureError,
  resolveStripeWebhookSecrets,
  verifyStripeSignature,
} from '../billing/stripe-signature';
import { Public } from '../common/decorators/public.decorator';
import { PayoutRoutingService } from './payout-routing.service';

/**
 * PayoutsV2WebhookController (spec §2.5) — the Stripe Connect payout webhook
 * entry point for Bank-Account Payouts v2.
 *
 * SECURITY POSTURE (mirrors `src/billing/stripe-webhook.controller.ts`):
 * the route is unauthenticated because Stripe is not a platform user; the ONLY
 * trust anchor is the HMAC `Stripe-Signature` header. A request with a MISSING
 * or INVALID signature is rejected with **400 Bad Request** (Stripe's documented
 * "do not retry" convention) BEFORE any handler logic runs — so a forged or
 * unsigned event can NEVER reach `PayoutRoutingService` and can NEVER mutate
 * state. The raw request body is the only signature source we trust; if
 * `req.rawBody` is missing (raw-body middleware not wired) we also reject 400.
 *
 * Only AFTER a signature verifies do we parse the event and delegate the thin
 * payout-routing branch to `PayoutRoutingService.routePayoutWebhook` (§2.5),
 * which is itself a no-op while `FEATURE_BANK_PAYOUTS_V2` is OFF and NEVER moves
 * money (bookkeeping classification only).
 */
@ApiTags('payouts-v2')
@Controller('v1/webhooks/payouts-v2')
export class PayoutsV2WebhookController {
  private readonly logger = new Logger(PayoutsV2WebhookController.name);

  constructor(private readonly payoutRouting: PayoutRoutingService) {}

  @Public()
  @Post('stripe-connect')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    const secrets = resolveStripeWebhookSecrets();
    if (secrets.length === 0) {
      // Fail loudly rather than silently accept unsigned events.
      throw new BadRequestException('Stripe webhook secret not configured');
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'payouts-v2 webhook received without rawBody. Verify express.raw() middleware is wired for this route in main.ts.',
      );
      throw new BadRequestException('Stripe webhook raw body unavailable');
    }
    const raw = rawBody.toString('utf8');

    // Signature gate. Missing header → StripeSignatureError('Missing signature
    // header'); bad/forged signature → StripeSignatureError. Both surface as
    // 400 and SHORT-CIRCUIT before any DB-touching delegation.
    try {
      verifyStripeSignature({
        payload: raw,
        signatureHeader: signature ?? '',
        secrets,
      });
    } catch (err) {
      if (err instanceof StripeSignatureError) {
        throw new BadRequestException(`Stripe signature: ${err.message}`);
      }
      throw err;
    }

    let event: {
      id?: string;
      type?: string;
      data?: { object?: { id?: string; account?: string } };
    };
    try {
      event = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    if (!event?.id || !event?.type || !event?.data) {
      throw new BadRequestException('Malformed Stripe event');
    }

    const obj = event.data.object ?? {};
    const result = await this.payoutRouting.routePayoutWebhook({
      connectedAccountId: obj.account ?? null,
      payoutId: obj.id ?? '',
      eventType: event.type,
    });
    return { received: true, routing: result };
  }
}
