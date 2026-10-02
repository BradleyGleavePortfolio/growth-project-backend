/**
 * R2a — a billing-locked client can still read, grant and withdraw AI
 * processing consent (operator ruling on #622: AI consent is a privacy right
 * and billing state never blocks it).
 *
 * Boots the REAL AiConsentController (via AiConsentModule) behind the REAL
 * DunningLockoutGuard registered as a global APP_GUARD after an auth stand-in,
 * the same order src/app.module.ts uses, with FEATURE_DUNNING_V2 ON and the
 * caller's DunningState in lockout. A dummy protected surface in the same app
 * proves the lockout is actually active for that caller (403 LOCKED_DUNNING).
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  Controller,
  type DynamicModule,
  type ExecutionContext,
  Get,
  type INestApplication,
  Post,
  Put,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { CacheControlInterceptor } from '../../src/common/cache-control.interceptor';
import { DunningLockoutGuard } from '../../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../../src/checkout/dunning-v2/dunning-v2.cadence';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const H_USER = 'x-test-user';
const LOCKED = 'r2a_locked_client';

/** Stand-in for JwtAuthGuard (global and controller level): header = caller. */
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'student' };
    return true;
  }
}

/** A paid surface that must stay locked, proving the lockout is live here. */
@Controller('community')
class LockedSurfaceController {
  @Get('feed')
  feed(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Hypothetical later controller colliding with the consent paths (other
 * methods, descendants). Unmatched routes never reach guards in Nest, so these
 * are mounted to prove the GUARD locks them, not merely the router.
 */
@Controller('me/ai-consent')
class ConsentLookalikeController {
  @Get('roman')
  getRoman(): { ok: true } {
    return { ok: true };
  }

  @Put('roman')
  putRoman(): { ok: true } {
    return { ok: true };
  }

  @Post()
  postRoot(): { ok: true } {
    return { ok: true };
  }

  @Get('export')
  exportAll(): { ok: true } {
    return { ok: true };
  }

  @Post('roman/messages')
  postMessages(): { ok: true } {
    return { ok: true };
  }
}

/** Ledger stand-in plus the one DunningState read the lockout guard makes. */
class LockableLedgerPrisma extends FakeLedgerPrisma {
  lockedUserIds = new Set<string>();
  dunningLookups = 0;
  readonly dunningState = {
    findFirst: async (args: {
      where: { purchase: { client_user_id: string } };
    }): Promise<{ id: string } | null> => {
      this.dunningLookups += 1;
      return this.lockedUserIds.has(args.where.purchase.client_user_id) ? { id: 'ds_1' } : null;
    },
  };
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
}

describe('AI consent routes while billing-locked (DunningLockoutGuard, #622 ruling)', () => {
  const OLD_LEDGER = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  const OLD_DUNNING = process.env.FEATURE_DUNNING_V2;
  let app: INestApplication;
  let fake: LockableLedgerPrisma;
  let baseUrl: string;

  function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { [H_USER]: LOCKED };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data.length ? JSON.parse(data) : null });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    process.env.FEATURE_DUNNING_V2 = 'true';
    fake = new LockableLedgerPrisma();
    fake.lockedUserIds.add(LOCKED);
    const fakePrismaModule: DynamicModule = {
      module: class FakePrismaModule {},
      global: true,
      providers: [{ provide: PrismaService, useValue: fake }],
      exports: [PrismaService],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule, AiConsentModule],
      controllers: [LockedSurfaceController, ConsentLookalikeController],
      providers: [
        // Production order: authentication first, lockout guard after it.
        { provide: APP_GUARD, useClass: HeaderAuthGuard },
        { provide: APP_GUARD, useClass: DunningLockoutGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new CacheControlInterceptor());
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    if (OLD_LEDGER === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD_LEDGER;
    if (OLD_DUNNING === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = OLD_DUNNING;
  });

  it('control: the same locked caller gets 403 LOCKED_DUNNING on a paid surface', async () => {
    const res = await call('GET', '/api/community/feed');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: LOCKED_DUNNING_CODE });
    expect(fake.dunningLookups).toBe(1);
  });

  it('a locked-out client can GET their AI consent status', async () => {
    const res = await call('GET', '/api/me/ai-consent');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ granted: false, state: 'not_granted' });
    // The allow-list short-circuits before any DunningState read.
    expect(fake.dunningLookups).toBe(0);
  });

  it('a locked-out client can DELETE (withdraw) a recorded grant', async () => {
    fake.plant({ user_id: LOCKED, seq: 1, action: 'grant' });
    const res = await call('DELETE', '/api/me/ai-consent/roman');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ granted: false, state: 'withdrawn' });
    expect(fake.rows.filter((r) => r.user_id === LOCKED).map((r) => r.action)).toEqual([
      'grant',
      'withdraw',
    ]);
    expect(fake.dunningLookups).toBe(0);
  });

  it('a locked-out client can POST a grant (the whole consent surface is a privacy control)', async () => {
    const res = await call('POST', '/api/me/ai-consent/roman', { version: 'client-ai-v4' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ granted: true, state: 'granted' });
    expect(fake.dunningLookups).toBe(0);
  });

  // Sol B-622-1: only the three exact operations ride the carve-out. Any other
  // method on the consent paths, or any descendant, meets the lockout first
  // (403 LOCKED_DUNNING, one DunningState read) rather than reaching routing.
  it('control: the lookalike routes are mounted (an unlocked caller reaches them)', async () => {
    fake.lockedUserIds.clear();
    const res = await call('GET', '/api/me/ai-consent/export');
    expect(res.status).toBe(200);
    expect(fake.dunningLookups).toBe(1);
  });

  it.each([
    ['GET', '/api/me/ai-consent/roman'],
    ['PUT', '/api/me/ai-consent/roman'],
    ['POST', '/api/me/ai-consent'],
    ['GET', '/api/me/ai-consent/export'],
    ['POST', '/api/me/ai-consent/roman/messages'],
  ])('a locked-out client is 403 LOCKED_DUNNING on %s %s', async (method, path) => {
    const res = await call(method, path, method === 'GET' ? undefined : {});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: LOCKED_DUNNING_CODE });
    expect(fake.dunningLookups).toBe(1);
  });
});
