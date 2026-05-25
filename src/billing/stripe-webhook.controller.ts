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
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { BillingService } from './billing.service';
import {
  StripeSignatureError,
  resolveStripeWebhookSecrets,
  verifyStripeSignature,
} from './stripe-signature';

// POST /v1/webhooks/stripe — receives Stripe webhook events.
//
// The endpoint is @Public() because Stripe is not a Supabase user. Security
// comes from HMAC signature verification: a request without a valid
// `stripe-signature` header for the configured STRIPE_WEBHOOK_SECRET is
// rejected with 400.
//
// We require the raw request body for signature verification. Stripe signs
// the exact byte sequence of the HTTP body, so any re-serialization path is
// unsafe — a different key order or whitespace would silently fail
// verification and, worse, could let a request with an unverifiable body
// reach the handler if a fallback existed. There is no fallback: if
// `req.rawBody` is missing we reject with 400 and the operator must wire
// `app.use(express.raw(...))` (or NestJS `RawBodyMiddleware`) on the
// webhook route in `main.ts`.
//
// If `STRIPE_WEBHOOK_SECRET` is unset we reject every request — better to
// fail loudly than to silently accept unsigned events. To allow local
// development without Stripe, leave the route unmounted by not setting any
// of the `STRIPE_*` env vars; the controller is registered unconditionally
// and the missing-secret check inside the handler will return 400.
@ApiTags('webhooks')
@Controller('v1/webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private billing: BillingService) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 500 } })
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async stripe(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    // Dual-secret support: STRIPE_WEBHOOK_SECRET is the steady-state secret;
    // STRIPE_WEBHOOK_SECRET_NEXT is the incoming secret during a zero-
    // downtime rotation. A signature is accepted if it verifies under any
    // configured secret. See docs/stripe-setup.md for the rotation runbook.
    const secrets = resolveStripeWebhookSecrets();
    if (secrets.length === 0) {
      // Mirror Stripe's error shape: 400 means "do not retry". A misconfigured
      // server should not loop the dead-letter queue.
      throw new BadRequestException('Stripe webhook secret not configured');
    }
    // The raw body is the only signature source we trust. main.ts wires
    // body-parser with `verify` so `req.rawBody` is set as a Buffer; if it
    // is missing the route is misconfigured (raw-body middleware not wired)
    // and we refuse the event with 400 rather than try to reconstruct the
    // signed bytes from parsed JSON.
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'Stripe webhook received without rawBody. Verify express.raw() middleware is wired for /v1/webhooks/stripe in main.ts.',
      );
      throw new BadRequestException('Stripe webhook raw body unavailable');
    }
    const raw = rawBody.toString('utf8');

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

    let event: { id?: string; type?: string; data?: { object?: unknown } };
    try {
      event = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    if (!event?.id || !event?.type || !event?.data) {
      throw new BadRequestException('Malformed Stripe event');
    }

    const result = await this.billing.handleEvent(event as Parameters<BillingService['handleEvent']>[0]);
    return result;
  }
}
