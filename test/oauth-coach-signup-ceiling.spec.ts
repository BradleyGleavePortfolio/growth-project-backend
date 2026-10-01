// Sol SOL-C13-A2 — the OAuth coach-signup ceiling must actually block.
//
// These tests run LoginThrottleResetService.consumeOAuthCoachSignupSlot
// against the REAL storage implementations, never an incrementing mock:
//   * @nestjs/throttler's own in-memory ThrottlerStorageService (dev/test);
//   * the production shape — @nest-lab/throttler-storage-redis behind
//     withFailOpenStorage — on a live Redis (CI service container).
// The audit probe showed the submitted zero block duration let 12/12 calls
// through at limit 5 on the real in-memory adapter (hits 1..5,1..5,1,2).
import 'reflect-metadata';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import {
  LoginThrottleResetService,
  OAUTH_COACH_SIGNUP_BLOCK_MS,
  oauthCoachSignupKey,
} from '../src/throttler/login-throttle-reset.service';
import { withFailOpenStorage } from '../src/throttler/throttler.config';
import { describeLiveRedis, liveRedisClient } from './support/live-redis';

async function attempt(svc: LoginThrottleResetService, ip: string | null): Promise<'ok' | '429' | '503'> {
  try {
    await svc.consumeOAuthCoachSignupSlot(ip);
    return 'ok';
  } catch (err) {
    if (err instanceof ThrottlerException) return '429';
    if (err instanceof ServiceUnavailableException) return '503';
    throw err;
  }
}

const quietLogger = { warn: () => undefined } as any;

describe('OAuth coach-signup ceiling on the real in-memory @nestjs/throttler storage', () => {
  let storage: ThrottlerStorageService;
  beforeEach(() => {
    delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    storage = new ThrottlerStorageService();
  });
  afterEach(() => storage.onApplicationShutdown());

  it('uses a positive, full-window block duration', () => {
    expect(OAUTH_COACH_SIGNUP_BLOCK_MS).toBeGreaterThanOrEqual(3_600_000);
  });

  it('admits exactly 5 of 12 attempts from one IP (the audit probe sequence) and keeps blocking', async () => {
    const svc = new LoginThrottleResetService(storage);
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push(await attempt(svc, '192.0.2.1'));
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', '429', '429', '429', '429', '429', '429', '429']);
  });

  it('is keyed per IP and a missing IP shares one bucket instead of skipping the ceiling', async () => {
    const svc = new LoginThrottleResetService(storage);
    for (let i = 0; i < 5; i++) expect(await attempt(svc, '192.0.2.1')).toBe('ok');
    expect(await attempt(svc, '192.0.2.1')).toBe('429');
    expect(await attempt(svc, '192.0.2.2')).toBe('ok');
    const missing: string[] = [];
    for (let i = 0; i < 6; i++) missing.push(await attempt(svc, i % 2 ? null : '  '));
    expect(missing).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', '429']);
    expect(oauthCoachSignupKey(undefined)).toBe('oauth-coach-signup:ip:unknown');
  });

  it('honours AUTH_OAUTH_COACH_SIGNUP_PER_HOUR', async () => {
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = '2';
    const svc = new LoginThrottleResetService(storage);
    const r = [await attempt(svc, '198.51.100.9'), await attempt(svc, '198.51.100.9'), await attempt(svc, '198.51.100.9')];
    expect(r).toEqual(['ok', 'ok', '429']);
  });

  it('fails CLOSED through the production fail-open wrapper when the backend errors', async () => {
    const broken = { increment: async () => { throw new Error('Stream isn\'t writeable'); } } as any;
    const svc = new LoginThrottleResetService(withFailOpenStorage(broken, { logger: quietLogger }));
    expect(await attempt(svc, '203.0.113.5')).toBe('503');
  });

  it('is a no-op only when no throttler storage exists at all', async () => {
    expect(await attempt(new LoginThrottleResetService(undefined), '203.0.113.5')).toBe('ok');
  });
});

describeLiveRedis('OAuth coach-signup ceiling on live Redis behind withFailOpenStorage (production shape)', () => {
  const redis = liveRedisClient();
  const adapter = new ThrottlerStorageRedisService(redis as any);
  const storage = withFailOpenStorage(adapter, { logger: quietLogger });
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}-${Date.now()}`;

  beforeAll(async () => {
    delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    await redis.ping();
  });
  afterAll(async () => {
    const keys = await redis.keys(`*oauth-coach-signup:ip:${ip}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });

  it('admits 5 of 12 and the overflow is a real Redis block (not a fail-open zero record)', async () => {
    const svc = new LoginThrottleResetService(storage);
    const results: string[] = [];
    for (let i = 0; i < 12; i++) results.push(await attempt(svc, ip));
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', '429', '429', '429', '429', '429', '429', '429']);
    const blockKey = `{${oauthCoachSignupKey(ip)}:oauth-coach-signup}:blocked`;
    const pttl = await redis.pttl(blockKey);
    expect(pttl).toBeGreaterThan(3_500_000);
  });
});
