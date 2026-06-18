import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma.service';
import { InHouseAntiBotProvider } from '../in-house-anti-bot.provider';
import { ANTI_BOT_LIMITS } from '../anti-bot.config';
import { ANTI_BOT_REASONS, ANTI_BOT_SURFACES, AntiBotSignal } from '../anti-bot.types';

/** Same hash the provider uses, so tests can predict persisted hash values. */
const hash = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 32);

/**
 * Unit tests for the in-house anti-bot provider. No Redis and no real DB:
 * the provider falls back to its in-memory counters (REDIS_URL unset) and we
 * inject a fake PrismaService whose MarketplaceAbuseSignal model is an
 * in-array store, so the persisted heuristics exercise real logic.
 */

interface FakeRow {
  surface: string;
  ip_hash: string;
  identity_hash: string;
  device_hash: string;
  reason: string | null;
  created_at: Date;
}

function makeFakePrisma() {
  const rows: FakeRow[] = [];
  return {
    rows,
    marketplaceAbuseSignal: {
      create: jest.fn(async ({ data }: { data: Omit<FakeRow, 'created_at'> }) => {
        rows.push({ ...data, created_at: new Date() });
        return data;
      }),
      findMany: jest.fn(
        async ({
          where,
          distinct,
          select,
        }: {
          where: { device_hash?: string; identity_hash?: string; created_at: { gte: Date } };
          distinct: Array<keyof FakeRow>;
          select: Partial<Record<keyof FakeRow, boolean>>;
        }) => {
          let matched = rows.filter((r) => r.created_at >= where.created_at.gte);
          if (where.device_hash) matched = matched.filter((r) => r.device_hash === where.device_hash);
          if (where.identity_hash)
            matched = matched.filter((r) => r.identity_hash === where.identity_hash);
          const key = distinct[0];
          const seen = new Set<string>();
          const out: Array<Partial<FakeRow>> = [];
          for (const r of matched) {
            const v = r[key] as string;
            if (seen.has(v)) continue;
            seen.add(v);
            const proj: Partial<FakeRow> = {};
            for (const k of Object.keys(select) as Array<keyof FakeRow>) {
              (proj as Record<string, unknown>)[k] = r[k];
            }
            out.push(proj);
          }
          return out;
        },
      ),
    },
  };
}

function signal(over: Partial<AntiBotSignal> = {}): AntiBotSignal {
  return {
    surface: ANTI_BOT_SURFACES.Apply,
    ip: '203.0.113.7',
    userAgent: 'jest-agent',
    identityKey: 'applicant@example.com',
    deviceFingerprint: 'device-abc',
    ...over,
  };
}

describe('InHouseAntiBotProvider', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let provider: InHouseAntiBotProvider;

  beforeEach(async () => {
    delete process.env.REDIS_URL;
    prisma = makeFakePrisma();
    const config = new ConfigService({});
    // The fake exposes only the marketplaceAbuseSignal model the provider uses.
    // @ts-expect-error — structural narrowing of PrismaService for the unit test.
    const prismaService: PrismaService = prisma;
    provider = new InHouseAntiBotProvider(prismaService, config);
    await provider.onModuleInit();
    provider.resetForTests();
  });

  it('allows the first request and records an allow row (reason null)', async () => {
    const verdict = await provider.evaluate(signal());
    expect(verdict.decision).toBe('allow');
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].reason).toBeNull();
  });

  it('persists only sha256 hashes, never raw PII', async () => {
    await provider.evaluate(signal({ ip: '203.0.113.7', identityKey: 'pii@example.com' }));
    const row = prisma.rows[0];
    expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.identity_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.device_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.ip_hash).not.toContain('203.0.113.7');
    expect(row.identity_hash).not.toContain('pii@example.com');
  });

  it('denies once the per-IP rate ceiling is exceeded', async () => {
    // Distinct identities so the per-identity velocity layer never fires first;
    // only the shared IP bucket should trip.
    let last;
    for (let i = 0; i <= ANTI_BOT_LIMITS.ipLimit; i++) {
      last = await provider.evaluate(signal({ identityKey: `user-${i}@example.com`, deviceFingerprint: `dev-${i}` }));
    }
    expect(last?.decision).toBe('deny');
    expect(last?.reason).toBe(ANTI_BOT_REASONS.RateExceeded);
    expect(last?.retryAfterSeconds).toBe(ANTI_BOT_LIMITS.ipWindowSec);
  });

  it('challenges once the per-identity velocity ceiling is exceeded', async () => {
    // Distinct IPs/devices so the IP rate + device-fanout layers stay clear;
    // only the per-identity velocity counter should trip into a challenge.
    let last;
    for (let i = 0; i <= ANTI_BOT_LIMITS.identityLimit; i++) {
      last = await provider.evaluate(
        signal({ ip: `198.51.100.${i}`, identityKey: 'same@example.com', deviceFingerprint: `vdev-${i}` }),
      );
    }
    expect(last?.decision).toBe('challenge');
    expect(last?.reason).toBe(ANTI_BOT_REASONS.VelocityAnomaly);
  });

  it('challenges a device fingerprint that touches too many distinct identities', async () => {
    // Same device, distinct identities + distinct IPs (so rate/velocity stay clear).
    let last;
    for (let i = 0; i <= ANTI_BOT_LIMITS.deviceIdentityFanout; i++) {
      last = await provider.evaluate(
        signal({ ip: `192.0.2.${i}`, identityKey: `sock-${i}@example.com`, deviceFingerprint: 'shared-device' }),
      );
    }
    expect(last?.decision).toBe('challenge');
    expect(last?.reason).toBe(ANTI_BOT_REASONS.DuplicateDevice);
  });

  it('challenges an identity applying from too many distinct IPs', async () => {
    // Same identity, distinct IPs + distinct devices, isolating the IP-fanout
    // heuristic. The per-identity velocity counter would otherwise fire first
    // (it shares the identity bucket), so pre-seed the store directly with
    // identityIpFanout distinct-IP rows for this identity, then make ONE fresh
    // evaluation: that single request introduces the (fanout+1)-th distinct IP
    // and trips DuplicateIdentity without the velocity counter reaching its cap.
    const identityHash = hash('rotator@example.com');
    // Seed (fanout + 1) distinct persisted IPs for this identity so the
    // heuristic's `distinct ip_hash count > identityIpFanout` already holds;
    // the live evaluation then resolves to DuplicateIdentity.
    for (let i = 0; i <= ANTI_BOT_LIMITS.identityIpFanout; i++) {
      prisma.rows.push({
        surface: ANTI_BOT_SURFACES.Apply,
        ip_hash: `seed-ip-${i}`,
        identity_hash: identityHash,
        device_hash: `seed-dev-${i}`,
        reason: null,
        created_at: new Date(),
      });
    }
    const verdict = await provider.evaluate(
      signal({ ip: '203.0.113.250', identityKey: 'rotator@example.com', deviceFingerprint: 'fresh-dev' }),
    );
    expect(verdict.decision).toBe('challenge');
    expect(verdict.reason).toBe(ANTI_BOT_REASONS.DuplicateIdentity);
  });

  it('fails open (allow) when the store throws', async () => {
    prisma.marketplaceAbuseSignal.create.mockRejectedValueOnce(new Error('db down'));
    prisma.marketplaceAbuseSignal.findMany.mockRejectedValue(new Error('db down'));
    const verdict = await provider.evaluate(signal());
    expect(verdict.decision).toBe('allow');
  });
});
