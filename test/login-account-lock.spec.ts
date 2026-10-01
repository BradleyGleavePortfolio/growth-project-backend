// C14 fix round — login throttling on the REAL storage paths.
//   Opus C14-A1 / Sol SOL-C14-A2: a successful sign-in never resets per-IP
//     counters, and never clears another account's failure counter.
//   Sol SOL-C14-B1 / Opus C14-B1: the per-account reset works through the
//     production wrapper withFailOpenStorage(redis) — exact keys deleted, no
//     extra hits — and the lock fails CLOSED when storage errors.
//   Sol SOL-C14-A1: an unverified Bearer `sub` never selects a rate bucket.
//   #604 Opus final A1: /auth/extension/login shares the SAME per-account lock
//     and failure counter as /auth/login (one code path:
//     AuthService._passwordLogin → LoginThrottleResetService.guardPasswordLogin),
//     and declares the hourly per-IP brake.
// Real AuthController + real AuthService (Supabase client mocked for the
// password check only), real LoginThrottleResetService, real
// @nestjs/throttler in-memory storage and (in CI) the real @nest-lab Redis
// adapter on a live Redis.
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  Global,
  Logger,
  Module,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { LoginDto } from '../src/auth/auth.dto';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService, getStorageToken } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { AppleVerifierService } from '../src/auth/apple-verifier.service';
import { GoogleVerifierService } from '../src/auth/google-verifier.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditService } from '../src/audit/audit.service';
import {
  LoginThrottleResetService,
  accountFailureBucket,
  resolveAccountFailureLimit,
} from '../src/throttler/login-throttle-reset.service';
import { ThrottlerModule as TgpThrottlerModule } from '../src/throttler/throttler.module';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
  THROTTLER_ROUTE_LIMITS,
  withFailOpenStorage,
} from '../src/throttler/throttler.config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import { LIVE_REDIS_URL, describeLiveRedis, liveRedisClient } from './support/live-redis';

// The ONLY mocked boundary: Supabase's password check. Everything between the
// controller and that call (lock check, failure count, own-account clear) is
// the real code. `mockPasswords` / `mockSignIns` are read lazily by the
// hoisted factory (jest allows `mock*` names there).
const mockPasswords: Record<string, string> = {
  'victim@example.test': 'right-v',
  'attacker@example.test': 'right-a',
};
const mockSignIns: { count: number } = { count: 0 };
jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          mockSignIns.count += 1;
          if (mockPasswords[email] !== undefined && mockPasswords[email] === password) {
            return {
              data: { session: { access_token: `tok-${email}`, refresh_token: `rt-${email}` } },
              error: null,
            };
          }
          return { data: { session: null, user: null }, error: { message: 'Invalid login credentials' } };
        },
      },
    })),
  };
});

const quietLogger: Pick<Logger, 'warn'> = { warn: () => undefined };
const PASSWORDS = mockPasswords;

// Narrow helper (R75-clean): partial doubles slot into the real constructors.
const cast = <T>(value: unknown): T => value as T;

function prismaDouble() {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string } }) =>
        where.email && PASSWORDS[where.email] !== undefined
          ? {
              id: `u-${where.email}`,
              email: where.email,
              name: 'N',
              role: 'student',
              coach_id: null,
              profile: null,
            }
          : null,
      ),
    },
  };
}
const auditDouble = () => ({ write: jest.fn(async () => undefined) });

function buildAuthService(reset: LoginThrottleResetService): AuthService {
  return new AuthService(
    cast(prismaDouble()),
    cast({}),
    cast({ capture: jest.fn(), identify: jest.fn() }),
    cast(auditDouble()),
    cast({}),
    cast({}),
    reset,
  );
}

type Outcome = 'ok' | '401' | '429' | '503';
async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof UnauthorizedException) return '401';
    if (err instanceof ThrottlerException) return '429';
    if (err instanceof ServiceUnavailableException) return '503';
    throw err;
  }
}

function buildController(storage: ThrottlerStorage | undefined) {
  const reset = new LoginThrottleResetService(storage);
  const authService = buildAuthService(reset);
  const controller = new AuthController(authService, cast<InviteCodesService>({}), reset);
  const req = cast<Parameters<AuthController['login']>[1]>({
    headers: { 'fly-client-ip': '198.51.100.7' },
    ip: '198.51.100.7',
  });
  const dto = (email: string, password: string): LoginDto => ({ email, password });
  const login = (email: string, password: string) =>
    outcome(() => controller.login(dto(email, password), req));
  const extensionLogin = (email: string, password: string) =>
    outcome(() => controller.extensionLogin(dto(email, password), req));
  return { login, extensionLogin, controller };
}

beforeEach(() => {
  mockSignIns.count = 0;
});

function lockSuite(name: string, makeStorage: () => { storage: ThrottlerStorage; teardown: () => Promise<void> | void }) {
  describe(name, () => {
    let storage: ThrottlerStorage;
    let teardown: () => Promise<void> | void;
    const limit = resolveAccountFailureLimit();
    // Unique emails per run so a shared live Redis never carries state between runs.
    const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // Fresh identities per test: a live Redis keeps state between tests.
    let seq = 0;
    let victim = '';
    let attacker = '';
    beforeEach(() => {
      ({ storage, teardown } = makeStorage());
      seq += 1;
      victim = `victim-${run}-${seq}@example.test`;
      attacker = `attacker-${run}-${seq}@example.test`;
      PASSWORDS[victim] = 'right-v';
      PASSWORDS[attacker] = 'right-a';
    });
    afterEach(async () => {
      await teardown();
    });

    it(`locks an account after ${limit} failures — even the right password is then refused`, async () => {
      const { login } = buildController(storage);
      for (let i = 0; i < limit; i += 1) expect(await login(victim, `guess-${i}`)).toBe('401');
      expect(await login(victim, 'guess-x')).toBe('429');
      expect(await login(victim, 'right-v')).toBe('429');
      // The locked attempts never reached the password check.
      expect(mockSignIns.count).toBe(limit);
    });

    // ---- #604 Opus final A1: /auth/extension/login shares the lock ----------

    it(`A1: ${limit} failed EXTENSION logins lock the account on both /auth/extension/login and /auth/login`, async () => {
      const { login, extensionLogin } = buildController(storage);
      for (let i = 0; i < limit; i += 1) expect(await extensionLogin(victim, `guess-${i}`)).toBe('401');
      // Locked: the right password is refused on BOTH password endpoints…
      expect(await extensionLogin(victim, 'right-v')).toBe('429');
      expect(await login(victim, 'right-v')).toBe('429');
      // …and neither locked attempt reached the password check.
      expect(mockSignIns.count).toBe(limit);
      // Another account is unaffected.
      expect(await extensionLogin(attacker, 'right-a')).toBe('ok');
    });

    it('A1: a locked account (via /auth/login failures) is refused on /auth/extension/login', async () => {
      const { login, extensionLogin } = buildController(storage);
      for (let i = 0; i < limit; i += 1) expect(await login(victim, `guess-${i}`)).toBe('401');
      expect(await extensionLogin(victim, 'right-v')).toBe('429');
      expect(mockSignIns.count).toBe(limit);
    });

    it('A1: failed attempts on either endpoint increment ONE per-account counter', async () => {
      const { login, extensionLogin } = buildController(storage);
      // limit-1 failures split across the two endpoints: not locked yet.
      for (let i = 0; i < limit - 1; i += 1) {
        const attempt = i % 2 === 0 ? extensionLogin : login;
        expect(await attempt(victim, `guess-${i}`)).toBe('401');
      }
      // The limit-th failure (on extension) is the one that locks.
      expect(await extensionLogin(victim, 'guess-last')).toBe('401');
      expect(await login(victim, 'right-v')).toBe('429');
      expect(await extensionLogin(victim, 'right-v')).toBe('429');
    });

    it("A1: an extension success resets only that account's own counter", async () => {
      const { login, extensionLogin } = buildController(storage);
      for (let i = 0; i < limit - 1; i += 1) expect(await extensionLogin(victim, `g-${i}`)).toBe('401');
      for (let i = 0; i < limit - 1; i += 1) expect(await extensionLogin(attacker, `g-${i}`)).toBe('401');
      // Victim's own extension success clears the victim's counter…
      expect(await extensionLogin(victim, 'right-v')).toBe('ok');
      for (let i = 0; i < limit - 1; i += 1) expect(await login(victim, `h-${i}`)).toBe('401');
      expect(await login(victim, 'right-v')).toBe('ok');
      // …and the attacker's near-full counter is untouched by it.
      expect(await extensionLogin(attacker, 'g-last')).toBe('401');
      expect(await extensionLogin(attacker, 'right-a')).toBe('429');
    });

    it("A1: alternating an attacker's own extension successes never resets the victim's budget", async () => {
      const { login, extensionLogin } = buildController(storage);
      for (let round = 0; round < limit; round += 1) {
        expect(await extensionLogin(victim, `guess-${round}`)).toBe('401');
        expect(await login(attacker, 'right-a')).toBe('ok');
        expect(await extensionLogin(attacker, 'right-a')).toBe('ok');
      }
      expect(await login(victim, 'guess-final')).toBe('429');
      expect(await extensionLogin(victim, 'right-v')).toBe('429');
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
    const { login, extensionLogin } = buildController(withFailOpenStorage(broken, { logger: quietLogger }));
    expect(await login('victim@example.test', 'right-v')).toBe('503');
    expect(await extensionLogin('victim@example.test', 'right-v')).toBe('503');
    expect(mockSignIns.count).toBe(0);
  });

  it('an unknown backend (no typed ops) also fails closed', async () => {
    const opaque: ThrottlerStorage = { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) };
    const { login, extensionLogin } = buildController(opaque);
    expect(await login('victim@example.test', 'right-v')).toBe('503');
    expect(await extensionLogin('victim@example.test', 'right-v')).toBe('503');
  });
});

// #604 Opus final A1 — structural pins so a password endpoint cannot ship
// without the lock, or lose its hourly per-IP brake.
describe('A1: every password sign-in path is covered by the per-account lock', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('/auth/extension/login declares auth-login-per-min AND auth-login-per-hour', () => {
    const handler = AuthController.prototype.extensionLogin;
    const meta = (key: string) => Reflect.getMetadata(key, handler) as number | undefined;
    expect(meta(`THROTTLER:LIMIT${THROTTLER_NAMES.AUTH_LOGIN_PER_MIN}`)).toBe(5);
    expect(meta(`THROTTLER:LIMIT${THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR}`)).toBe(
      THROTTLER_ROUTE_LIMITS.AUTH_LOGIN_PER_HOUR,
    );
    expect(meta(`THROTTLER:TTL${THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR}`)).toBe(3_600_000);
  });

  it('the guard applies the hourly brake on extension/login (isolation rule)', () => {
    const guard = new UserThrottlerGuard(
      { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) },
      new ThrottlerStorageService(),
      new Reflector(),
    );
    const ctx = cast<Parameters<UserThrottlerGuard['routeDeclaresThrottler']>[0]>({
      getHandler: () => AuthController.prototype.extensionLogin,
      getClass: () => AuthController,
    });
    expect(guard.routeDeclaresThrottler(ctx, THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR)).toBe(true);
    expect(guard.routeDeclaresThrottler(ctx, THROTTLER_NAMES.AUTH_LOGIN_PER_MIN)).toBe(true);
  });

  it('signInWithPassword for sign-in is reachable only through the locked _passwordLogin', () => {
    const service = src('src/auth/auth.service.ts');
    // The unlocked body is called from exactly one place: inside _passwordLogin,
    // wrapped by guardPasswordLogin.
    const unlockedCalls = service.match(/this\._passwordLoginUnlocked\(/g) ?? [];
    expect(unlockedCalls).toHaveLength(1);
    const wrapper = service.slice(
      service.indexOf('private async _passwordLogin('),
      service.indexOf('private async _passwordLoginUnlocked('),
    );
    expect(wrapper).toContain('guardPasswordLogin(email, attempt)');
    expect(wrapper).toContain('this._passwordLoginUnlocked(');
    // Every sign-in caller goes through _passwordLogin.
    const callers = service.match(/this\._passwordLogin\(/g) ?? [];
    expect(callers).toHaveLength(2); // login + extensionLogin
  });

  it('the controller does not count failures itself (no double counting, no second copy of the flow)', () => {
    const controller = src('src/auth/auth.controller.ts');
    for (const op of ['assertAccountNotLocked', 'recordAccountFailure', 'clearAccountFailures']) {
      expect([op, controller.includes(op)]).toEqual([op, false]);
    }
  });

  it('Nest DI wires LoginThrottleResetService into AuthService (the @Optional is never undefined in the module)', async () => {
    const storage = new ThrottlerStorageService();
    memStores.push(storage);
    @Global()
    @Module({ providers: [{ provide: getStorageToken(), useValue: storage }], exports: [getStorageToken()] })
    class StorageStub {}
    const moduleRef = await Test.createTestingModule({
      imports: [StorageStub, TgpThrottlerModule],
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaDouble() },
        { provide: InviteCodesService, useValue: {} },
        { provide: AnalyticsService, useValue: { capture: jest.fn(), identify: jest.fn() } },
        { provide: AuditService, useValue: auditDouble() },
        { provide: AppleVerifierService, useValue: {} },
        { provide: GoogleVerifierService, useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(AuthService);
    expect(Reflect.get(service, 'loginThrottle')).toBe(moduleRef.get(LoginThrottleResetService));
    // End to end through DI: the extension endpoint locks.
    const controller = moduleRef.get(AuthController);
    const req = cast<Parameters<AuthController['login']>[1]>({ headers: {}, ip: '198.51.100.9' });
    const email = `di-${Date.now()}@example.test`;
    PASSWORDS[email] = 'pw';
    for (let i = 0; i < resolveAccountFailureLimit(); i += 1) {
      expect(await outcome(() => controller.extensionLogin({ email, password: 'nope' }, req))).toBe('401');
    }
    expect(await outcome(() => controller.extensionLogin({ email, password: 'pw' }, req))).toBe('429');
    expect(await outcome(() => controller.login({ email, password: 'pw' }, req))).toBe('429');
    await moduleRef.close();
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
