import { WearableProvider } from '@prisma/client';
import {
  OauthStateService,
  InMemoryOauthStateStore,
  RedisOauthStateStore,
  OAUTH_STATE_TTL_MS,
  OauthStateStore,
} from './oauth-state.service';
import { generateChallenge } from './pkce.util';

describe('OauthStateService', () => {
  let store: InMemoryOauthStateStore;
  let svc: OauthStateService;

  const USER = 'user-123';
  const PROVIDER = WearableProvider.OURA;
  const REDIRECT = 'https://app.example.com/oauth/callback';

  beforeEach(() => {
    store = new InMemoryOauthStateStore();
    svc = new OauthStateService(store);
  });

  describe('issue / consume round-trip', () => {
    it('round-trips the bound record and returns an opaque base64url state', async () => {
      const { state } = await svc.issue(USER, PROVIDER, REDIRECT);
      // 32 bytes base64url → 43 chars, URL-safe alphabet only.
      expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(state.length).toBe(43);

      const record = await svc.consume(state);
      expect(record.userId).toBe(USER);
      expect(record.provider).toBe(PROVIDER);
      expect(record.redirectUri).toBe(REDIRECT);
      expect(record.pkceVerifier).toBeUndefined();
    });

    it('mints distinct states across calls (no reuse)', async () => {
      const a = await svc.issue(USER, PROVIDER, REDIRECT);
      const b = await svc.issue(USER, PROVIDER, REDIRECT);
      expect(a.state).not.toBe(b.state);
    });

    it('throws when issued without a userId', async () => {
      await expect(svc.issue('', PROVIDER, REDIRECT)).rejects.toThrow(/userId/);
    });
  });

  describe('PKCE', () => {
    it('returns a challenge to the caller but keeps the verifier server-side', async () => {
      const issued = await svc.issue(USER, WearableProvider.FITBIT, REDIRECT, {
        pkce: true,
      });
      expect(issued.pkceChallenge).toBeTruthy();
      expect(issued.pkceMethod).toBe('S256');
      // The verifier is NOT part of the issue() result shape returned to client.
      expect((issued as unknown as Record<string, unknown>).pkceVerifier).toBeUndefined();
    });

    it('the consumed verifier derives the challenge that was issued (S256 link)', async () => {
      const issued = await svc.issue(USER, WearableProvider.FITBIT, REDIRECT, {
        pkce: true,
      });
      const record = await svc.consume(issued.state);
      expect(record.pkceVerifier).toBeDefined();
      expect(generateChallenge(record.pkceVerifier as string)).toBe(
        issued.pkceChallenge,
      );
    });

    it('omits PKCE fields when not requested', async () => {
      const issued = await svc.issue(USER, PROVIDER, REDIRECT);
      expect(issued.pkceChallenge).toBeUndefined();
      expect(issued.pkceMethod).toBeUndefined();
    });
  });

  describe('single-use enforcement (replay rejection)', () => {
    it('rejects a second consume of the same state', async () => {
      const { state } = await svc.issue(USER, PROVIDER, REDIRECT);
      await svc.consume(state); // first use OK
      await expect(svc.consume(state)).rejects.toThrow(
        /Invalid or expired OAuth state/,
      );
    });

    it('a concurrent double-consume yields exactly one success', async () => {
      const { state } = await svc.issue(USER, PROVIDER, REDIRECT);
      const results = await Promise.allSettled([
        svc.consume(state),
        svc.consume(state),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });
  });

  describe('expiry rejection', () => {
    it('rejects a state whose TTL has elapsed', async () => {
      jest.useFakeTimers();
      try {
        const { state } = await svc.issue(USER, PROVIDER, REDIRECT);
        jest.advanceTimersByTime(OAUTH_STATE_TTL_MS + 1);
        await expect(svc.consume(state)).rejects.toThrow(
          /Invalid or expired OAuth state/,
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('accepts a state consumed just before expiry', async () => {
      jest.useFakeTimers();
      try {
        const { state } = await svc.issue(USER, PROVIDER, REDIRECT);
        jest.advanceTimersByTime(OAUTH_STATE_TTL_MS - 1000);
        const record = await svc.consume(state);
        expect(record.userId).toBe(USER);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('malformed / unknown state', () => {
    it('rejects an unknown state', async () => {
      await expect(svc.consume('never-issued')).rejects.toThrow(
        /Invalid or expired OAuth state/,
      );
    });

    it('rejects an empty/invalid state argument', async () => {
      await expect(svc.consume('')).rejects.toThrow(/Invalid OAuth state/);
      // @ts-expect-error testing runtime guard against non-string input
      await expect(svc.consume(undefined)).rejects.toThrow(/Invalid OAuth state/);
    });

    it('rejects a state whose stored payload is corrupt JSON', async () => {
      const corruptStore: OauthStateStore = {
        set: jest.fn(),
        consume: jest.fn().mockResolvedValue('{not-json'),
      };
      const corruptSvc = new OauthStateService(corruptStore);
      await expect(corruptSvc.consume('x')).rejects.toThrow(
        /Invalid or expired OAuth state/,
      );
    });
  });

  describe('RedisOauthStateStore', () => {
    it('uses SET ... PX <ttl> and GETDEL for atomic single-use', async () => {
      const redis = {
        set: jest.fn().mockResolvedValue('OK'),
        getdel: jest.fn().mockResolvedValue(
          JSON.stringify({ userId: USER, provider: PROVIDER, redirectUri: REDIRECT }),
        ),
        quit: jest.fn().mockResolvedValue('OK'),
      };
      const redisStore = new RedisOauthStateStore(redis);
      const redisSvc = new OauthStateService(redisStore);

      const { state } = await redisSvc.issue(USER, PROVIDER, REDIRECT);
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('wearables:oauth:state:'),
        expect.any(String),
        'PX',
        OAUTH_STATE_TTL_MS,
      );

      const record = await redisSvc.consume(state);
      expect(redis.getdel).toHaveBeenCalledWith(
        expect.stringContaining('wearables:oauth:state:'),
      );
      expect(record.userId).toBe(USER);
    });

    it('rejects when Redis returns null (expired/unknown/replayed)', async () => {
      const redis = {
        set: jest.fn().mockResolvedValue('OK'),
        getdel: jest.fn().mockResolvedValue(null),
        quit: jest.fn().mockResolvedValue('OK'),
      };
      const redisSvc = new OauthStateService(new RedisOauthStateStore(redis));
      await expect(redisSvc.consume('gone')).rejects.toThrow(
        /Invalid or expired OAuth state/,
      );
    });
  });
});
