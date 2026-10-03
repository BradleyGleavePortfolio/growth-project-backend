/**
 * B-608-13 (Opus, was C-608-2): the admin force-delete route is an immediate,
 * irreversible full erasure of any user id (every erasure-manifest table,
 * Storage purge, Apple revocation, receipt). An owner bearer token alone must
 * not be enough: the route requires RecentAuthGuard's fresh, single-use
 * step-up token, bound to the calling owner.
 *
 * This suite boots a real Nest HTTP app with the production ValidationPipe and
 * HttpExceptionFilter, the REAL RolesGuard and the REAL RecentAuthGuard (only
 * JwtAuthGuard is replaced by a header-driven identity stub, and the nonce
 * store is an in-memory unique set that answers P2002 like Postgres). The
 * service is a spy, so "nothing is erased" means the service was never called.
 *
 * Failing before the fix: the owner-without-token request returned 200 and
 * erased the user; the replay and cross-user requests also reached the service.
 */
import 'reflect-metadata';
import * as http from 'http';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { AccountDeletionController } from '../../src/account-deletion/account-deletion.controller';
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import {
  RECENT_AUTH_ERROR_CODES,
  RecentAuthGuard,
  issueRecentAuthToken,
} from '../../src/auth/recent-auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';

const SECRET = 'test-recent-auth-secret-at-least-32-chars-long';
const configGet = (k: string) =>
  k === 'RECENT_AUTH_SECRET' ? SECRET : k === 'RECENT_AUTH_TTL_MS' ? 300_000 : undefined;

function stub<T>(value: unknown): T {
  return value as T;
}
const TARGET = '11111111-1111-4111-8111-111111111111';

const IDENTITIES: Record<string, { id: string; role: string; email: string }> = {
  'owner-a': { id: 'owner-a', role: 'owner', email: 'a@example.test' },
  'owner-b': { id: 'owner-b', role: 'owner', email: 'b@example.test' },
  'coach-c': { id: 'coach-c', role: 'coach', email: 'c@example.test' },
};

/** Stands in for JwtAuthGuard: the `x-test-user` header picks the identity. */
@Injectable()
class HeaderIdentityGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const who = req.headers['x-test-user'];
    req.user = typeof who === 'string' ? IDENTITIES[who] : undefined;
    return true;
  }
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

describe('POST /admin/users/:id/delete requires step-up re-auth (B-608-13)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const adminForceDelete = jest.fn(async (id: string) => ({ message: `deleted ${id}` }));
  const nonces = new Set<string>();
  const nonceCreate = jest.fn(async (args: { data: { id: string } }) => {
    if (nonces.has(args.data.id)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }
    nonces.add(args.data.id);
    return { id: args.data.id };
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountDeletionController],
      providers: [
        { provide: AccountDeletionService, useValue: { adminForceDelete } },
        { provide: PrismaService, useValue: { recentAuthNonce: { create: nonceCreate } } },
        {
          provide: ConfigService,
          useValue: { get: configGet },
        },
        // Production registers JwtAuthGuard and then RolesGuard globally
        // (app.module.ts APP_GUARD, in that order) in addition to the class-
        // and method-level guards; mirror that order.
        { provide: APP_GUARD, useClass: HeaderIdentityGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderIdentityGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    adminForceDelete.mockClear();
    nonceCreate.mockClear();
    nonces.clear();
  });

  function post(user: string, token?: string): Promise<HttpResult> {
    const payload = JSON.stringify({ reason: 'support ticket 42' });
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-test-user': user,
    };
    if (token) headers['x-recent-auth-token'] = token;
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/admin/users/${TARGET}/delete`,
        { method: 'POST', headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('declares RolesGuard before RecentAuthGuard on the handler', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AccountDeletionController.prototype.adminForceDelete),
    ).toEqual([RolesGuard, RecentAuthGuard]);
  });

  it('an owner without X-Recent-Auth-Token gets 401 RECENT_AUTH_REQUIRED and nothing is erased', async () => {
    const res = await post('owner-a');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(RECENT_AUTH_ERROR_CODES.required);
    expect(String(res.body.message)).toContain('/auth/recent-auth-token');
    expect(adminForceDelete).not.toHaveBeenCalled();
  });

  it('an owner with a fresh token of its own erases the target once', async () => {
    const res = await post('owner-a', issueRecentAuthToken('owner-a', SECRET));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: `deleted ${TARGET}` });
    expect(adminForceDelete).toHaveBeenCalledTimes(1);
    expect(adminForceDelete).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({
        actorId: 'owner-a',
        actorRole: 'owner',
        reason: 'support ticket 42',
      }),
    );
  });

  it('a replayed token gets 403 RECENT_AUTH_TOKEN_ALREADY_USED and nothing more is erased', async () => {
    const token = issueRecentAuthToken('owner-a', SECRET);
    expect((await post('owner-a', token)).status).toBe(200);
    const replay = await post('owner-a', token);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe(RECENT_AUTH_ERROR_CODES.alreadyUsed);
    // Legacy discriminator the mobile app already reads stays in place.
    expect(replay.body.error).toBe('RECENT_AUTH_TOKEN_ALREADY_USED');
    expect(adminForceDelete).toHaveBeenCalledTimes(1);
  });

  it("another owner's token gets 403 RECENT_AUTH_TOKEN_USER_MISMATCH and nothing is erased", async () => {
    const res = await post('owner-b', issueRecentAuthToken('owner-a', SECRET));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(RECENT_AUTH_ERROR_CODES.userMismatch);
    expect(adminForceDelete).not.toHaveBeenCalled();
  });

  it('an expired token gets 401 RECENT_AUTH_TOKEN_EXPIRED and nothing is erased', async () => {
    const realNow = Date.now;
    const minted = realNow() - 10 * 60_000;
    Date.now = () => minted;
    let stale: string;
    try {
      stale = issueRecentAuthToken('owner-a', SECRET);
    } finally {
      Date.now = realNow;
    }
    const res = await post('owner-a', stale);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(RECENT_AUTH_ERROR_CODES.expired);
    expect(adminForceDelete).not.toHaveBeenCalled();
  });

  it('a tampered token gets 401 RECENT_AUTH_TOKEN_INVALID and nothing is erased', async () => {
    const token = issueRecentAuthToken('owner-a', SECRET);
    const tampered = `${token.slice(0, -4)}${token.endsWith('0000') ? '1111' : '0000'}`;
    const res = await post('owner-a', tampered);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(RECENT_AUTH_ERROR_CODES.invalid);
    expect(adminForceDelete).not.toHaveBeenCalled();
  });

  it('a coach with a valid token of its own gets 403 Insufficient role and its nonce is not consumed', async () => {
    const token = issueRecentAuthToken('coach-c', SECRET);
    const res = await post('coach-c', token);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Insufficient role');
    expect(nonceCreate).not.toHaveBeenCalled();
    expect(adminForceDelete).not.toHaveBeenCalled();
  });

  it('every other guard failure carries a stable code too', async () => {
    const ctx = (user: unknown, token?: string) =>
      stub<ExecutionContext>({
        switchToHttp: () => ({
          getRequest: () => ({ headers: token ? { 'x-recent-auth-token': token } : {}, user }),
        }),
      });
    const prisma = stub<PrismaService>({ recentAuthNonce: { create: nonceCreate } });
    const noSecret = new RecentAuthGuard(stub<ConfigService>({ get: () => undefined }), prisma);
    await expect(noSecret.canActivate(ctx(IDENTITIES['owner-a'], 'a.1.b'))).rejects.toMatchObject({
      response: { code: RECENT_AUTH_ERROR_CODES.unavailable },
    });
    const g = new RecentAuthGuard(stub<ConfigService>({ get: configGet }), prisma);
    const token = issueRecentAuthToken('owner-a', SECRET);
    await expect(g.canActivate(ctx(undefined, token))).rejects.toMatchObject({
      response: { code: RECENT_AUTH_ERROR_CODES.sessionRequired },
    });
    await expect(g.canActivate(ctx(IDENTITIES['owner-a'], 'not-a-token'))).rejects.toMatchObject({
      response: { code: RECENT_AUTH_ERROR_CODES.invalid },
    });
    expect(nonceCreate).not.toHaveBeenCalled();
    expect(adminForceDelete).not.toHaveBeenCalled();
  });
});
