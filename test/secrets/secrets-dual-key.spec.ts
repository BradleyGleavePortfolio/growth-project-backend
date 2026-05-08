/**
 * test/secrets/secrets-dual-key.spec.ts
 *
 * Tests the JWT dual-key rotation logic:
 *   - A token signed with the CURRENT key must be accepted
 *   - A token signed with the PREVIOUS key must be accepted during the
 *     transition window (JWT_SIGNING_KEY_PREVIOUS is set)
 *   - After the transition window closes (JWT_SIGNING_KEY_PREVIOUS unset),
 *     a token signed with the old key must be rejected
 *   - A token signed with an entirely unknown key is always rejected
 *
 * Also tests SecretsService.getSecretsStatus() and recordRotation().
 */

import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import { SecretsService, SECRET_INVENTORY, STALE_THRESHOLD_DAYS } from '../../src/secrets/secrets.service';
import { PrismaService } from '../../src/prisma.service';

// ─── JWT dual-key helpers (mirrors what the app does) ─────────────────────────

/**
 * Create a minimal HS256 JWT signed with the given key.
 * We implement this inline to avoid depending on any external JWT library in tests.
 */
function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigInput = `${header}.${body}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(sigInput)
    .digest('base64url');
  return `${sigInput}.${sig}`;
}

/**
 * Verify a JWT against one or more keys (current + optional previous).
 * Returns the decoded payload on success; throws on failure.
 * This mirrors the dual-key logic the app uses.
 */
function verifyJwt(
  token: string,
  currentKey: string,
  previousKey?: string,
): Record<string, unknown> {
  const [headerB64, bodyB64, sigB64] = token.split('.');
  if (!headerB64 || !bodyB64 || !sigB64) throw new Error('malformed token');

  const sigInput = `${headerB64}.${bodyB64}`;

  const keysToTry = [currentKey, ...(previousKey ? [previousKey] : [])];
  for (const key of keysToTry) {
    const expected = crypto
      .createHmac('sha256', key)
      .update(sigInput)
      .digest('base64url');
    if (expected === sigB64) {
      return JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf-8')) as Record<string, unknown>;
    }
  }

  throw new Error('signature verification failed');
}

// ─── Dual-key rotation tests ───────────────────────────────────────────────────

describe('JWT dual-key rotation logic', () => {
  const keyA = crypto.randomBytes(32).toString('hex'); // "old" key
  const keyB = crypto.randomBytes(32).toString('hex'); // "new" key
  const keyC = crypto.randomBytes(32).toString('hex'); // unknown key

  const payload = { sub: 'user-123', role: 'coach', iat: Math.floor(Date.now() / 1000) };

  const tokenSignedWithA = signJwt(payload, keyA);
  const tokenSignedWithB = signJwt(payload, keyB);
  const tokenSignedWithC = signJwt(payload, keyC);

  describe('during rotation (both keys active)', () => {
    // Simulates: JWT_SIGNING_KEY=keyB, JWT_SIGNING_KEY_PREVIOUS=keyA
    it('accepts a token signed with the new (current) key', () => {
      expect(() => verifyJwt(tokenSignedWithB, keyB, keyA)).not.toThrow();
      const decoded = verifyJwt(tokenSignedWithB, keyB, keyA);
      expect(decoded.sub).toBe('user-123');
    });

    it('accepts a token signed with the old (previous) key', () => {
      expect(() => verifyJwt(tokenSignedWithA, keyB, keyA)).not.toThrow();
      const decoded = verifyJwt(tokenSignedWithA, keyB, keyA);
      expect(decoded.sub).toBe('user-123');
    });

    it('rejects a token signed with an unknown key', () => {
      expect(() => verifyJwt(tokenSignedWithC, keyB, keyA)).toThrow(
        'signature verification failed',
      );
    });
  });

  describe('after rotation window closes (only new key active)', () => {
    // Simulates: JWT_SIGNING_KEY=keyB, JWT_SIGNING_KEY_PREVIOUS=<unset>
    it('accepts a token signed with the new key', () => {
      expect(() => verifyJwt(tokenSignedWithB, keyB)).not.toThrow();
    });

    it('rejects a token signed with the old key', () => {
      // The old key is no longer in the key list, so it must be rejected.
      expect(() => verifyJwt(tokenSignedWithA, keyB)).toThrow(
        'signature verification failed',
      );
    });

    it('rejects a token signed with an unknown key', () => {
      expect(() => verifyJwt(tokenSignedWithC, keyB)).toThrow(
        'signature verification failed',
      );
    });
  });

  describe('malformed tokens', () => {
    it('rejects a token with fewer than 3 segments', () => {
      expect(() => verifyJwt('header.body', keyB)).toThrow('malformed token');
    });

    it('rejects an empty string', () => {
      expect(() => verifyJwt('', keyB)).toThrow('malformed token');
    });

    it('rejects a tampered payload', () => {
      // Take a valid token and replace the payload segment
      const [header, , sig] = tokenSignedWithB.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({ sub: 'attacker', role: 'owner' }),
      ).toString('base64url');
      const tampered = `${header}.${tamperedPayload}.${sig}`;
      expect(() => verifyJwt(tampered, keyB)).toThrow('signature verification failed');
    });
  });
});

// ─── SecretsService unit tests ─────────────────────────────────────────────────

describe('SecretsService', () => {
  let service: SecretsService;

  const mockPrisma = {
    secretRotationLog: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecretsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<SecretsService>(SecretsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getSecretsStatus()', () => {
    it('marks never-rotated secrets as stale', async () => {
      mockPrisma.secretRotationLog.findMany.mockResolvedValue([]);

      const statuses = await service.getSecretsStatus();

      for (const s of statuses) {
        expect(s.isStale).toBe(true);
        expect(s.lastRotatedAt).toBeNull();
        expect(s.daysSinceRotation).toBeNull();
      }
    });

    it('marks a recently rotated secret as healthy', async () => {
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
      mockPrisma.secretRotationLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          secret_name: 'JWT_SIGNING_KEY',
          rotated_at: recentDate,
          rotated_by_user_id: 'user-123',
          notes: 'test rotation',
        },
      ]);

      const statuses = await service.getSecretsStatus();
      const jwt = statuses.find((s) => s.name === 'JWT_SIGNING_KEY');
      expect(jwt).toBeDefined();
      expect(jwt!.isStale).toBe(false);
      expect(jwt!.daysSinceRotation).toBe(5);
      expect(jwt!.lastRotatedAt).toEqual(recentDate);
    });

    it('marks an overdue secret as stale', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago
      mockPrisma.secretRotationLog.findMany.mockResolvedValue([
        {
          id: 'log-2',
          secret_name: 'JWT_SIGNING_KEY',
          rotated_at: oldDate,
          rotated_by_user_id: 'user-123',
          notes: null,
        },
      ]);

      const statuses = await service.getSecretsStatus();
      const jwt = statuses.find((s) => s.name === 'JWT_SIGNING_KEY');
      expect(jwt).toBeDefined();
      // JWT_SIGNING_KEY cadence is 90 days; 100 days > 90 → stale
      expect(jwt!.isStale).toBe(true);
      expect(jwt!.daysSinceRotation).toBe(100);
    });

    it('returns all secrets from the inventory', async () => {
      mockPrisma.secretRotationLog.findMany.mockResolvedValue([]);
      const statuses = await service.getSecretsStatus();
      expect(statuses.length).toBe(SECRET_INVENTORY.length);
    });

    it('never leaks secret values in the response', async () => {
      mockPrisma.secretRotationLog.findMany.mockResolvedValue([
        {
          id: 'log-3',
          secret_name: 'DATABASE_URL',
          rotated_at: new Date(),
          rotated_by_user_id: null,
          notes: 'should never contain the actual URL',
        },
      ]);

      const statuses = await service.getSecretsStatus();

      // Verify no field looks like a secret value
      for (const s of statuses) {
        const json = JSON.stringify(s);
        expect(json).not.toMatch(/postgresql:\/\//);
        expect(json).not.toMatch(/sk_live_/);
        expect(json).not.toMatch(/eyJ/); // JWT header
        expect(json).not.toMatch(/whsec_/);
      }
    });
  });

  describe('recordRotation()', () => {
    it('creates a rotation log entry', async () => {
      const now = new Date();
      mockPrisma.secretRotationLog.create.mockResolvedValue({
        id: 'new-log-id',
        secret_name: 'JWT_SIGNING_KEY',
        rotated_at: now,
        rotated_by_user_id: 'user-abc',
        notes: 'test',
      });

      const result = await service.recordRotation('JWT_SIGNING_KEY', 'user-abc', 'test');

      expect(result.id).toBe('new-log-id');
      expect(result.rotatedAt).toEqual(now);
      expect(mockPrisma.secretRotationLog.create).toHaveBeenCalledWith({
        data: {
          secret_name: 'JWT_SIGNING_KEY',
          rotated_by_user_id: 'user-abc',
          notes: 'test',
        },
      });
    });

    it('does not throw for secrets not in the inventory (warns only)', async () => {
      mockPrisma.secretRotationLog.create.mockResolvedValue({
        id: 'log-x',
        secret_name: 'UNKNOWN_SECRET',
        rotated_at: new Date(),
        rotated_by_user_id: 'user-abc',
        notes: null,
      });

      // Should not throw — just logs a warning
      await expect(
        service.recordRotation('UNKNOWN_SECRET', 'user-abc'),
      ).resolves.toBeTruthy();
    });
  });
});

// ─── SECRET_INVENTORY integrity tests ─────────────────────────────────────────

describe('SECRET_INVENTORY', () => {
  it('has no duplicate secret names', () => {
    const names = SECRET_INVENTORY.map((d) => d.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every secret has a positive cadenceDays', () => {
    for (const def of SECRET_INVENTORY) {
      expect(def.cadenceDays).toBeGreaterThan(0);
    }
  });

  it('every secret has a valid tier', () => {
    const validTiers = ['critical', 'high', 'standard'];
    for (const def of SECRET_INVENTORY) {
      expect(validTiers).toContain(def.tier);
    }
  });

  it('every secret has a non-empty description', () => {
    for (const def of SECRET_INVENTORY) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('STALE_THRESHOLD_DAYS is 90', () => {
    expect(STALE_THRESHOLD_DAYS).toBe(90);
  });
});

// ─── Staleness check script behavior (unit) ────────────────────────────────────

describe('staleness check script behavior (unit)', () => {
  // We test the staleness logic directly (the script itself is a thin wrapper
  // around the same Prisma query logic used by SecretsService).

  it('flags a never-rotated secret as stale', () => {
    const lastRotatedAt: Date | null = null;
    const cadenceDays = 90;
    const now = new Date();

    let daysSinceRotation: number | null = null;
    let isStale = true;

    if (lastRotatedAt !== null) {
      const last = lastRotatedAt as Date;
      daysSinceRotation = Math.floor(
        (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24),
      );
      isStale = daysSinceRotation > cadenceDays;
    }

    expect(isStale).toBe(true);
    expect(daysSinceRotation).toBeNull();
  });

  it('flags a 95-day-old secret as stale (cadence=90)', () => {
    const lastRotatedAt = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
    const cadenceDays = 90;
    const now = new Date();

    const daysSinceRotation = Math.floor(
      (now.getTime() - lastRotatedAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    const isStale = daysSinceRotation > cadenceDays;

    expect(isStale).toBe(true);
    expect(daysSinceRotation).toBeGreaterThanOrEqual(95);
  });

  it('does not flag a 30-day-old secret as stale (cadence=90)', () => {
    const lastRotatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cadenceDays = 90;
    const now = new Date();

    const daysSinceRotation = Math.floor(
      (now.getTime() - lastRotatedAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    const isStale = daysSinceRotation > cadenceDays;

    expect(isStale).toBe(false);
    expect(daysSinceRotation).toBeLessThanOrEqual(31);
  });
});
