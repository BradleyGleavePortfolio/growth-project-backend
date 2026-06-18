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
import { TalentConnectWebhookService } from './talent-connect-webhook.service';

// TM-14 — Stripe Connect `account.updated` webhook for the talent marketplace.
// Skeleton; sig-verify gate + delegation completed in subsequent commits.
@ApiTags('talent-marketplace')
@Controller('v1/webhooks/talent-marketplace')
export class TalentConnectWebhookController {
  private readonly logger = new Logger(TalentConnectWebhookController.name);

  constructor(private readonly webhook: TalentConnectWebhookService) {}

  @Public()
  @Post('connect')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    const secrets = resolveStripeWebhookSecrets();
    if (secrets.length === 0) {
      throw new BadRequestException('Stripe webhook secret not configured');
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'talent-marketplace connect webhook received without rawBody. Verify rawBody is enabled in main.ts.',
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

    return this.webhook.handleAccountUpdated({
      id: event.id,
      type: event.type,
      data: { object: event.data.object },
    });
  }
}
