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
import { NotFoundException } from '@nestjs/common';

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

  // A276-F5-P1-2 — replay attempts MUST return the same enumeration-resistant
  // response (404 + RECOVERY_TOKEN_INVALID) as any other invalid-token leg.
  // Returning 401 + RECOVERY_TOKEN_USED would give an attacker who captured
  // a recovery link a 1-bit oracle confirming the link was real.
  it('first verifyToken call succeeds, second call with the same jti throws RECOVERY_TOKEN_INVALID (no enumeration oracle)', async () => {
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
        error: 'RECOVERY_TOKEN_INVALID',
        message: expect.stringContaining('no longer valid'),
      },
    });
    // Replay attempt is a NotFoundException (HTTP 404), matching every
    // other invalid-token failure mode. Specifically NOT UnauthorizedException.
    await expect(
      (async () => {
        setVerifyReturn(claims);
        await svc.verifyToken(SHARE_TOKEN, 'opaque-token-1-replay-2');
      })(),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('two distinct jtis are independent — each is single-use on its own', async () => {
    const { svc } = makeService();

    const claimsA = baseClaims({ jti: 'jti-A' });
    const claimsB = baseClaims({ jti: 'jti-B' });

    setVerifyReturn(claimsA);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tA')).resolves.toBeDefined();
    setVerifyReturn(claimsB);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tB')).resolves.toBeDefined();

    // Each replays independently. A276-F5-P1-2: uniform 404 + INVALID shape.
    setVerifyReturn(claimsA);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tA2')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    setVerifyReturn(claimsB);
    await expect(svc.verifyToken(SHARE_TOKEN, 'tB2')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
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

  it('Redis SET NX throw → verifyToken FAILS CLOSED with uniform RECOVERY_TOKEN_INVALID (no enumeration oracle)', async () => {
    const { svc } = makeService();
    // Force the Redis branch by injecting a stub client whose .set throws.
    const brokenRedis = {
      set: jest.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      }),
    };
    (svc as any).redis = brokenRedis;

    setVerifyReturn(baseClaims({ jti: 'jti-fail-closed' }));
    // A276-F5-P1-2: fail-closed must return the SAME 404 + INVALID shape as
    // every other failure leg so a Redis outage doesn't leak which link the
    // attacker is probing.
    await expect(
      svc.verifyToken(SHARE_TOKEN, 'fail-closed-token'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      (async () => {
        setVerifyReturn(baseClaims({ jti: 'jti-fail-closed' }));
        await svc.verifyToken(SHARE_TOKEN, 'fail-closed-token-2');
      })(),
    ).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    expect(brokenRedis.set).toHaveBeenCalled();
  });

  it('Redis SET NX returns null (key existed) → throws uniform RECOVERY_TOKEN_INVALID 404 (no enumeration oracle)', async () => {
    const { svc } = makeService();
    const redisStub = {
      set: jest.fn(async () => null),
    };
    (svc as any).redis = redisStub;

    setVerifyReturn(baseClaims({ jti: 'jti-already-claimed' }));
    // A276-F5-P1-2: replay collision returns the SAME shape as a tampered
    // signature or an unknown checkout. The 401/USED leak is gone.
    await expect(svc.verifyToken(SHARE_TOKEN, 'tok')).rejects.toMatchObject({
      response: {
        error: 'RECOVERY_TOKEN_INVALID',
        message: expect.stringContaining('no longer valid'),
      },
    });
    await expect(
      (async () => {
        setVerifyReturn(baseClaims({ jti: 'jti-already-claimed-2' }));
        const redisStub2 = { set: jest.fn(async () => null) };
        (svc as any).redis = redisStub2;
        await svc.verifyToken(SHARE_TOKEN, 'tok2');
      })(),
    ).rejects.toBeInstanceOf(NotFoundException);
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

  it('in-memory fallback (no REDIS_URL) still enforces single-use within the process with uniform RECOVERY_TOKEN_INVALID', async () => {
    const { svc } = makeService();
    // redis is null by construction (onModuleInit not called)
    expect((svc as any).redis).toBeNull();

    const claims = baseClaims({ jti: 'jti-mem' });
    setVerifyReturn(claims);
    await expect(svc.verifyToken(SHARE_TOKEN, 't1')).resolves.toBeDefined();
    // A276-F5-P1-2: in-memory replay must also return the uniform shape.
    setVerifyReturn(claims);
    await expect(svc.verifyToken(SHARE_TOKEN, 't1-replay')).rejects.toMatchObject({
      response: { error: 'RECOVERY_TOKEN_INVALID' },
    });
    setVerifyReturn(claims);
    await expect(svc.verifyToken(SHARE_TOKEN, 't1-replay-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
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

// A276-F5-P1-2 — explicit enumeration-resistance contract test.
// The class doc on verifyToken promises: "never leaks which leg failed."
// This describe block pins every distinct failure leg to the SAME wire
// response (HTTP 404, error=RECOVERY_TOKEN_INVALID, message=...) so a
// future change that re-introduces a 401 oracle (or a per-reason error
// code) fails this test.
describe('CheckoutRecoveryService.verifyToken — enumeration resistance (A276-F5-P1-2)', () => {
  const EXPECTED_SHAPE = {
    error: 'RECOVERY_TOKEN_INVALID',
    message: 'This recovery link is no longer valid.',
  };

  async function captureResponse(p: Promise<unknown>): Promise<{
    name: string;
    status: number | undefined;
    response: unknown;
  }> {
    try {
      await p;
      throw new Error('expected verifyToken to throw, it resolved');
    } catch (e) {
      const err = e as { name?: string; getStatus?: () => number; response?: unknown };
      return {
        name: err.name ?? 'unknown',
        status: typeof err.getStatus === 'function' ? err.getStatus() : undefined,
        response: err.response,
      };
    }
  }

  beforeEach(() => mockJwtVerify.mockReset());

  it('every failure leg returns the same HTTP 404 + RECOVERY_TOKEN_INVALID wire shape', async () => {
    // Leg 1: jwtVerify throws (bad signature / malformed / expired).
    {
      const { svc } = makeService();
      mockJwtVerify.mockRejectedValueOnce(new Error('bad signature'));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tampered'));
      expect(r.name).toBe('NotFoundException');
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 2: wrong type claim.
    {
      const { svc } = makeService();
      setVerifyReturn(baseClaims({ type: 'something_else' }));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 3: share_token mismatch.
    {
      const { svc } = makeService();
      setVerifyReturn(baseClaims({ st: 'wrong-share' }));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 4: missing jti.
    {
      const { svc } = makeService();
      const c = baseClaims();
      delete (c as Record<string, unknown>).jti;
      setVerifyReturn(c);
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 5: GuestCheckout row missing.
    {
      const { svc } = makeService({ prismaRow: null });
      setVerifyReturn(baseClaims({ jti: 'leg5' }));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 6: GuestCheckout row expired.
    {
      const { svc } = makeService({
        prismaRow: {
          id: GID,
          guest_email: EMAIL,
          expires_at: new Date(Date.now() - 60_000),
        },
      });
      setVerifyReturn(baseClaims({ jti: 'leg6' }));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 7: replay collision (Redis SET NX returns null) — previously
    // leaked as 401 + RECOVERY_TOKEN_USED. Now uniform.
    {
      const { svc } = makeService();
      (svc as any).redis = { set: jest.fn(async () => null) };
      setVerifyReturn(baseClaims({ jti: 'leg7' }));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.name).toBe('NotFoundException');
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 8: Redis fail-closed (SET NX throws) — previously leaked
    // as 401 + RECOVERY_TOKEN_USED. Now uniform.
    {
      const { svc } = makeService();
      (svc as any).redis = {
        set: jest.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      };
      setVerifyReturn(baseClaims({ jti: 'leg8' }));
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'tok'));
      expect(r.name).toBe('NotFoundException');
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
    // Leg 9: in-memory replay collision (no REDIS_URL path) — previously
    // leaked as 401 + RECOVERY_TOKEN_USED. Now uniform.
    {
      const { svc } = makeService();
      const c = baseClaims({ jti: 'leg9' });
      setVerifyReturn(c);
      await svc.verifyToken(SHARE_TOKEN, 'first'); // consumes
      setVerifyReturn(c);
      const r = await captureResponse(svc.verifyToken(SHARE_TOKEN, 'replay'));
      expect(r.name).toBe('NotFoundException');
      expect(r.status).toBe(404);
      expect(r.response).toMatchObject(EXPECTED_SHAPE);
    }
  });

  it('no failure leg throws UnauthorizedException or returns RECOVERY_TOKEN_USED', async () => {
    // Belt-and-suspenders: explicitly assert the *old* leaky shapes never
    // come back. If a future refactor re-introduces 401/USED on either
    // the replay or fail-closed branch, this test fails loudly.
    const legs: Array<() => Promise<unknown>> = [
      // Replay collision via Redis null return.
      async () => {
        const { svc } = makeService();
        (svc as any).redis = { set: jest.fn(async () => null) };
        setVerifyReturn(baseClaims({ jti: 'nl1' }));
        return svc.verifyToken(SHARE_TOKEN, 'tok');
      },
      // Fail-closed via Redis throw.
      async () => {
        const { svc } = makeService();
        (svc as any).redis = {
          set: jest.fn(async () => {
            throw new Error('boom');
          }),
        };
        setVerifyReturn(baseClaims({ jti: 'nl2' }));
        return svc.verifyToken(SHARE_TOKEN, 'tok');
      },
      // In-memory replay.
      async () => {
        const { svc } = makeService();
        const c = baseClaims({ jti: 'nl3' });
        setVerifyReturn(c);
        await svc.verifyToken(SHARE_TOKEN, 'first');
        setVerifyReturn(c);
        return svc.verifyToken(SHARE_TOKEN, 'replay');
      },
    ];

    for (const leg of legs) {
      const r = await captureResponse(leg());
      expect(r.name).not.toBe('UnauthorizedException');
      expect(r.status).not.toBe(401);
      expect(r.response).not.toMatchObject({ error: 'RECOVERY_TOKEN_USED' });
      expect(r.response).toMatchObject({ error: 'RECOVERY_TOKEN_INVALID' });
    }
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

  // A276-F5-P2-1 — default-secure NODE_ENV. An operator who forgets to set
  // NODE_ENV in prod (Fly machine re-imaged, fly.toml env block deleted,
  // ConfigService not loading .env) used to silently fall through to the
  // 'development' default and boot into in-memory mode — re-opening the
  // cross-machine-replay window P1-1 was designed to close. Default-secure
  // pattern: treat unset/undefined NODE_ENV as production (fail-closed).
  it('NODE_ENV unset + REDIS_URL unset → onModuleInit THROWS (default-secure: treat unknown env as prod)', async () => {
    // jest runs with NODE_ENV=test by default; scrub both the config value
    // and the process env fallback so the service sees a truly unset env.
    delete process.env.NODE_ENV;
    const svc = makeServiceForBoot({ nodeEnv: undefined, redisUrl: undefined });
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required/);
    expect((svc as any).redis).toBeNull();
  });

  it('NODE_ENV unset + REDIS_URL set but unreachable → onModuleInit THROWS (default-secure)', async () => {
    let CRS!: typeof CheckoutRecoveryService;
    jest.isolateModules(() => {
      jest.doMock('ioredis', () => {
        class FakeRedis {
          async connect() {
            throw new Error('ECONNREFUSED unset-env');
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
        if (k === 'NODE_ENV') return undefined;
        return undefined;
      }),
    } as unknown as ConfigService;
    // Also scrub process.env so the fallback path can't pick a value up.
    delete process.env.NODE_ENV;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    const svc = new CRS(prisma, config);
    await expect(svc.onModuleInit()).rejects.toThrow(/ECONNREFUSED/);
    expect((svc as any).redis).toBeNull();
  });

  // A276-F5-P2-2 — staging mirrors prod topology (multi-machine behind
  // a load balancer). The original strict `=== 'production'` check
  // dropped staging to in-memory and left the same cross-machine-replay
  // window exposed. Staging is now in the fail-closed set.
  it('NODE_ENV=staging + REDIS_URL unset → onModuleInit THROWS (staging is multi-machine → fail-closed)', async () => {
    const svc = makeServiceForBoot({ nodeEnv: 'staging', redisUrl: undefined });
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required in staging/);
    expect((svc as any).redis).toBeNull();
  });

  it('NODE_ENV=staging + REDIS_URL set but unreachable → onModuleInit THROWS (staging fail-closed)', async () => {
    let CRS!: typeof CheckoutRecoveryService;
    jest.isolateModules(() => {
      jest.doMock('ioredis', () => {
        class FakeRedis {
          async connect() {
            throw new Error('ECONNREFUSED staging');
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
        if (k === 'NODE_ENV') return 'staging';
        return undefined;
      }),
    } as unknown as ConfigService;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    const svc = new CRS(prisma, config);
    await expect(svc.onModuleInit()).rejects.toThrow(/ECONNREFUSED/);
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

// A276-F5-P3-3 — NODE_ENV trim/case normalization. ' production' (whitespace
// from a docker-compose interpolation gotcha) and 'Production' (case) used
// to silently demote prod to in-memory mode because the strict equality
// failed. .trim().toLowerCase() hardens both.
describe('CheckoutRecoveryService.onModuleInit — NODE_ENV normalization (A276-F5-P3-3)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.resetModules();
  });

  function bootSvc(nodeEnv: string | undefined) {
    const config = {
      get: jest.fn((k: string) => {
        if (k === 'CHECKOUT_RECOVERY_SECRET') return VALID_SECRET;
        if (k === 'REDIS_URL') return undefined;
        if (k === 'NODE_ENV') return nodeEnv;
        return undefined;
      }),
    } as unknown as ConfigService;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    return new CheckoutRecoveryService(prisma, config);
  }

  it("NODE_ENV=' production' (leading space) → normalized + treated as prod → THROWS", async () => {
    const svc = bootSvc(' production');
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required in production/);
  });

  it("NODE_ENV='Production' (mixed case) → normalized + treated as prod → THROWS", async () => {
    const svc = bootSvc('Production');
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required in production/);
  });

  it("NODE_ENV=' STAGING ' (case + whitespace) → normalized to 'staging' → THROWS", async () => {
    const svc = bootSvc(' STAGING ');
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required in staging/);
  });

  it("NODE_ENV='   ' (whitespace only) → normalizes to undefined → treated as prod (default-secure) → THROWS", async () => {
    const svc = bootSvc('   ');
    await expect(svc.onModuleInit()).rejects.toThrow(/REDIS_URL is required/);
  });

  it("NODE_ENV='DEVELOPMENT' (case) → normalized to 'development' → RESOLVES (fallback)", async () => {
    const svc = bootSvc('DEVELOPMENT');
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect((svc as any).redis).toBeNull();
  });
});

// A276-F5-P3-1 — onModuleDestroy releases the Redis client cleanly. Without
// this, the client lives until process exit, leaking the connection across
// hot reloads and graceful restarts.
describe('CheckoutRecoveryService.onModuleDestroy — disconnect cleanup (A276-F5-P3-1)', () => {
  function svcWithClient(client: unknown) {
    const config = {
      get: jest.fn((k: string) => (k === 'CHECKOUT_RECOVERY_SECRET' ? VALID_SECRET : undefined)),
    } as unknown as ConfigService;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    const svc = new CheckoutRecoveryService(prisma, config);
    (svc as any).redis = client;
    return svc;
  }

  it('calls client.quit() and nulls out the client (graceful path)', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const disconnect = jest.fn();
    const svc = svcWithClient({ quit, disconnect });
    await svc.onModuleDestroy();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect((svc as any).redis).toBeNull();
  });

  it('falls back to client.disconnect() when quit() rejects (force path)', async () => {
    const quit = jest.fn().mockRejectedValue(new Error('broker hung'));
    const disconnect = jest.fn();
    const svc = svcWithClient({ quit, disconnect });
    await svc.onModuleDestroy();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect((svc as any).redis).toBeNull();
  });

  it('falls back to client.disconnect() when quit() hangs past the 2s timeout', async () => {
    jest.useFakeTimers();
    const resolveQuitRef: { current: null | (() => void) } = { current: null };
    const quit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveQuitRef.current = resolve;
        }),
    );
    const disconnect = jest.fn();
    const svc = svcWithClient({ quit, disconnect });
    const destroyPromise = svc.onModuleDestroy();
    // Fast-forward past the 2s timeout floor.
    jest.advanceTimersByTime(2_001);
    // Yield to allow the timeout's reject to resolve the Promise.race.
    await Promise.resolve();
    await Promise.resolve();
    jest.useRealTimers();
    // Clean up the dangling quit() so the destroyPromise can settle.
    if (resolveQuitRef.current) resolveQuitRef.current();
    await destroyPromise;
    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect((svc as any).redis).toBeNull();
  });

  it('no-ops when no Redis client is attached (in-memory mode)', async () => {
    const svc = svcWithClient(null);
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    expect((svc as any).redis).toBeNull();
  });
});

// A276-F5-P3-4 — resetForTests() is now guarded by a runtime check so a
// misuse in prod (or even dev) code can't wipe the in-memory single-use set.
describe('CheckoutRecoveryService.resetForTests — runtime guard (A276-F5-P3-4)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  function bareSvc() {
    const config = {
      get: jest.fn((k: string) => (k === 'CHECKOUT_RECOVERY_SECRET' ? VALID_SECRET : undefined)),
    } as unknown as ConfigService;
    const prisma = { guestCheckout: { findUnique: jest.fn() } } as any;
    return new CheckoutRecoveryService(prisma, config);
  }

  it("NODE_ENV='test' → resetForTests() succeeds and clears the in-memory set", () => {
    process.env.NODE_ENV = 'test';
    const svc = bareSvc();
    (svc as any).memory.set('co:rec:jti:abc', Date.now() + 60_000);
    expect((svc as any).memory.size).toBe(1);
    expect(() => svc.resetForTests()).not.toThrow();
    expect((svc as any).memory.size).toBe(0);
  });

  it("NODE_ENV='production' → resetForTests() THROWS (would wipe single-use state)", () => {
    process.env.NODE_ENV = 'production';
    const svc = bareSvc();
    (svc as any).memory.set('co:rec:jti:abc', Date.now() + 60_000);
    expect(() => svc.resetForTests()).toThrow(/outside the test environment/);
    expect((svc as any).memory.size).toBe(1); // state untouched
  });

  it("NODE_ENV='development' → resetForTests() THROWS (only explicit 'test' unlocks)", () => {
    process.env.NODE_ENV = 'development';
    const svc = bareSvc();
    expect(() => svc.resetForTests()).toThrow(/outside the test environment/);
  });

  it('NODE_ENV unset → resetForTests() THROWS (default-secure)', () => {
    delete process.env.NODE_ENV;
    const svc = bareSvc();
    expect(() => svc.resetForTests()).toThrow(/outside the test environment/);
  });

  it("NODE_ENV=' TEST ' (case + whitespace) → normalized → resetForTests() succeeds", () => {
    process.env.NODE_ENV = ' TEST ';
    const svc = bareSvc();
    expect(() => svc.resetForTests()).not.toThrow();
  });
});
