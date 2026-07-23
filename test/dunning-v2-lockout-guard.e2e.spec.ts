/**
 * B3 Smart Dunning v2 — Day-10 lockout guard MOUNTING e2e.
 *
 * The unit spec (dunning-v2-lockout-guard.spec.ts) proves the guard's own
 * decision logic in isolation. This spec proves the piece that unit test
 * cannot: that once the guard is registered as a global APP_GUARD in the
 * canonical chain (src/app.module.ts, after JwtAuthGuard), it actually
 * intercepts real HTTP traffic and enforces the lockout end-to-end.
 *
 * It boots a minimal Nest HTTP app with the SAME guard ordering production
 * uses — a JwtAuthGuard stub first (attaches `req.user`), the real
 * DunningLockoutGuard second — plus a stub PrismaService (no DB required).
 * HTTP is issued over Node's built-in http module, matching the sibling
 * community e2e specs (supertest is absent from the golden node_modules).
 *
 * Proves, over the wire:
 *   - flag OFF  → guard is an invisible no-op (protected route 200, no DB read)
 *   - flag ON, eligible authenticated LOCKED user → 403 LOCKED_DUNNING
 *   - flag ON, authenticated UNLOCKED user        → protected route 200
 *   - flag ON, LOCKED user → billing / auth / health routes NOT bricked
 *   - ordering: the guard receives the authenticated identity attached by the
 *     preceding auth guard (the DunningState lookup is keyed by that user id).
 */

import 'reflect-metadata';
import * as http from 'http';
import { CanActivate, Controller, ExecutionContext, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import { PrismaService } from '../src/prisma.service';

// ── Dummy controllers standing in for the real protected + carve-out surfaces.
@Controller('community')
class ProtectedController {
  @Get('feed')
  feed() {
    return { ok: true, surface: 'community' };
  }
}

@Controller('billing')
class BillingController {
  @Get('portal')
  portal() {
    return { ok: true, surface: 'billing' };
  }
}

@Controller('auth')
class AuthController {
  @Get('me')
  me() {
    return { ok: true, surface: 'auth' };
  }
}

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { ok: true, surface: 'health' };
  }
}

// Header carrying the caller id, mirroring how the community e2e stub works.
const H_USER = 'x-test-user-id';

// JwtAuthGuard stub: attaches `req.user` from the header (as the real guard
// attaches the Prisma user after verifying the JWT). Missing header → no user
// attached but request proceeds, so health / other unauthenticated traffic can
// still reach the lockout guard and prove it does not brick those routes.
class StubJwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const userId = req.headers[H_USER] as string | undefined;
    req.user = userId ? { id: userId } : undefined;
    return true;
  }
}

interface HttpResult {
  status: number;
  body: any;
}

describe('DunningLockoutGuard — global mount (e2e over HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  // Spy capturing the arguments the guard passes to the DunningState lookup,
  // so we can assert it was keyed by the authenticated identity.
  const findFirst = jest.fn();
  // When true the stubbed row represents a locked-out client.
  let lockedRow: unknown = null;

  // Structural stand-in for the single PrismaService method the guard touches.
  // Provided via `useValue`, so no full PrismaService shape is required.
  const prismaStub: {
    dunningState: { findFirst: (args: unknown) => Promise<unknown> };
  } = {
    dunningState: {
      findFirst: (args: unknown) => {
        findFirst(args);
        return Promise.resolve(lockedRow);
      },
    },
  };

  const prevFlag = process.env['FEATURE_DUNNING_V2'];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProtectedController, BillingController, AuthController, HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaStub },
        // Production chain: auth guard first (attaches identity), lockout guard
        // second — APP_GUARD execution follows provider registration order.
        { provide: APP_GUARD, useValue: new StubJwtAuthGuard() },
        { provide: APP_GUARD, useClass: DunningLockoutGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror production: every route is served under the /api prefix, which the
    // guard's normalizePath() strips before the allow-list check.
    app.setGlobalPrefix('api');
    await app.listen(0);
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  beforeEach(() => {
    findFirst.mockClear();
    lockedRow = null;
  });

  function call(path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: any = null;
          try {
            body = data.length ? JSON.parse(data) : null;
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  const asUser = (id: string) => ({ [H_USER]: id });

  describe('FEATURE_DUNNING_V2 OFF', () => {
    beforeEach(() => {
      delete process.env['FEATURE_DUNNING_V2'];
    });

    it('is an invisible no-op — locked client still reaches a protected route, no DB read', async () => {
      lockedRow = { id: 'd1' }; // would lock if the guard were active
      const res = await call('/api/community/feed', asUser('u1'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ surface: 'community' });
      expect(findFirst).not.toHaveBeenCalled();
    });
  });

  describe('FEATURE_DUNNING_V2 ON', () => {
    beforeEach(() => {
      process.env['FEATURE_DUNNING_V2'] = 'true';
    });

    it('returns 403 LOCKED_DUNNING for an eligible authenticated locked client on a protected route', async () => {
      lockedRow = { id: 'd1' };
      const res = await call('/api/community/feed', asUser('locked-user'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: LOCKED_DUNNING_CODE });
    });

    it('passes an authenticated UNLOCKED client through to the protected route', async () => {
      lockedRow = null;
      const res = await call('/api/community/feed', asUser('healthy-user'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ surface: 'community' });
    });

    it('receives the authenticated identity — the DunningState lookup is keyed by req.user.id', async () => {
      lockedRow = null;
      await call('/api/community/feed', asUser('u-42'));
      expect(findFirst).toHaveBeenCalledTimes(1);
      const arg = findFirst.mock.calls[0][0] as {
        where: { purchase: { client_user_id: string } };
      };
      expect(arg.where.purchase.client_user_id).toBe('u-42');
    });

    it('does NOT brick the billing recovery route for a locked client', async () => {
      lockedRow = { id: 'd1' };
      const res = await call('/api/billing/portal', asUser('locked-user'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ surface: 'billing' });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('does NOT brick the auth route for a locked client', async () => {
      lockedRow = { id: 'd1' };
      const res = await call('/api/auth/me', asUser('locked-user'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ surface: 'auth' });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('does NOT brick the health route (unauthenticated liveness probe)', async () => {
      lockedRow = { id: 'd1' };
      const res = await call('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ surface: 'health' });
      expect(findFirst).not.toHaveBeenCalled();
    });
  });
});
