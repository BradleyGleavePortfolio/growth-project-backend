import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';
import {
  COACH_AI_CUSTOM_PACK_MAX_CENTS,
  COACH_AI_CUSTOM_PACK_MIN_CENTS,
} from './ai-credits.constants';

// Request: POST /coach/ai/credit-packs/checkout
//
// The client picks one of three locked tiers ('small' | 'medium' | 'large')
// or 'custom' with an explicit amount_cents. The server normalises the
// tier into a Stripe Price + creates a Checkout Session whose success_url
// returns to the mobile app.
//
// class-validator does the heavy lifting so the controller body is small
// and the failure mode for any malformed input is a clear 400.

export type CreditPackTier = 'small' | 'medium' | 'large' | 'custom';

export class CreditPackCheckoutRequestDto {
  @ApiProperty({ enum: ['small', 'medium', 'large', 'custom'], example: 'medium' })
  @IsIn(['small', 'medium', 'large', 'custom'])
  tier!: CreditPackTier;

  @ApiProperty({
    required: false,
    description: 'Required for tier=custom. Cents in [1000, 50000].',
    minimum: COACH_AI_CUSTOM_PACK_MIN_CENTS,
    maximum: COACH_AI_CUSTOM_PACK_MAX_CENTS,
    example: 1500,
  })
  @IsOptional()
  @IsInt()
  @Min(COACH_AI_CUSTOM_PACK_MIN_CENTS)
  @Max(COACH_AI_CUSTOM_PACK_MAX_CENTS)
  amount_cents?: number;

  // Optional override for the redirect URLs. Defaults to the env-pinned
  // values used by the rest of the Stripe integration. We allow override
  // so the iOS app can route success/cancel to its own scheme without
  // hard-coding STRIPE_CHECKOUT_SUCCESS_URL semantics into the mobile.
  @ApiProperty({ required: false, example: 'tgp://billing/success' })
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https', 'tgp'] })
  success_url?: string;

  @ApiProperty({ required: false, example: 'tgp://billing/cancel' })
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https', 'tgp'] })
  cancel_url?: string;
}

export class CreditPackCheckoutResponseDto {
  @ApiProperty({ example: 'cs_test_a1b2c3' })
  checkout_session_id!: string;

  @ApiProperty({ example: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3...' })
  checkout_url!: string;

  @ApiProperty({ example: 2500 })
  amount_cents!: number;
}
