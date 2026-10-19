/**
 * GC-2c — one storefront URL for every link (#GC-DOMAIN op 1).
 *
 * Every public storefront link is built by src/storefront/storefront-links.ts
 * from STOREFRONT_BASE_URL, falling back to https://app.trygrowthproject.com in
 * dev/test. Pins: the builders, each call site, the recovery email link hitting
 * a real route over HTTP (supertest is absent, so Node's http module is used,
 * as in test/community/community-v1-6-feature-flag.e2e.spec.ts), no old-domain
 * default left in src, and prod still refusing to boot without the var.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { assertEnv, ENV_RULES } from '../src/common/env-validation';
import { EnvValidationError } from '../src/common/errors/env-validation.error';
import { ShareLinkService } from '../src/share-link/share-link.service';
import { LandingPagePublicService } from '../src/landing-pages/landing-pages.public.service';
import { StorefrontPublicController } from '../src/storefront/storefront-public.controller';
import { StorefrontService } from '../src/storefront/storefront.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { CheckoutRecoveryService } from '../src/storefront/checkout-recovery.service';
import { CheckoutIpRateLimiterService } from '../src/storefront/checkout-rate-limiter.service';
import { CheckoutCookieService } from '../src/storefront/checkout-cookie.service';
import { ThankYouService } from '../src/storefront/thank-you.service';
import { resolveTrustedHost } from '../src/storefront/webview-detect.middleware';
import {
  payPageUrl,
  resumeUrl,
  storefrontBaseUrl,
} from '../src/storefront/storefront-links';

const APP = 'https://app.trygrowthproject.com';
const TOKEN = 'AbCdEf12gHiJ34kLmNoP_'; // 21 chars — passes SHARE_TOKEN_REGEX
const JWT = 'gc2c-header.gc2c-claims.gc2c-signature'; // opaque; verifyToken is mocked
const unset = { get: () => undefined } as unknown as ConfigService;

describe('GC-2c — storefront-links builders', () => {
  it.each([undefined, '', '   ', 'not a url', 'ftp://shop.example.test'])(
    'STOREFRONT_BASE_URL=%p falls back to the app origin',
    (raw) => {
      expect(storefrontBaseUrl(raw)).toBe(APP);
      expect(payPageUrl(raw, TOKEN)).toBe(`${APP}/p/${TOKEN}`);
    },
  );

  it('uses the configured origin, trailing slash stripped', () => {
    expect(payPageUrl('https://shop.example.test/', TOKEN)).toBe(
      `https://shop.example.test/p/${TOKEN}`,
    );
  });

  it('encodes ?lp= and ?resume=, and drops empty query values', () => {
    expect(payPageUrl(undefined, TOKEN, { lp: 'page 1&x=y' })).toBe(
      `${APP}/p/${TOKEN}?lp=page+1%26x%3Dy`,
    );
    expect(payPageUrl(undefined, TOKEN, { resume: 'gc_1' })).toBe(`${APP}/p/${TOKEN}?resume=gc_1`);
    expect(payPageUrl(undefined, TOKEN, { lp: undefined })).toBe(`${APP}/p/${TOKEN}`);
  });

  it('resumeUrl carries the /api prefix the server mounts under', () => {
    expect(resumeUrl(undefined, TOKEN, JWT)).toBe(
      `${APP}/api/v1/packages/public/join/${TOKEN}/checkout/resume/${JWT}`,
    );
  });
});

describe('GC-2c — call sites', () => {
  it('share_url is the pay page /p/<token>', async () => {
    const prisma = {
      coachPackage: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pkg-1',
          share_token: TOKEN,
          share_link_enabled: true,
          share_link_generated_at: new Date('2026-01-01T00:00:00Z'),
        }),
      },
    };
    const svc = new ShareLinkService(prisma as any, unset);
    expect((await svc.mintOrGet('coach-1', 'pkg-1')).share_url).toBe(`${APP}/p/${TOKEN}`);
  });

  it('landing-page Buy routes to /p/<token>?lp=<page id>', async () => {
    const prev = process.env.STOREFRONT_BASE_URL;
    delete process.env.STOREFRONT_BASE_URL;
    try {
      const page = { id: 'page-1', status: 'published', package_ids: ['pkg-1'] };
      const svc = new LandingPagePublicService(
        { coachPackage: { findFirst: jest.fn().mockResolvedValue({ id: 'pkg-1', share_token: TOKEN }) } } as any,
        { findPublishedBySlug: jest.fn().mockResolvedValue(page) } as any,
        {} as any,
        {} as any,
      );
      expect(await svc.resolveCheckoutUrl('GP-JANE1', 'my-page', 'pkg-1')).toBe(
        `${APP}/p/${TOKEN}?lp=page-1`,
      );
    } finally {
      if (prev !== undefined) process.env.STOREFRONT_BASE_URL = prev;
    }
  });

  it('webview interstitial defaults to the app host', () => {
    expect(resolveTrustedHost({ headers: {} })).toBe('app.trygrowthproject.com');
  });
});

describe('GC-2c — the recovery email link hits a real route', () => {
  let app: INestApplication;
  let baseUrl: string;
  const verifyToken = jest.fn(async () => ({ share_token: TOKEN, guest_checkout_id: 'gc_1' }));

  function get(p: string): Promise<{ status: number; location?: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${p}`, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
        })
        .on('error', reject);
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StorefrontPublicController],
      providers: [
        { provide: StorefrontService, useValue: {} },
        { provide: GuestCheckoutService, useValue: {} },
        { provide: CheckoutRecoveryService, useValue: { verifyToken } },
        { provide: ConfigService, useValue: unset },
        {
          provide: CheckoutIpRateLimiterService,
          useValue: { checkAndIncrement: jest.fn(async () => ({ allowed: true, count: 1, retryAfterSeconds: 0 })) },
        },
        { provide: CheckoutCookieService, useValue: {} },
        { provide: ThankYouService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api'); // as src/main.ts
    await app.listen(0);
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('302s to the pay page with ?resume= and never forwards the JWT', async () => {
    const res = await get(new URL(resumeUrl(undefined, TOKEN, JWT)).pathname);
    expect(res.status).toBe(302);
    expect(res.location).toBe(`${APP}/p/${TOKEN}?resume=gc_1`);
    expect(verifyToken).toHaveBeenCalledWith(TOKEN, JWT);
  });

  it('the old link shape (no /api) is a 404', async () => {
    const res = await get(`/v1/packages/public/join/${TOKEN}/checkout/resume/${JWT}`);
    expect(res.status).toBe(404);
  });
});

describe('GC-2c — no old-domain default left in src', () => {
  // Host allow-lists may still accept the old domain on inbound headers.
  const ALLOW = new Set([
    'src/storefront/webview-detect.middleware.ts',
    'src/landing-pages/landing-pages.public.controller.ts',
  ]);
  const root = path.join(__dirname, '..');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );

  it('only allow-list entries name joingrowthproject.com', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, 'src'))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/joingrowthproject/i.test(line) || /^\s*(\/\/|\/?\*)/.test(line)) return;
          const allowListed = ALLOW.has(rel) && /^\s*'(app\.)?joingrowthproject\.com',\s*$/.test(line);
          if (!allowListed) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('GC-2c — prod with STOREFRONT_BASE_URL unset still fails boot', () => {
  const silent = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const prodEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(ENV_RULES.filter((r) => r.tier === 'hard').map((r) => [r.name, 'gc2c-set'])),
    NODE_ENV: 'production',
    REDIS_URL: 'redis://localhost:6379',
    ...extra,
  });
  const failedVars = (env: NodeJS.ProcessEnv): string[] => {
    try {
      assertEnv(env, { logger: silent });
    } catch (e) {
      if (e instanceof EnvValidationError) return e.variables;
      throw e;
    }
    return [];
  };

  it('names STOREFRONT_BASE_URL when unset', () => {
    expect(failedVars(prodEnv())).toContain('STOREFRONT_BASE_URL');
  });

  it('does not name it once set', () => {
    expect(failedVars(prodEnv({ STOREFRONT_BASE_URL: APP }))).not.toContain('STOREFRONT_BASE_URL');
  });
});
