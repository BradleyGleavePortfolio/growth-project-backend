import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /me/payout-methods/financial-connections/complete` (spec
 * §2.4 step 4). Carries the Stripe Financial Connections session id the
 * Stripe-hosted widget returns on success. We never see raw bank credentials —
 * only this opaque session id.
 */
export class LinkBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fcSessionId!: string;
}
