import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { PrismaService } from '../prisma.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { MIN_CHECKOUT_RECOVERY_SECRET_LENGTH } from '../common/env-validation';

// r48 #5 — magic-link recovery for abandoned checkouts.
//
// Flow:
//   1. Storefront calls POST /v1/packages/public/join/:token/checkout/send-recovery-link
//      with { guest_email }.
//   2. Server validates that a GuestCheckout row exists for (token,
//      email) in a recoverable state (pending), mints a 15-minute JWT
//      keyed by CHECKOUT_RECOVERY_SECRET, and emails a deep link.
//   3. Guest clicks; storefront calls
//      GET /v1/packages/public/join/:token/checkout/resume/:jwt
//      which verifies the JWT and redirects to the SSR checkout page
//      with the share_token + guest_checkout_id in the URL.
//
// Rate limit: 3 emails/hour/email. Enforced by a Prisma read against
// EmailSendLog (existing idempotency table) — keyed by the same
// idempotency_key we send into EmailService.send.
//
// JWT shape:
//   { share_token, email, guest_checkout_id, type: 'checkout_recovery' }
//   issued via jose HS256 against CHECKOUT_RECOVERY_SECRET.
//
// Security:
//   * 15-minute exp limits replay window.
//   * email is bound into the JWT — a stolen link cannot be reused
//     by another buyer.
//   * verify() rejects token if it doesn't match the URL-path
//     share_token, so an attacker who sniffs one coach's link
//     cannot trade it for a different coach's checkout.

const RECOVERY_JWT_TTL_SECONDS = 15 * 60;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_MAX = 3;
const RECOVERY_TYPE = 'checkout_recovery';

interface RecoveryClaims extends JWTPayload {
  st: string; // share_token
  em: string; // email
  gid: string; // guest_checkout_id
  type: typeof RECOVERY_TYPE;
}

@Injectable()
export class CheckoutRecoveryService {
  private readonly logger = new Logger(CheckoutRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Send a recovery link to the guest's email.  Returns { sent: true }
   * even when there's no matching checkout — we never reveal that an
   * email has (or hasn't) attempted a checkout.  Rate limit is enforced
   * via EmailService's idempotency_key collision (returns 'skipped' on
   * a duplicate), plus a Prisma read against EmailSendLog for the
   * hourly cap.
   */
  async sendRecoveryLink(
    shareToken: string,
    email: string,
  ): Promise<{ sent: true }> {
    if (!this.email) {
      // Legacy boot without EmailModule — silently return success so
      // we don't leak the configuration state.
      return { sent: true };
    }

    // Find the most recent recoverable checkout for this (token, email).
    // We constrain to status='pending' AND expires_at > now so an
    // expired or terminal row does not generate a link.
    const checkout = await this.prisma.guestCheckout.findFirst({
      where: {
        guest_email: email.toLowerCase(),
        status: 'pending',
        expires_at: { gt: new Date() },
        package: { share_token: shareToken },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!checkout) {
      // No actionable checkout — silently succeed to avoid email
      // enumeration. The audit team called this out as a P2 follow-up
      // on a different PR; we honor it here from day one.
      return { sent: true };
    }

    // Enforce the 3/hr/email rate limit.  We count recovery emails
    // sent to this address in the last hour by reading EmailSendLog
    // directly — the table already exists and is indexed on
    // (recipient_email, status).
    const recentCount = await this.prisma.emailSendLog.count({
      where: {
        recipient_email: email.toLowerCase(),
        template_key: EmailTemplateKey.PAYMENT_REMINDER,
        idempotency_key: { startsWith: 'checkout-recovery:' },
        created_at: { gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) },
      },
    });
    if (recentCount >= RATE_LIMIT_MAX) {
      this.logger.warn(
        `recovery rate-limit hit for ${email.slice(0, 3)}*** (count=${recentCount})`,
      );
      return { sent: true };
    }

    const jwt = await this.mintJwt(shareToken, email, checkout.id);
    const storefrontBase = this.resolveStorefrontBase();
    const link = `${storefrontBase}/v1/packages/public/join/${encodeURIComponent(
      shareToken,
    )}/checkout/resume/${encodeURIComponent(jwt)}`;

    // Idempotency key includes the checkout id + minute bucket so
    // honest retries within the same minute collapse, but a brand-new
    // request after the bucket rolls succeeds.
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const idempotencyKey = `checkout-recovery:${checkout.id}:${minuteBucket}`;

    try {
      await this.email.send({
        to: email,
        // Reuse PAYMENT_REMINDER template — the closest existing copy
        // ("Your payment didn't go through, click to retry").  A
        // dedicated checkout-recovery template is a follow-up cosmetic.
        template: EmailTemplateKey.PAYMENT_REMINDER,
        idempotencyKey,
        data: {
          recipient_name: checkout.guest_name,
          billing_portal_url: link,
          // Keep the failure_reason field empty — we don't know why
          // they abandoned (or whether they did).
          failure_reason: '',
          amount_display: this.formatAmount(checkout),
          attempted_at: new Date().toISOString().slice(0, 10),
        },
      });
    } catch (err) {
      // Email failures are best-effort.  Returning { sent: true } is
      // safe because the caller cannot distinguish between
      // "we sent it but it bounced" and "we sent it successfully"
      // anyway.
      this.logger.error(
        `recovery email failed for ${email.slice(0, 3)}***: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
    return { sent: true };
  }

  /**
   * Verify a recovery JWT and return the underlying claims. Throws
   * NotFoundException for any failure (expired, tampered, wrong token,
   * unknown checkout) — never leaks which leg failed.
   */
  async verifyToken(
    expectedShareToken: string,
    token: string,
  ): Promise<{ share_token: string; email: string; guest_checkout_id: string }> {
    let claims: RecoveryClaims;
    try {
      const { payload } = await jwtVerify(token, this.getTokenKey(), {
        algorithms: ['HS256'],
      });
      claims = payload as RecoveryClaims;
    } catch {
      throw new NotFoundException({
        error: 'RECOVERY_TOKEN_INVALID',
        message: 'This recovery link is no longer valid.',
      });
    }
    if (claims.type !== RECOVERY_TYPE) {
      throw new NotFoundException({
        error: 'RECOVERY_TOKEN_INVALID',
        message: 'This recovery link is no longer valid.',
      });
    }
    if (typeof claims.st !== 'string' || claims.st !== expectedShareToken) {
      throw new NotFoundException({
        error: 'RECOVERY_TOKEN_INVALID',
        message: 'This recovery link is no longer valid.',
      });
    }
    if (typeof claims.em !== 'string' || typeof claims.gid !== 'string') {
      throw new NotFoundException({
        error: 'RECOVERY_TOKEN_INVALID',
        message: 'This recovery link is no longer valid.',
      });
    }
    // Cross-check the GuestCheckout row still exists + matches.
    const row = await this.prisma.guestCheckout.findUnique({
      where: { id: claims.gid },
    });
    if (
      !row ||
      row.guest_email.toLowerCase() !== claims.em.toLowerCase() ||
      row.expires_at < new Date()
    ) {
      throw new NotFoundException({
        error: 'RECOVERY_TOKEN_INVALID',
        message: 'This recovery link is no longer valid.',
      });
    }
    return {
      share_token: claims.st,
      email: claims.em,
      guest_checkout_id: claims.gid,
    };
  }

  /**
   * Resume endpoint logic.  Given (share_token, email), look up the
   * most recent recoverable checkout and return its (id, PaymentIntent
   * id, status) so the storefront can re-attach without re-confirming
   * the form.  Returns null when nothing recoverable exists.
   */
  async resumeFromCredentials(
    shareToken: string,
    email: string,
  ): Promise<{
    guest_checkout_id: string;
    payment_intent_id: string;
    status: string;
  } | null> {
    const row = await this.prisma.guestCheckout.findFirst({
      where: {
        guest_email: email.toLowerCase(),
        status: { in: ['pending', 'paid'] },
        expires_at: { gt: new Date() },
        package: { share_token: shareToken },
      },
      orderBy: { created_at: 'desc' },
    });
    if (!row) return null;
    // Synthetic `pending_<key>` PI ids are not real Stripe intents —
    // the storefront cannot confirm against them.  Treat as no resume.
    if (row.stripe_payment_intent_id.startsWith('pending_')) return null;
    return {
      guest_checkout_id: row.id,
      payment_intent_id: row.stripe_payment_intent_id,
      status: row.status,
    };
  }

  private async mintJwt(
    shareToken: string,
    email: string,
    guestCheckoutId: string,
  ): Promise<string> {
    return new SignJWT({
      st: shareToken,
      em: email.toLowerCase(),
      gid: guestCheckoutId,
      type: RECOVERY_TYPE,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${RECOVERY_JWT_TTL_SECONDS}s`)
      .sign(this.getTokenKey());
  }

  private getTokenKey(): Uint8Array {
    // Audit A276-F3-P2-1 — share the entropy floor with the boot validator
    // (MIN_CHECKOUT_RECOVERY_SECRET_LENGTH = 43 → ≥256 bits per RFC 7518
    // §3.2 for HS256). Trim defensively so a trailing newline from an
    // operator paste doesn't slip through here while boot rejects it.
    const raw =
      this.config.get<string>('CHECKOUT_RECOVERY_SECRET') ??
      process.env.CHECKOUT_RECOVERY_SECRET ??
      '';
    const secret = raw.trim();
    if (!secret || secret.length < MIN_CHECKOUT_RECOVERY_SECRET_LENGTH) {
      // Refuse to mint / verify with a weak secret.  Throwing here is
      // the lesser evil — better to fail loudly than to silently sign
      // tokens with a guessable key.  Production env validation will
      // catch this at boot; the throw is the runtime safety net.
      throw new BadRequestException({
        error: 'CHECKOUT_RECOVERY_NOT_CONFIGURED',
        message: `Recovery secret not configured. Set CHECKOUT_RECOVERY_SECRET to a ${MIN_CHECKOUT_RECOVERY_SECRET_LENGTH}+ char value (256-bit entropy per RFC 7518 §3.2).`,
      });
    }
    return new TextEncoder().encode(secret);
  }

  private resolveStorefrontBase(): string {
    const raw =
      this.config.get<string>('STOREFRONT_BASE_URL') ??
      process.env.STOREFRONT_BASE_URL ??
      'https://joingrowthproject.com';
    return raw.replace(/\/+$/, '');
  }

  private formatAmount(row: { package_snapshot: unknown }): string {
    const snap = row.package_snapshot as Record<string, unknown> | null;
    if (!snap || typeof snap !== 'object') return '';
    const cents = typeof snap.price_cents === 'number' ? snap.price_cents : 0;
    const currency =
      typeof snap.currency === 'string' ? snap.currency.toUpperCase() : 'USD';
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
