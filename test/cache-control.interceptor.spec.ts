/**
 * SETUP-STALE-132 (B07, B38): the global CacheControlInterceptor must never let
 * a phone keep a copy of a personal API response. Before this fix every
 * authenticated 2xx GET carried `private, max-age=60`, so a phone's HTTP cache
 * served GET /coach/onboarding from memory after a write and the setup wizard
 * posted a step the server had already passed (400 STEP_OUT_OF_ORDER).
 *
 * Real Nest app over HTTP with the production HttpExceptionFilter. The stand-in
 * controllers mirror the three ways a route reaches the interceptor: a plain
 * return value, an @Header() decorator, and a handler that writes its own
 * header through @Res(). The real PublicPagesController proves the genuinely
 * public pages keep their public caching.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  INestApplication,
  Post,
  Res,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { CacheControlInterceptor } from '../src/common/cache-control.interceptor';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { PublicPagesController } from '../src/public-pages/public-pages.controller';

@Controller('coach/onboarding')
class StandInOnboardingController {
  @Get()
  progress() {
    return { current_step: 4 };
  }

  @Post('step')
  advance(@Body() body: { step?: number }) {
    if (body.step !== 4) {
      throw new BadRequestException({ code: 'STEP_OUT_OF_ORDER', message: 'Step out of order.' });
    }
    return { current_step: 5 };
  }

  @Get('own-policy')
  @Header('Cache-Control', 'no-store')
  ownPolicy() {
    return { ok: true };
  }
}

@Controller()
class StandInPrefixController {
  @Get('auth/session')
  session() {
    return { ok: true };
  }

  @Get('api/messaging/threads')
  threads() {
    return [];
  }
}

@Controller('public-stand-in')
class StandInPublicController {
  @Get('catalog')
  catalog() {
    return [{ id: 'squat' }];
  }

  @Get('asset')
  asset(@Res() res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ ok: true });
  }

  @Get('moved')
  moved(@Res() res: Response) {
    res.redirect(302, '/public-stand-in/catalog');
  }
}

describe('CacheControlInterceptor (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const bearer = { authorization: 'Bearer synthetic-test-token' };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        StandInOnboardingController,
        StandInPrefixController,
        StandInPublicController,
        PublicPagesController,
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new CacheControlInterceptor());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, baseUrl), { headers, redirect: 'manual' });

  describe('authenticated requests are never stored', () => {
    it('marks a personal GET private, no-store (was private, max-age=60)', async () => {
      const r = await get('/coach/onboarding', bearer);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    });

    it('marks a write private, no-store', async () => {
      const r = await fetch(new URL('/coach/onboarding/step', baseUrl), {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ step: 4 }),
      });
      expect(r.status).toBe(201);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    });

    it('marks an error response private, no-store too', async () => {
      const r = await fetch(new URL('/coach/onboarding/step', baseUrl), {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ step: 3 }),
      });
      expect(r.status).toBe(400);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    });

    it('keeps a route-declared policy', async () => {
      const r = await get('/coach/onboarding/own-policy', bearer);
      expect(r.headers.get('cache-control')).toBe('no-store');
    });

    it('keeps the existing no-store prefixes, with or without the /api prefix', async () => {
      expect((await get('/auth/session', bearer)).headers.get('cache-control')).toBe('no-store');
      expect((await get('/api/messaging/threads', bearer)).headers.get('cache-control')).toBe(
        'no-store',
      );
    });
  });

  describe('public, unauthenticated routes', () => {
    it('keeps public caching where the public route declares it', async () => {
      const privacy = await get('/privacy');
      expect(privacy.status).toBe(200);
      expect(privacy.headers.get('cache-control')).toBe('public, max-age=300');

      const open = await get('/open');
      expect(open.headers.get('cache-control')).toBe('public, max-age=300');

      const asset = await get('/public-stand-in/asset');
      expect(asset.headers.get('cache-control')).toBe('public, max-age=3600');
    });

    it('stores nothing for a public read that declares no policy', async () => {
      const r = await get('/public-stand-in/catalog');
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    });

    it('lets a handler that answers through @Res() redirect without a header error', async () => {
      const r = await get('/public-stand-in/moved');
      expect(r.status).toBe(302);
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    });
  });
});
