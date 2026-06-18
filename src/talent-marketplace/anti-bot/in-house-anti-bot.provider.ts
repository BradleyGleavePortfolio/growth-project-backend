import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma.service';
import { ANTI_BOT_LIMITS } from './anti-bot.config';
import {
  AntiBotProvider,
  AntiBotSignal,
  AntiBotVerdict,
  ANTI_BOT_REASONS,
  AntiBotReason,
} from './anti-bot.types';

/** Minimal structural view of the ioredis client we use (INCR+EXPIRE pipeline). */
interface RedisPipeline {
  incr(key: string): unknown;
  expire(key: string, ttl: number): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}
interface RedisLike {
  pipeline(): RedisPipeline;
  connect(): Promise<void>;
}

/**
 * In-house anti-bot provider — the SHIPPED DEFAULT (operator ruling: build
 * in-house, no paid vendor). Three layers, cheapest first:
 *   1. Rate     — hard per-(IP,surface) counter (Redis INCR+EXPIRE, in-memory
 *                 fallback — same idiom as lead/checkout rate limiters) → deny.
 *   2. Velocity — softer per-identity counter, same window → challenge.
 *   3. Identity/device heuristics — from the PII-governed MarketplaceAbuseSignal
 *      store: a device touching too many distinct identities (sock-puppets) or
 *      an identity from too many distinct IPs (rotation) → challenge.
 *
 * All persisted identifiers are sha256-hashed before storage. Fails OPEN on any
 * storage error: the gate is defense-in-depth, never the sole control.
 */
@Injectable()
export class InHouseAntiBotProvider implements AntiBotProvider, OnModuleInit {
  readonly id = 'in-house';
  private readonly logger = new Logger(InHouseAntiBotProvider.name);
  private redis: RedisLike | null = null;
  private readonly memory = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL') || process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('REDIS_URL unset — in-house anti-bot using in-memory counters');
      return;
    }
    try {
      const { default: Redis } = await import('ioredis');
      const client: RedisLike = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await client.connect();
      this.redis = client;
      this.logger.log('In-house anti-bot Redis counters connected');
    } catch (err) {
      this.logger.warn(`Anti-bot Redis unavailable, in-memory fallback: ${(err as Error).message}`);
      this.redis = null;
    }
  }

  async evaluate(signal: AntiBotSignal): Promise<AntiBotVerdict> {
    const { ipWindowSec, ipLimit, identityLimit } = ANTI_BOT_LIMITS;
    const ipHash = this.hash(signal.ip || 'unknown');
    const identityHash = this.hash(signal.identityKey || signal.userId || 'anon');
    const deviceHash = this.hash(signal.deviceFingerprint || signal.userAgent || 'unknown');

    try {
      // Layer 1 — hard per-IP rate ceiling → conclusive deny.
      const ipCount = await this.incr(`tm:ab:ip:${signal.surface}:${ipHash}`, ipWindowSec);
      if (ipCount > ipLimit) {
        await this.record(signal, ipHash, identityHash, deviceHash, ANTI_BOT_REASONS.RateExceeded);
        return { decision: 'deny', reason: ANTI_BOT_REASONS.RateExceeded, retryAfterSeconds: ipWindowSec };
      }

      // Layer 2 — softer per-identity velocity → challenge.
      const idCount = await this.incr(`tm:ab:id:${signal.surface}:${identityHash}`, ipWindowSec);
      if (idCount > identityLimit) {
        await this.record(signal, ipHash, identityHash, deviceHash, ANTI_BOT_REASONS.VelocityAnomaly);
        return { decision: 'challenge', reason: ANTI_BOT_REASONS.VelocityAnomaly, retryAfterSeconds: ipWindowSec };
      }

      // Layer 3 — persisted duplicate-device / duplicate-identity heuristics.
      const heuristic = await this.checkPersistedHeuristics(identityHash, deviceHash);
      await this.record(signal, ipHash, identityHash, deviceHash, heuristic ?? undefined);
      if (heuristic) {
        return { decision: 'challenge', reason: heuristic, retryAfterSeconds: ipWindowSec };
      }

      return { decision: 'allow' };
    } catch (err) {
      // FAIL OPEN — defense-in-depth, never the sole control.
      this.logger.warn(`anti-bot evaluate failed open: ${(err as Error).message}`);
      return { decision: 'allow' };
    }
  }

  /** Distinct identities per device (sock-puppets) and distinct IPs per identity (rotation). */
  private async checkPersistedHeuristics(
    identityHash: string,
    deviceHash: string,
  ): Promise<AntiBotReason | null> {
    const since = new Date(Date.now() - ANTI_BOT_LIMITS.signalTtlDays * 86_400_000);

    const deviceRows = await this.prisma.marketplaceAbuseSignal.findMany({
      where: { device_hash: deviceHash, created_at: { gte: since } },
      distinct: ['identity_hash'],
      select: { identity_hash: true },
    });
    const identities = new Set(deviceRows.map((r) => r.identity_hash));
    identities.add(identityHash);
    if (identities.size > ANTI_BOT_LIMITS.deviceIdentityFanout) {
      return ANTI_BOT_REASONS.DuplicateDevice;
    }

    const ipRows = await this.prisma.marketplaceAbuseSignal.findMany({
      where: { identity_hash: identityHash, created_at: { gte: since } },
      distinct: ['ip_hash'],
      select: { ip_hash: true },
    });
    if (ipRows.length > ANTI_BOT_LIMITS.identityIpFanout) {
      return ANTI_BOT_REASONS.DuplicateIdentity;
    }
    return null;
  }

  /** Append one heuristic/abuse row to the PII-governed store. */
  private async record(
    signal: AntiBotSignal,
    ipHash: string,
    identityHash: string,
    deviceHash: string,
    reason?: AntiBotReason,
  ): Promise<void> {
    await this.prisma.marketplaceAbuseSignal.create({
      data: {
        surface: signal.surface,
        ip_hash: ipHash,
        identity_hash: identityHash,
        device_hash: deviceHash,
        reason: reason ?? null,
      },
    });
  }

  /** sha256 → 32 hex chars. Correlatable, non-reversible, fixed-width. */
  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
  }

  /** Atomic INCR+EXPIRE (Redis) or in-memory fallback. Returns post-incr count. */
  private async incr(key: string, ttlSec: number): Promise<number> {
    if (this.redis) {
      const pipe = this.redis.pipeline();
      pipe.incr(key);
      pipe.expire(key, ttlSec);
      const result = await pipe.exec();
      const count = result?.[0]?.[1];
      return typeof count === 'number' ? count : 0;
    }
    const now = Date.now();
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return existing.count;
    }
    this.memory.set(key, { count: 1, expiresAt: now + ttlSec * 1000 });
    if (this.memory.size > 4096) {
      for (const [k, v] of this.memory) if (v.expiresAt <= now) this.memory.delete(k);
    }
    return 1;
  }

  /** Test seam: clear in-memory counters between cases. */
  resetForTests(): void {
    this.memory.clear();
  }
}
