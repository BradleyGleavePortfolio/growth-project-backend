import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { KmsService } from '../common/kms/kms.service';

// r48 #3 — idempotency cache for PaymentIntent create.
//
// Failure mode: a guest network-drops between POST /checkout and the
// client_secret return.  Their retry generates a new idempotency_key
// (DTO is @IsUUID — they roll a fresh one).  Without a stable hash
// key, we mint a second PaymentIntent against Stripe even though
// nothing on Stripe's side has actually changed.  Worst case the
// guest sees two charges; best case the merchant pays double Stripe
// fees on retries.
//
// Mitigation: derive a content-addressable hash from
// sha256(share_token || ':' || email || ':' || session_id) and look
// it up in Redis SETNX style.  If a previous attempt with the same
// hash already minted a PaymentIntent, return its (id, client_secret)
// instead of hitting Stripe.  TTL is 24h to match the GuestCheckout's
// own CHECKOUT_TTL_MS so a stale row + a stale cache entry both age
// out together.
//
// The client_secret is KMS-encrypted at rest in Redis because anyone
// with the secret can confirm the payment in the buyer's browser.
// PaymentIntent id is stored in plaintext — it's a Stripe-prefixed
// identifier, not a credential.
//
// Falls back to a 1024-entry in-memory map when REDIS_URL is unset
// (dev/test).  Single-process only in that mode; multi-process
// require Redis.

const TTL_SECONDS = 24 * 60 * 60;
const MEMORY_CAP = 1024;
const REDIS_KEY_PREFIX = 'co:idem:';

interface IdempotencyEntry {
  payment_intent_id: string;
  /** Encrypted via KmsService — never the raw secret. */
  client_secret_encrypted: string;
}

@Injectable()
export class CheckoutIdempotencyService implements OnModuleInit {
  private readonly logger = new Logger(CheckoutIdempotencyService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any | null = null;
  /** In-memory fallback for dev/test boots without REDIS_URL. */
  private readonly memory = new Map<string, { value: IdempotencyEntry; expiresAt: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly kms: KmsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.log(
        'CheckoutIdempotencyService: REDIS_URL unset — using in-memory cache (single-process)',
      );
      return;
    }
    try {
      // Dynamic import so unit tests + dev boots without ioredis still work.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await this.redis.connect();
      this.logger.log('CheckoutIdempotencyService: Redis cache connected');
    } catch (err) {
      this.logger.warn(
        `CheckoutIdempotencyService: Redis unavailable, falling back to in-memory: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      this.redis = null;
    }
  }

  /**
   * Compute the deterministic hash used as the Redis key. Truncated
   * to 64 hex chars (256-bit SHA-256) — already the canonical length
   * for SHA-256 hex, so the truncation is a no-op but the explicit
   * `slice(0, 64)` documents the contract.
   */
  computeHash(shareToken: string, email: string, sessionId: string): string {
    return createHash('sha256')
      .update(`${shareToken}:${email.toLowerCase().trim()}:${sessionId}`)
      .digest('hex')
      .slice(0, 64);
  }

  /**
   * Atomic check-or-store. Returns the cached entry if one already
   * exists for the hash; otherwise records the new entry and returns
   * null. Uses Redis SET NX so concurrent callers cannot both win.
   */
  async checkOrStore(
    hash: string,
    paymentIntentId: string,
    clientSecret: string,
  ): Promise<IdempotencyEntry | null> {
    const entry: IdempotencyEntry = {
      payment_intent_id: paymentIntentId,
      client_secret_encrypted: this.kms.encrypt(clientSecret),
    };
    const key = `${REDIS_KEY_PREFIX}${hash}`;

    if (this.redis) {
      try {
        // SET NX EX — atomic. Returns 'OK' if we won the race, null otherwise.
        const setResult = await this.redis.set(
          key,
          JSON.stringify(entry),
          'EX',
          TTL_SECONDS,
          'NX',
        );
        if (setResult === 'OK') return null;
        // Lost the race — read the winner.
        const existingRaw = await this.redis.get(key);
        if (!existingRaw) return null; // race + ttl + eviction; treat as fresh.
        return JSON.parse(existingRaw) as IdempotencyEntry;
      } catch (err) {
        this.logger.warn(
          `Redis SETNX failed, falling back to memory: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        // fall through
      }
    }
    return this.memoryCheckOrStore(key, entry);
  }

  /**
   * Look up an existing entry without writing. Used by the
   * resume endpoint to fetch a previously-minted client_secret.
   * Returns null when the key is unknown or expired.
   */
  async lookup(hash: string): Promise<IdempotencyEntry | null> {
    const key = `${REDIS_KEY_PREFIX}${hash}`;
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) return null;
        return JSON.parse(raw) as IdempotencyEntry;
      } catch (err) {
        this.logger.warn(
          `Redis GET failed, falling back to memory: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    const memEntry = this.memory.get(key);
    if (!memEntry) return null;
    if (memEntry.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return memEntry.value;
  }

  /**
   * Convenience: lookup + decrypt the client_secret in one call.
   * Returns null when no cached entry exists.
   */
  async lookupDecrypted(
    hash: string,
  ): Promise<{ payment_intent_id: string; client_secret: string } | null> {
    const entry = await this.lookup(hash);
    if (!entry) return null;
    return {
      payment_intent_id: entry.payment_intent_id,
      client_secret: this.kms.decrypt(entry.client_secret_encrypted),
    };
  }

  /** Test seam — clears the in-memory cache between cases. */
  resetForTests(): void {
    this.memory.clear();
  }

  private memoryCheckOrStore(
    key: string,
    entry: IdempotencyEntry,
  ): IdempotencyEntry | null {
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.value;
    }
    // Eviction: drop oldest expired entry when over cap.
    if (this.memory.size >= MEMORY_CAP) {
      for (const [k, v] of this.memory) {
        if (v.expiresAt <= now) {
          this.memory.delete(k);
          if (this.memory.size < MEMORY_CAP) break;
        }
      }
      if (this.memory.size >= MEMORY_CAP) {
        // Still full — drop one at random rather than grow unbounded.
        const firstKey = this.memory.keys().next().value;
        if (firstKey !== undefined) this.memory.delete(firstKey);
      }
    }
    this.memory.set(key, { value: entry, expiresAt: now + TTL_SECONDS * 1000 });
    return null;
  }
}
