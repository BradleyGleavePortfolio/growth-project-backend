import {
  IsEmail,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
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
}
