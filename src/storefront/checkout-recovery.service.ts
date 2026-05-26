import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { PrismaService } from '../prisma.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';

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

// A276-P1-3 — single-use guard.
//
// Every recovery JWT now carries a random `jti` claim (uuidv4).
// On verifyToken, after all signature/expiry/row checks pass, we
// SETNX co:rec:jti:<jti> 1 EX 900 — if the key already exists
// (previously consumed within the 15-minute exp window) we throw
// `RECOVERY_TOKEN_USED`. SETNX is the LAST step of verification so
// a failing earlier check (bad signature, expired, GuestCheckout
// missing) does not consume the token.
//
// Backwards compatibility: tokens minted before this commit have no
// `jti` claim. Those tokens are now rejected with the generic
// `RECOVERY_TOKEN_INVALID` error — acceptable because they expire in
// at most 15 minutes and the security improvement (no replay) is
// worth the brief disruption to in-flight magic links.
const RECOVERY_JTI_REDIS_PREFIX = 'co:rec:jti:';
const RECOVERY_MEMORY_CAP = 1024;

interface RecoveryClaims extends JWTPayload {
  st: string; // share_token
  em: string; // email
  gid: string; // guest_checkout_id
  type: typeof RECOVERY_TYPE;
  jti: string; // random uuid — single-use guard key
}

@Injectable()
export class CheckoutRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(CheckoutRecoveryService.name);

  // Redis is used to atomically mark a `jti` as consumed (SETNX). Mirrors
  // CheckoutIdempotencyService's pattern (dynamic ioredis import, lazy
  // connect, in-memory fallback for dev/test boots without REDIS_URL).
  // A different key prefix keeps the namespace clean.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  /** In-memory fallback for dev/test boots without REDIS_URL. Single
   * process only — production MUST set REDIS_URL or replays across
   * Fly machines remain possible. */
  private readonly memory = new Map<string, number>(); // key -> expiresAtMs

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly email?: EmailService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    const nodeEnv =
      this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';
    const isProd = nodeEnv === 'production';
    if (!redisUrl) {
      // A276-F5-P1-1 — REDIS_URL is REQUIRED in production. The in-memory
      // fallback is single-process only; with ≥2 Fly machines behind a
      // load balancer it cannot enforce single-use across the cluster,
      // which defeats the whole point of the single-use guard.
      if (isProd) {
        const msg =
          'CheckoutRecoveryService: REDIS_URL is required in production — refusing to boot. ' +
          'The in-memory single-use guard is single-process and unsafe across the Fly cluster.';
        this.logger.error(msg);
        throw new Error(msg);
      }
      this.logger.log(
        'CheckoutRecoveryService: REDIS_URL unset — using in-memory single-use guard (single-process, dev/test only)',
      );
      return;
    }
    try {
      // Dynamic import so unit tests + dev boots without ioredis still work.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.redis.connect();
      this.logger.log('CheckoutRecoveryService: Redis single-use guard connected');
    } catch (err) {
      // A276-F5-P1-1 — fail CLOSED in production. A boot-time Redis
      // outage previously silently demoted us to the in-memory guard,
      // re-opening the cross-machine replay window the JWT-jti work was
      // designed to close. Refuse to start instead — the process
      // supervisor (Fly) will retry until Redis is reachable.
      const detail = err instanceof Error ? err.message : 'unknown';
      if (isProd) {
        this.logger.error(
          `CheckoutRecoveryService: Redis connect failed in production — refusing to boot: ${detail}`,
        );
        // Best-effort cleanup of any half-open client before bubbling.
        try {
          this.redis?.disconnect?.();
        } catch {
          /* ignore — we're already aborting boot */
        }
        this.redis = null;
        throw err instanceof Error
          ? err
          : new Error(`CheckoutRecoveryService Redis connect failed: ${detail}`);
      }
      this.logger.warn(
        `CheckoutRecoveryService: Redis unavailable in ${nodeEnv}, falling back to in-memory (dev/test only): ${detail}`,
      );
      this.redis = null;
    }
  }

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
    // A276-P1-3 — require `jti`. Legacy tokens (pre-this-commit) without
    // a jti claim cannot be marked single-use and so are no longer
    // accepted. The 15-min exp bounds the disruption.
    if (typeof claims.jti !== 'string' || claims.jti.length === 0) {
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
    // A276-P1-3 — single-use guard. Done LAST in verification so a token
    // is only consumed once every other check has passed. If Redis is
    // configured but errors out, we FAIL CLOSED — better to deny a
    // legitimate retry than to allow a replay.
    await this.markJtiConsumedOrThrow(claims.jti);
    return {
      share_token: claims.st,
      email: claims.em,
      guest_checkout_id: claims.gid,
    };
  }

  /**
   * Atomically claim the JWT's `jti` as "consumed" via Redis SETNX with
   * a TTL matching the JWT's exp (900s). Throws RECOVERY_TOKEN_USED on
   * collision, and FAILS CLOSED if the backing store is unreachable.
   */
  private async markJtiConsumedOrThrow(jti: string): Promise<void> {
    const key = `${RECOVERY_JTI_REDIS_PREFIX}${jti}`;
    if (this.redis) {
      let setResult: unknown;
      try {
        // SET NX EX — atomic. Returns 'OK' if we won (first use), null otherwise.
        setResult = await this.redis.set(
          key,
          '1',
          'EX',
          RECOVERY_JWT_TTL_SECONDS,
          'NX',
        );
      } catch (err) {
        // Fail closed: Redis is the source of truth for single-use; if
        // we cannot reach it we must not allow the token through.
        this.logger.error(
          `recovery single-use guard: Redis SETNX failed, denying: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
        throw new UnauthorizedException({
          error: 'RECOVERY_TOKEN_USED',
          message: 'This recovery link has already been used. Request a new one.',
        });
      }
      if (setResult !== 'OK') {
        throw new UnauthorizedException({
          error: 'RECOVERY_TOKEN_USED',
          message: 'This recovery link has already been used. Request a new one.',
        });
      }
      return;
    }
    // No Redis — in-memory fallback (dev/test only).
    this.memoryClaimOrThrow(key);
  }

  private memoryClaimOrThrow(key: string): void {
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing !== undefined && existing > now) {
      throw new UnauthorizedException({
        error: 'RECOVERY_TOKEN_USED',
        message: 'This recovery link has already been used. Request a new one.',
      });
    }
    // Lazy GC + cap to keep the map bounded across long-running test runs.
    if (this.memory.size >= RECOVERY_MEMORY_CAP) {
      for (const [k, exp] of this.memory) {
        if (exp <= now) this.memory.delete(k);
      }
      if (this.memory.size >= RECOVERY_MEMORY_CAP) {
        const firstKey = this.memory.keys().next().value;
        if (firstKey !== undefined) this.memory.delete(firstKey);
      }
    }
    this.memory.set(key, now + RECOVERY_JWT_TTL_SECONDS * 1000);
  }

  /** Test seam — clears the in-memory single-use set between cases. */
  resetForTests(): void {
    this.memory.clear();
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
    // A276-P1-3 — every recovery JWT gets a random jti so the verifier
    // can mark it consumed (Redis SETNX) and reject replays within the
    // 15-minute exp window.
    const jti = randomUUID();
    return new SignJWT({
      st: shareToken,
      em: email.toLowerCase(),
      gid: guestCheckoutId,
      type: RECOVERY_TYPE,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${RECOVERY_JWT_TTL_SECONDS}s`)
      .sign(this.getTokenKey());
  }

  private getTokenKey(): Uint8Array {
    const secret =
      this.config.get<string>('CHECKOUT_RECOVERY_SECRET') ??
      process.env.CHECKOUT_RECOVERY_SECRET ??
      '';
    if (!secret || secret.length < 32) {
      // Refuse to mint / verify with a weak secret.  Throwing here is
      // the lesser evil — better to fail loudly than to silently sign
      // tokens with a guessable key.  Production env validation will
      // catch this at boot; the throw is the runtime safety net.
      throw new BadRequestException({
        error: 'CHECKOUT_RECOVERY_NOT_CONFIGURED',
        message:
          'Recovery secret not configured. Set CHECKOUT_RECOVERY_SECRET to a 32+ char value.',
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
