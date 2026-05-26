import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

// R43 Storefront Phase 1 — POST /v1/packages/public/join/:token/checkout
// body. `idempotency_key` is the storefront-generated UUID v4 that the
// server uses to dedup retries via the GuestCheckout.idempotency_key
// unique index + P2002 catch.
export class GuestCheckoutDto {
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters.' })
  @MaxLength(120, { message: 'Name must be at most 120 characters.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  guest_name!: string;

  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  guest_email!: string;

  @IsUUID('4', { message: 'idempotency_key must be a UUID v4.' })
  idempotency_key!: string;

  // r48 #3 — optional storefront session_id (visitor cookie or
  // crypto.randomUUID from the storefront SSR layer).  Used to derive
  // the content-addressable hash (share_token + email + session_id)
  // so a network-dropped retry reuses the same Stripe PaymentIntent
  // instead of minting a second one.  Omit on legacy clients — the
  // backend falls back to idempotency_key in that case.
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_\-]+$/, {
    message: 'session_id must be url-safe alphanumeric.',
  })
  session_id?: string;
}

// r48 #4 — POST /v1/packages/public/join/:token/checkout/resume body.
// Storefront calls this on network reconnect to pick up an in-flight
// PaymentIntent without re-confirming the form.  Only an email is
// required; the share token comes from the URL path.
export class GuestCheckoutResumeDto {
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  guest_email!: string;

  // Optional session_id — when present, the resume hashes on
  // (token + email + session_id) so multi-device guests don't cross-
  // contaminate each other's pending intents.
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9_\-]+$/)
  session_id?: string;
}

// r48 #5 — POST /v1/packages/public/join/:token/checkout/send-recovery-link.
// The storefront calls this when a checkout has been abandoned and the
// coach wants the guest to be able to pick up where they left off.  The
// server mints a 15-min JWT and emails it.
export class SendRecoveryLinkDto {
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @MaxLength(254)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  guest_email!: string;
}
