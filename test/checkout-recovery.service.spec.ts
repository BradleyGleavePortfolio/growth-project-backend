/**
 * Unit tests for CheckoutRecoveryService — focused on A276-P1-3:
 * single-use JWT enforcement via Redis SETNX on the `jti` claim.
 *
 * The global jose mock in test/__mocks__/jose.ts is overridden here so
 * we can inject claim payloads directly without exercising real HS256
 * sign/verify (the dependency is ESM-only and ts-jest can't transform
 * it for CJS tests).
 */
import { ConfigService } from '@nestjs/config';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';

// Programmable jose mock — each test sets the next jwtVerify result.
// We have to do this BEFORE importing the service.
const mockJwtVerify = jest.fn();
jest.mock('jose', () => ({
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
  SignJWT: class {
    constructor(private payload: Record<string, unknown>) {}
    setProtectedHeader() {
      return this;
    }
    setJti(jti: string) {
      this.payload.jti = jti;
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign() {
      return `signed:${JSON.stringify(this.payload)}`;
    }
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CheckoutRecoveryService } = require('../src/storefront/checkout-recovery.service');

const VALID_SECRET = 'test-recovery-secret-at-least-32-chars-long!!';
const SHARE_TOKEN = 'shr_test_token';
const EMAIL = 'guest@example.com';
const GID = 'gc_123';

function makeService(opts: {
  configOverrides?: Record<string, string | undefined>;
  prismaRow?: unknown;
} = {}) {
  const config = {
    get: jest.fn((k: string) => {
      const overrides = opts.configOverrides ?? {};
      if (k in overrides) return overrides[k];
      if (k === 'CHECKOUT_RECOVERY_SECRET') return VALID_SECRET;
      return undefined;
    }),
  } as unknown as ConfigService;

  const prisma = {
    guestCheckout: {
      findUnique: jest.fn(async () =>
        opts.prismaRow === undefined
          ? {
              id: GID,
              guest_email: EMAIL,
              expires_at: new Date(Date.now() + 10 * 60 * 1000),
            }
          : opts.prismaRow,
      ),
    },
  } as any;

  const svc = new CheckoutRecoveryService(prisma, config);
  return { svc, prisma, config };
}

function setVerifyReturn(payload: Record<string, unknown>) {
  mockJwtVerify.mockResolvedValueOnce({ payload, protectedHeader: { alg: 'HS256' } });
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    st: SHARE_TOKEN,
    em: EMAIL,
    gid: GID,
    type: 'checkout_recovery',
    jti: 'jti-' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

describe('CheckoutRecoveryService — single-use guard (A276-P1-3)', () => {
  beforeEach(() => {
    mockJwtVerify.mockReset();
  });

  it('first verifyToken call succeeds, second call with the same jti throws RECOVERY_TOKEN_USED', async () => {
    const { svc } = makeService();
    const claims = baseClaims();

    setVerifyReturn(claims);
    const first = await svc.verifyToken(SHARE_TOKEN, 'opaque-token-1');
    expect(first).toEqual({
      share_token: SHARE_TOKEN,
      email: EMAIL,
      guest_checkout_id: GID,
    });

    setVerifyReturn(claims); // same jti — simulates a captured-token replay
    await expect(
      svc.verifyToken(SHARE_TOKEN, 'opaque-token-1-replay'),
    ).rejects.toMatchObject({
      response: {
        error: 'RECOVERY_TOKEN_USED',
        message: expect.stringContaining('already been used'),
      },
    });
    await expect(
      (async () => {
        setVerifyReturn(claims);
        await svc.verifyToken(SHARE_TOKEN, 'opaque-token-1-replay-2');
      })(),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('two distinct jtis are independent — each is single-use on its own', async () => {
    const { svc } = makeService();

    const claimsA = baseClaims({ jti: 'jti-A' });
    const claimsB = baseClaims({ jti: 'jti-B' });

    setVerifyReturn(claimsA);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tA')).resolves.toBeDefined();
    setVerifyReturn(claimsB);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tB')).resolves.toBeDefined();

    // Each replays independently.
    setVerifyReturn(claimsA);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tA2')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_USED' },
    });
    setVerifyReturn(claimsB);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tB2')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_USED' },
    });
  });

  it('legacy token without `jti` claim is rejected as RECOVERY_TOKEN_INVALID (not silently accepted)', async () => {
    const { svc } = makeService();
    const legacyClaims = baseClaims();
    delete (legacyClaims as Record<string, unknown>).jti;

    setVerifyReturn(legacyClaims);
    await expect(svc.verifyToken(SHARE_TOKEN, 'legacy-token')).rejects.toMatchObject({
      response: {
        error: 'RECOVERY_TOKEN_INVALID',
      },
    });
    await expect(
      (async () => {
        setVerifyReturn(legacyClaims);
        await svc.verifyToken(SHARE_TOKEN, 'legacy-token-2');
      })(),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('empty string `jti` is also rejected as RECOVERY_TOKEN_INVALID', async () => {
    const { svc } = makeService();
    setVerifyReturn(baseClaims({ jti: '' }));
    await expect(svc.verifyToken(SHARE_TOKEN, 'tok')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
  });

  it('Redis SETNX throw → verifyToken FAILS CLOSED (rejects, does not bypass)', async () => {
    const { svc } = makeService();
    // Force the Redis branch by injecting a stub client whose .set throws.
    const brokenRedis = {
      set: jest.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      }),
    };
    (svc as any).redis = brokenRedis;

    setVerifyReturn(baseClaims({ jti: 'jti-fail-closed' }));
    await expect(
      svc.verifyToken(SHARE_TOKEN, 'fail-closed-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      (async () => {
        setVerifyReturn(baseClaims({ jti: 'jti-fail-closed' }));
        await svc.verifyToken(SHARE_TOKEN, 'fail-closed-token-2');
      })(),
    ).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_USED' },
    });
    expect(brokenRedis.set).toHaveBeenCalled();
  });

  it('Redis SETNX returns null (key existed) → throws RECOVERY_TOKEN_USED', async () => {
    const { svc } = makeService();
    const redisStub = {
      set: jest.fn(async () => null),
    };
    (svc as any).redis = redisStub;

    setVerifyReturn(baseClaims({ jti: 'jti-already-claimed' }));
    await expect(svc.verifyToken(SHARE_TOKEN, 'tok')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_USED' },
    });
    expect(redisStub.set).toHaveBeenCalledWith(
      'co:rec:jti:jti-already-claimed',
      '1',
      'EX',
      900,
      'NX',
    );
  });

  it('Redis SETNX returns OK → verifyToken succeeds and returns claims', async () => {
    const { svc } = makeService();
    const redisStub = { set: jest.fn(async () => 'OK') };
    (svc as any).redis = redisStub;

    setVerifyReturn(baseClaims({ jti: 'jti-fresh' }));
    const result = await svc.verifyToken(SHARE_TOKEN, 'tok');
    expect(result).toEqual({
      share_token: SHARE_TOKEN,
      email: EMAIL,
      guest_checkout_id: GID,
    });
    expect(redisStub.set).toHaveBeenCalledTimes(1);
    expect(redisStub.set).toHaveBeenCalledWith(
      'co:rec:jti:jti-fresh',
      '1',
      'EX',
      900,
      'NX',
    );
  });

  it('SETNX is the LAST step — bad signature does not consume the token', async () => {
    const { svc } = makeService();
    const redisStub = { set: jest.fn(async () => 'OK') };
    (svc as any).redis = redisStub;

    // jwtVerify throws (signature failure)
    mockJwtVerify.mockRejectedValueOnce(new Error('bad signature'));
    await expect(svc.verifyToken(SHARE_TOKEN, 'tampered')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    expect(redisStub.set).not.toHaveBeenCalled();
  });

  it('SETNX not called when GuestCheckout row is missing (token not consumed by miss)', async () => {
    const { svc } = makeService({ prismaRow: null });
    const redisStub = { set: jest.fn(async () => 'OK') };
    (svc as any).redis = redisStub;

    setVerifyReturn(baseClaims({ jti: 'jti-no-row' }));
    await expect(svc.verifyToken(SHARE_TOKEN, 'tok')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    expect(redisStub.set).not.toHaveBeenCalled();
  });

  it('SETNX not called when share_token claim mismatches the path', async () => {
    const { svc } = makeService();
    const redisStub = { set: jest.fn(async () => 'OK') };
    (svc as any).redis = redisStub;

    setVerifyReturn(baseClaims({ st: 'other-share-token' }));
    await expect(svc.verifyToken(SHARE_TOKEN, 'tok')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    expect(redisStub.set).not.toHaveBeenCalled();
  });

  it('SETNX not called when GuestCheckout row is expired', async () => {
    const { svc } = makeService({
      prismaRow: {
        id: GID,
        guest_email: EMAIL,
        expires_at: new Date(Date.now() - 60_000),
      },
    });
    const redisStub = { set: jest.fn(async () => 'OK') };
    (svc as any).redis = redisStub;

    setVerifyReturn(baseClaims());
    await expect(svc.verifyToken(SHARE_TOKEN, 'tok')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    expect(redisStub.set).not.toHaveBeenCalled();
  });

  it('in-memory fallback (no REDIS_URL) still enforces single-use within the process', async () => {
    const { svc } = makeService();
    // redis is null by construction (onModuleInit not called)
    expect((svc as any).redis).toBeNull();

    const claims = baseClaims({ jti: 'jti-mem' });
    setVerifyReturn(claims);
    await expect(svc.verifyToken(SHARE_TOKEN, 't1')).resolves.toBeDefined();
    setVerifyReturn(claims);
    await expect(svc.verifyToken(SHARE_TOKEN, 't1-replay')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_USED' },
    });
  });

  it('mintJwt includes a `jti` claim via SignJWT.setJti', async () => {
    const { svc } = makeService();
    // The mocked SignJWT serializes the payload into the returned string;
    // we can read it back to verify jti was set.
    const token: string = await (svc as any).mintJwt(SHARE_TOKEN, EMAIL, GID);
    expect(token.startsWith('signed:')).toBe(true);
    const payload = JSON.parse(token.slice('signed:'.length));
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti.length).toBeGreaterThan(8); // randomUUID is 36 chars
    expect(payload.st).toBe(SHARE_TOKEN);
    expect(payload.em).toBe(EMAIL);
    expect(payload.gid).toBe(GID);
    expect(payload.type).toBe('checkout_recovery');
  });

  it('mintJwt generates a fresh jti per call', async () => {
    const { svc } = makeService();
    const t1: string = await (svc as any).mintJwt(SHARE_TOKEN, EMAIL, GID);
    const t2: string = await (svc as any).mintJwt(SHARE_TOKEN, EMAIL, GID);
    const j1 = JSON.parse(t1.slice('signed:'.length)).jti;
    const j2 = JSON.parse(t2.slice('signed:'.length)).jti;
    expect(j1).not.toEqual(j2);
  });
});

// A276-F5-P1-1 — boot-time Redis failure must fail CLOSED in production.
// Cross-machine replay was possible when onModuleInit silently demoted to
// the in-memory single-use guard; production now refuses to boot instead.
describe('CheckoutRecoveryService.onModuleInit — boot fail-closed (A276-F5-P1-1)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.resetModules();
  });

  function makeServiceForBoot(opts: {
    redisUrl?: string;
    nodeEnv?: string;
  } = {}) {
    const config = {
      get: jest.fn((k: string) => {
        if (k === 'CHECKOUT_RECOVERY_SECRET') return VALID_SECRET;
        if (k === 'REDIS_URL') return opts.redisUrl;
        if (k === 'NODE_ENV') return opts.nodeEnv;
        return undefined;
      }),
    } as unknown as ConfigService;
    const prisma = {
      guestCheckout: { findUnique: jest.fn(async () => null) },
    } as any;
    return new CheckoutRecoveryService(prisma, config);
  }

  it('production + REDIS_URL unset → onModuleInit THROWS (refuses to boot)', async () => {
    const svc = makeServiceForBoot({ nodeEnv: 'production', redisUrl: undefined });
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required in production/);
    // No silent fallback — redis stays null but the throw propagated.
    expect((svc as any).redis).toBeNull();
  });

  it('production + REDIS_URL set but unreachable → onModuleInit THROWS (refuses to boot)', async () => {
    // Simulate a Redis connect failure by registering a fake ioredis module
    // that throws from .connect(). The service uses dynamic `import('ioredis')`
    // so we have to wire the mock inside an isolated module registry and
    // re-require the service against that same registry.
    let CRS!: typeof CheckoutRecoveryService;
    jest.isolateModules(() => {
      jest.doMock('ioredis', () => {
        class FakeRedis {
          async connect() {
            throw new Error('ECONNREFUSED 10.0.0.1:6379');
          }
          disconnect() {}
        }
        return { __esModule: true, default: FakeRedis };
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ CheckoutRecoveryService: CRS } = require('../src/storefront/checkout-recovery.service'));
    });

    const config = {
      get: jest.fn((k: string) => {
        if (k === 'CHECKOUT_RECOVERY_SECRET') return VALID_SECRET;
        if (k === 'REDIS_URL') return 'redis://unreachable:6379';
        if (k === 'NODE_ENV') return 'production';
        return undefined;
      }),
    } as unknown as ConfigService;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    const svc = new CRS(prisma, config);
    await expect(svc.onModuleInit()).rejects.toThrow(/ECONNREFUSED/);
    expect((svc as any).redis).toBeNull();
  });

  it('non-production (development) + REDIS_URL unset → onModuleInit RESOLVES (in-memory fallback)', async () => {
    const svc = makeServiceForBoot({ nodeEnv: 'development', redisUrl: undefined });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect((svc as any).redis).toBeNull();
  });

  it('non-production (test) + REDIS_URL unset → onModuleInit RESOLVES (in-memory fallback)', async () => {
    const svc = makeServiceForBoot({ nodeEnv: 'test', redisUrl: undefined });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect((svc as any).redis).toBeNull();
  });

  it('non-production + REDIS_URL set but unreachable → onModuleInit RESOLVES with warn (in-memory fallback)', async () => {
    let CRS!: typeof CheckoutRecoveryService;
    jest.isolateModules(() => {
      jest.doMock('ioredis', () => {
        class FakeRedis {
          async connect() {
            throw new Error('ECONNREFUSED 127.0.0.1:6379');
          }
          disconnect() {}
        }
        return { __esModule: true, default: FakeRedis };
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ CheckoutRecoveryService: CRS } = require('../src/storefront/checkout-recovery.service'));
    });
    const config = {
      get: jest.fn((k: string) => {
        if (k === 'CHECKOUT_RECOVERY_SECRET') return VALID_SECRET;
        if (k === 'REDIS_URL') return 'redis://unreachable:6379';
        if (k === 'NODE_ENV') return 'development';
        return undefined;
      }),
    } as unknown as ConfigService;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    const svc = new CRS(prisma, config);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect((svc as any).redis).toBeNull();
  });
});
