// C14 fix round — login throttling on the REAL storage paths.
//   Opus C14-A1 / Sol SOL-C14-A2: a successful sign-in never resets per-IP
//     counters, and never clears another account's failure counter.
//   Sol SOL-C14-B1 / Opus C14-B1: the per-account reset works through the
//     production wrapper withFailOpenStorage(redis) — exact keys deleted, no
//     extra hits — and the lock fails CLOSED when storage errors.
//   Sol SOL-C14-A1: an unverified Bearer `sub` never selects a rate bucket.
// Real AuthController.login (AuthService double only for the password check),
// real LoginThrottleResetService, real @nestjs/throttler in-memory storage and
// (in CI) the real @nest-lab Redis adapter on a live Redis.
import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { LoginDto } from '../src/auth/auth.dto';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AuthController } from '../src/auth/auth.controller';
import {
  LoginThrottleResetService,
  accountFailureBucket,
  resolveAccountFailureLimit,
} from '../src/throttler/login-throttle-reset.service';
import { THROTTLER_LIMITS, withFailOpenStorage } from '../src/throttler/throttler.config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import { LIVE_REDIS_URL, describeLiveRedis, liveRedisClient } from './support/live-redis';

const quietLogger: Pick<Logger, 'warn'> = { warn: () => undefined };
const PASSWORDS: Record<string, string> = { 'victim@example.test': 'right-v', 'attacker@example.test': 'right-a' };

function buildController(storage: ThrottlerStorage | undefined) {
  const authService = {
    login: jest.fn(async (email: string, password: string) => {
      if (PASSWORDS[email] !== password) throw new UnauthorizedException('Invalid credentials');
      return { access_token: `tok-${email}` };
    }),
  };
  const reset = new LoginThrottleResetService(storage);
  // @ts-expect-error partial structural doubles — only login is exercised
  const controller = new AuthController(authService, {}, reset);
  const req = { headers: { 'fly-client-ip': '198.51.100.7' }, ip: '198.51.100.7' };
  const login = async (email: string, password: string): Promise<'ok' | '401' | '429' | '503'> => {
    try {
      const dto: LoginDto = { email, password };
      await controller.login(dto, req);
      return 'ok';
    } catch (err) {
      if (err instanceof UnauthorizedException) return '401';
      if (err instanceof ThrottlerException) return '429';
      if (err instanceof ServiceUnavailableException) return '503';
      throw err;
    }
  };
  return { login, authService };
}

function lockSuite(name: string, makeStorage: () => { storage: ThrottlerStorage; teardown: () => Promise<void> | void }) {
  describe(name, () => {
    let storage: ThrottlerStorage;
    let teardown: () => Promise<void> | void;
    const limit = resolveAccountFailureLimit();
    // Unique emails per run so a shared live Redis never carries state between runs.
    const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    beforeEach(() => {
      ({ storage, teardown } = makeStorage());
      PASSWORDS[`victim-${run}@example.test`] = 'right-v';
      PASSWORDS[`attacker-${run}@example.test`] = 'right-a';
    });
    afterEach(async () => {
      await teardown();
    });
    const victim = `victim-${run}@example.test`;
    const attacker = `attacker-${run}@example.test`;

    it(`locks an account after ${limit} failures — even the right password is then refused`, async () => {
      const { login, authService } = buildController(storage);
      for (let i = 0; i < limit; i += 1) expect(await login(victim, `guess-${i}`)).toBe('401');
      expect(await login(victim, 'guess-x')).toBe('429');
      expect(await login(victim, 'right-v')).toBe('429');
      // The locked attempts never reached the password check.
      expect(authService.login).toHaveBeenCalledTimes(limit);
    });

    it("alternating victim guesses with the attacker's OWN successful sign-ins never resets the victim's budget", async () => {
      const { login } = buildController(storage);
      let victimAttempts = 0;
      for (let round = 0; round < limit; round += 1) {
        expect(await login(victim, `guess-${round}`)).toBe('401');
        victimAttempts += 1;
        expect(await login(attacker, 'right-a')).toBe('ok');
      }
      expect(victimAttempts).toBe(limit);
      expect(await login(victim, 'guess-final')).toBe('429');
    });

    it("the account's own success clears only its own counter", async () => {
      const { login } = buildController(storage);
      for (let i = 0; i < limit - 1; i += 1) expect(await login(victim, `g-${i}`)).toBe('401');
      for (let i = 0; i < limit - 1; i += 1) expect(await login(attacker, `g-${i}`)).toBe('401');
      expect(await login(victim, 'right-v')).toBe('ok');
      // victim starts fresh…
      for (let i = 0; i < limit - 1; i += 1) expect(await login(victim, `h-${i}`)).toBe('401');
      expect(await login(victim, 'right-v')).toBe('ok');
      // …the attacker's own near-full counter was untouched by the victim's success.
      expect(await login(attacker, 'g-last')).toBe('401');
      expect(await login(attacker, 'right-a')).toBe('429');
    });
  });
}

const memStores: ThrottlerStorageService[] = [];
afterAll(() => memStores.forEach((s) => s.onApplicationShutdown()));

lockSuite('per-account lock — real in-memory adapter', () => {
  const s = new ThrottlerStorageService();
  memStores.push(s);
  return { storage: s, teardown: () => undefined };
});

lockSuite('per-account lock — real in-memory adapter behind the production wrapper', () => {
  const s = new ThrottlerStorageService();
  memStores.push(s);
  return { storage: withFailOpenStorage(s, { logger: quietLogger }), teardown: () => undefined };
});

describe('fail closed', () => {
  it('a storage error on the lock check is 503, never an unthrottled password check', async () => {
    const broken: ThrottlerStorage = {
      increment: async () => {
        throw new Error('redis down');
      },
    };
    // Through the production wrapper: its fail-OPEN increment must not be what the lock uses.
    const { login, authService } = buildController(withFailOpenStorage(broken, { logger: quietLogger }));
    expect(await login('victim@example.test', 'right-v')).toBe('503');
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('an unknown backend (no typed ops) also fails closed', async () => {
    const opaque: ThrottlerStorage = { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) };
    const { login } = buildController(opaque);
    expect(await login('victim@example.test', 'right-v')).toBe('503');
  });
});

// Opus C14 probe, as a regression: on the production shape the success path
// must clear exactly the account's keys and add NO hits anywhere.
class FakeRedisAdapter {
  hits = new Map<string, number>();
  blocked = new Set<string>();
  redis = {
    exists: async (...keys: string[]) => keys.filter((k) => this.blocked.has(k)).length,
    del: async (...keys: string[]) => {
      keys.forEach((k) => {
        this.hits.delete(k);
        this.blocked.delete(k);
      });
      return keys.length;
    },
  };
  async increment(key: string, ttl: number, limit: number, blockDuration: number, name: string) {
    const hitKey = `{${key}:${name}}:hits`;
    const blockKey = `{${key}:${name}}:blocked`;
    const total = (this.hits.get(hitKey) ?? 0) + 1;
    this.hits.set(hitKey, total);
    let isBlocked = this.blocked.has(blockKey);
    if (!isBlocked && total > limit) {
      if (blockDuration <= 0) throw new Error("ERR invalid expire time in 'set' command");
      this.blocked.add(blockKey);
      isBlocked = true;
    }
    return { totalHits: total, timeToExpire: Math.ceil(ttl / 1000), isBlocked, timeToBlockExpire: 0 };
  }
}

describe('regression (Opus C14 probe): production wrapper over the Redis adapter shape', () => {
  it('success clears exactly the account keys and adds no hits', async () => {
    const redis = new FakeRedisAdapter();
    const prod = withFailOpenStorage(redis, { logger: quietLogger });
    const { login } = buildController(prod);
    expect(await login('victim@example.test', 'wrong')).toBe('401');
    const { key, name } = accountFailureBucket('victim@example.test');
    expect(redis.hits.get(`{${key}:${name}}:hits`)).toBe(1);
    const before = new Map(redis.hits);
    expect(await login('victim@example.test', 'right-v')).toBe('ok');
    expect(redis.hits.has(`{${key}:${name}}:hits`)).toBe(false);
    // nothing else changed (no stray increments from a fallback "reset")
    for (const [k, v] of redis.hits) expect(before.get(k)).toBe(v);
  });
});

describeLiveRedis('per-account lock on live Redis behind withFailOpenStorage (production shape)', () => {
  const clients: ReturnType<typeof liveRedisClient>[] = [];
  const adapters: ThrottlerStorageRedisService[] = [];
  lockSuite('live', () => {
    const adapter = new ThrottlerStorageRedisService(LIVE_REDIS_URL);
    adapters.push(adapter);
    return { storage: withFailOpenStorage(adapter, { logger: quietLogger }), teardown: () => undefined };
  });
  afterAll(async () => {
    for (const c of clients) {
      const keys = await c.keys('*auth-login-account:*');
      if (keys.length) await c.del(...keys);
      c.disconnect();
    }
    for (const a of adapters) a.onModuleDestroy();
  });

  it('the block key exists in Redis while locked and is deleted by the account reset', async () => {
    const client = liveRedisClient();
    clients.push(client);
    const adapter = new ThrottlerStorageRedisService(LIVE_REDIS_URL);
    adapters.push(adapter);
    const storage = withFailOpenStorage(adapter, { logger: quietLogger });
    const email = `live-${Date.now()}@example.test`;
    PASSWORDS[email] = 'pw';
    const { login } = buildController(storage);
    for (let i = 0; i < resolveAccountFailureLimit() + 1; i += 1) await login(email, 'nope');
    const { key, name } = accountFailureBucket(email);
    expect(await client.exists(`{${key}:${name}}:blocked`)).toBe(1);
    expect(await client.pttl(`{${key}:${name}}:blocked`)).toBeGreaterThan(10 * 60_000);
    await new LoginThrottleResetService(storage).clearAccountFailures(email);
    expect(await client.exists(`{${key}:${name}}:blocked`, `{${key}:${name}}:hits`)).toBe(0);
  });
});

// Sol SOL-C14-A1 — tracker trust boundary on public auth routes.
describe('tracker: unverified Bearer subjects never pick a bucket', () => {
  class TrackerProbe extends UserThrottlerGuard {
    tracker(req: Record<string, unknown>): Promise<string> {
      return this.getTracker(req);
    }
  }
  const guard = new TrackerProbe({ throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) }, new ThrottlerStorageService(), new Reflector());
  const forged = (sub: string) =>
    `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
  const tracker = (headers: Record<string, string>, user?: { id: string }) =>
    guard.tracker({ headers: { 'fly-client-ip': '203.0.113.50', ...headers }, ip: '10.0.0.1', user });

  it.each([
    ['forged sub', { authorization: forged('fresh-1') }],
    ['another forged sub', { authorization: forged('fresh-2') }],
    ['malformed', { authorization: 'Bearer not.a.jwt' }],
    ['expired-looking', { authorization: forged('expired') }],
    ['none', {}],
  ])('%s → the trusted IP bucket', async (_l, headers) => {
    expect(await tracker(headers as Record<string, string>)).toBe('ip:203.0.113.50');
  });

  it('only a verified req.user (set by JwtAuthGuard) selects a user bucket', async () => {
    expect(await tracker({ authorization: forged('x') }, { id: 'u-verified' })).toBe('user:u-verified');
  });
});
