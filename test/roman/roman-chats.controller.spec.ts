/**
 * B-635-2: RomanChatsController — the client can list their Roman chats and
 * delete any of them (or all of them), and these routes work while the Roman
 * chat flag is OFF (a deletion right never depends on the chat kill switch).
 *
 * Boots a real Nest HTTP app with the production ValidationPipe options,
 * HttpExceptionFilter and CacheControlInterceptor (no DB: RomanService is a
 * stub), and issues real requests over Node's http module (no supertest in
 * this repo, same harness as the talent-marketplace *.http.spec.ts files).
 */
import 'reflect-metadata';
import * as http from 'http';
import {
  ExecutionContext,
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { CacheControlInterceptor } from '../../src/common/cache-control.interceptor';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma.service';
import { RomanChatsController } from '../../src/roman/roman-chats.controller';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { RomanService, romanSessionNotFound } from '../../src/roman/roman.service';
import {
  ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE,
  ROMAN_SESSIONS_SURFACE_INVALID_MESSAGE,
  ROMAN_SESSIONS_UNKNOWN_PARAM_MESSAGE,
} from '../../src/roman/roman-chats.query';
import {
  ROMAN_CURSOR_INVALID_MESSAGE,
  ROMAN_DELETE_ALL_MAX_BATCHES,
  ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE,
  ROMAN_ERASE_INCOMPLETE_MESSAGE,
  ROMAN_ERASE_UNCONFIRMED_MESSAGE,
} from '../../src/roman/roman.constants';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';

// The service's own sanitized report and the filter's 5xx capture both go
// through this mock (no network in tests).
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  withScope: (cb: (scope: { setTag: () => void; setExtra: () => void }) => void) =>
    cb({ setTag: () => undefined, setExtra: () => undefined }),
}));

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const NOW = new Date('2026-10-02T12:00:00.000Z');
function sessionRow(id: string, dayKey: string) {
  return {
    id,
    user_id: 'user-A',
    surface: 'client',
    day_key: dayKey,
    message_count: 4,
    started_at: NOW,
    last_activity_at: NOW,
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: { brief: 'private context' },
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
}

describe('RomanChatsController — list and delete own chats (B-635-2)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let savedFlag: string | undefined;
  const roman = {
    listSessions: jest.fn(async (..._a: unknown[]) => ({
      sessions: [sessionRow('s_today', '2026-10-02'), sessionRow('s_old', '2026-09-20')],
      nextCursor: 's_old',
    })),
    deleteSession: jest.fn(async (..._a: unknown[]) => undefined),
    deleteAllSessions: jest.fn(async (..._a: unknown[]) => 2),
    getOwnedSession: jest.fn(async (..._a: unknown[]) => sessionRow('s_today', '2026-10-02')),
    listMessages: jest.fn(async (..._a: unknown[]) => ({ messages: [], nextCursor: null })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RomanController, RomanChatsController],
      providers: [
        RomanFeatureGuard,
        { provide: RomanService, useValue: roman },
        {
          provide: PrismaService,
          useValue: { coachSubscription: { findUnique: async () => null } },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            id: 'user-A',
            role: 'student',
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    // The production pipe / filter / interceptor (src/main.ts).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new CacheControlInterceptor());
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    delete process.env[FLAG]; // Roman chat OFF unless a test turns it on
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  function call(method: string, path: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body: unknown = null;
          try {
            body = data.length ? JSON.parse(data) : null;
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('is not behind RomanFeatureGuard: only JwtAuthGuard + RolesGuard are mounted', () => {
    const guards = Reflect.getMetadata('__guards__', RomanChatsController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('GET /roman/sessions works with the chat flag OFF, takes ?limit as a number, is no-store and content-free', async () => {
    const res = await call('GET', '/roman/sessions?limit=30&surface=client&cursor=s_x');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(roman.listSessions).toHaveBeenCalledWith(
      { id: 'user-A', role: 'student' },
      { cursor: 's_x', limit: 30, surface: 'client' },
    );
    expect(res.body).toEqual({
      sessions: [
        {
          id: 's_today',
          surface: 'client',
          dayKey: '2026-10-02',
          messageCount: 4,
          startedAt: NOW.toISOString(),
          lastActivityAt: NOW.toISOString(),
        },
        {
          id: 's_old',
          surface: 'client',
          dayKey: '2026-09-20',
          messageCount: 4,
          startedAt: NOW.toISOString(),
          lastActivityAt: NOW.toISOString(),
        },
      ],
      nextCursor: 's_old',
    });
    expect(JSON.stringify(res.body)).not.toContain('private context');
    expect(JSON.stringify(res.body)).not.toContain('user_id');
  });

  // Sol B-635-5: every known bad query is a coded 400 with a next step,
  // through the production ValidationPipe + HttpExceptionFilter, and never
  // reaches the service. Before the fix these were uncoded class-validator
  // 400s (e.g. message ["limit must not be greater than 100"], no code).
  it.each([
    ['limit=abc', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE],
    ['limit=0', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE],
    ['limit=101', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE],
    ['limit=1.5', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE],
    ['limit=-1', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE],
    ['limit=5&limit=6', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE],
    ['surface=web', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_SURFACE_INVALID_MESSAGE],
    [
      'surface=client&surface=coach',
      'ROMAN_SESSIONS_QUERY_INVALID',
      ROMAN_SESSIONS_SURFACE_INVALID_MESSAGE,
    ],
    ['unknown=1', 'ROMAN_SESSIONS_QUERY_INVALID', ROMAN_SESSIONS_UNKNOWN_PARAM_MESSAGE],
    [`cursor=${'c'.repeat(65)}`, 'ROMAN_CURSOR_INVALID', ROMAN_CURSOR_INVALID_MESSAGE],
    ['cursor=a&cursor=b', 'ROMAN_CURSOR_INVALID', ROMAN_CURSOR_INVALID_MESSAGE],
  ])(
    'GET /roman/sessions?%s is a coded 400 (%s) with a next step and never reaches the service',
    async (q, code, message) => {
      const res = await call('GET', `/roman/sessions?${q}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code, message });
      expect(String((res.body as { message: unknown }).message)).toMatch(/Refresh/);
      expect(roman.listSessions).not.toHaveBeenCalled();
    },
  );

  it('GET /roman/sessions with no query or an empty cursor is the first page (defaults unchanged)', async () => {
    const res = await call('GET', '/roman/sessions?cursor=');
    expect(res.status).toBe(200);
    expect(roman.listSessions).toHaveBeenCalledWith(
      { id: 'user-A', role: 'student' },
      { cursor: undefined, limit: undefined, surface: undefined },
    );
  });

  it('DELETE /roman/sessions erases every chat of the caller: 204 with the chat flag OFF', async () => {
    const res = await call('DELETE', '/roman/sessions');
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(roman.deleteAllSessions).toHaveBeenCalledWith({ id: 'user-A', role: 'student' });
  });

  it('DELETE /roman/sessions/:id erases one chat: 204 with the chat flag OFF', async () => {
    const res = await call('DELETE', '/roman/sessions/s_old');
    expect(res.status).toBe(204);
    expect(roman.deleteSession).toHaveBeenCalledWith({ id: 'user-A', role: 'student' }, 's_old');
  });

  it('the coded 404 and 503 reach the wire with their machine code and next-step message', async () => {
    roman.deleteSession.mockRejectedValueOnce(romanSessionNotFound());
    const nf = await call('DELETE', '/roman/sessions/s_gone');
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({
      code: 'ROMAN_SESSION_NOT_FOUND',
      message: 'This conversation no longer exists. Open Roman again to start a new one.',
    });

    roman.deleteAllSessions.mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'ROMAN_ERASE_INCOMPLETE',
        message: 'Roman could not finish deleting your conversations.',
      }),
    );
    const busy = await call('DELETE', '/roman/sessions');
    expect(busy.status).toBe(503);
    expect(busy.body).toMatchObject({ code: 'ROMAN_ERASE_INCOMPLETE' });
  });

  // ─── Sol B-635-4: the ACTUAL RomanService failing at every boundary, behind
  // the production controller + filter. Before the fix both routes answered
  // 500 {message: "Internal server error"} with no code.
  describe('real RomanService delete failures are coded and actionable on the wire (B-635-4)', () => {
    const P2024 = () =>
      new Prisma.PrismaClientKnownRequestError('synthetic connection timeout secret-detail', {
        code: 'P2024',
        clientVersion: 'test',
      });
    const LIVE = { id: 's_today', day_key: '2026-10-02', deleted_at: null };
    const sentry = jest.mocked(Sentry.captureException);

    function realService(db: Record<string, unknown>): RomanService {
      // @ts-expect-error deliberately partial Prisma double for the deletion boundary.
      const prisma: PrismaService = db;
      return new RomanService(prisma, grantAllEgress());
    }
    function routeDeleteOne(db: Record<string, unknown>) {
      const svc = realService(db);
      roman.deleteSession.mockImplementationOnce(async (...a: unknown[]) => {
        await svc.deleteSession({ id: 'user-A', role: 'student' }, String(a[1]));
        return undefined;
      });
    }
    function routeDeleteAll(db: Record<string, unknown>) {
      const svc = realService(db);
      roman.deleteAllSessions.mockImplementationOnce(async () =>
        svc.deleteAllSessions({ id: 'user-A', role: 'student' }),
      );
    }
    function expectCoded(res: HttpResult, message: string) {
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'ROMAN_ERASE_INCOMPLETE', message });
      expect(JSON.stringify(res.body)).not.toMatch(/synthetic|secret-detail|P2024/);
      // The sanitized diagnostic is reported separately (never the ORM text).
      const reported = sentry.mock.calls.map((c) => String(c[0]));
      expect(reported.some((r) => r.includes('Database request failed (P2024)'))).toBe(true);
      expect(reported.join(' ')).not.toContain('secret-detail');
    }

    it('single delete: the ownership read fails -> 503, says not changed (nothing was written)', async () => {
      const db = {
        romanSession: { findFirst: jest.fn().mockRejectedValue(P2024()) },
        $transaction: jest.fn(),
      };
      routeDeleteOne(db);
      const res = await call('DELETE', '/roman/sessions/s_today');
      expectCoded(res, ROMAN_ERASE_INCOMPLETE_MESSAGE);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('single delete: the erase transaction fails (or its commit ack is lost) -> 503, says it could not confirm, never "not changed"', async () => {
      const db = {
        romanSession: { findFirst: jest.fn(async () => LIVE) },
        $transaction: jest.fn().mockRejectedValue(P2024()),
      };
      routeDeleteOne(db);
      const res = await call('DELETE', '/roman/sessions/s_today');
      expectCoded(res, ROMAN_ERASE_UNCONFIRMED_MESSAGE);
      expect(String((res.body as { message: string }).message)).not.toMatch(/not changed/);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('single delete: the foreign/missing 404 and an already-erased 204 are unchanged', async () => {
      routeDeleteOne({
        romanSession: { findFirst: jest.fn(async () => null) },
        $transaction: jest.fn(),
      });
      const nf = await call('DELETE', '/roman/sessions/s_other');
      expect(nf.status).toBe(404);
      expect(nf.body).toMatchObject({ code: 'ROMAN_SESSION_NOT_FOUND' });
      routeDeleteOne({
        romanSession: {
          findFirst: jest.fn(async () => ({
            id: 's_today',
            day_key: 'erased:s_today',
            deleted_at: NOW,
          })),
        },
        $transaction: jest.fn(),
      });
      const again = await call('DELETE', '/roman/sessions/s_today');
      expect(again.status).toBe(204);
      expect(sentry).not.toHaveBeenCalled();
    });

    it('delete all: the first batch read fails -> 503 delete-all copy', async () => {
      routeDeleteAll({ romanSession: { findMany: jest.fn().mockRejectedValue(P2024()) } });
      expectCoded(await call('DELETE', '/roman/sessions'), ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE);
    });

    it('delete all: a later batch read fails after earlier rows committed -> 503, a retry finishes', async () => {
      const findMany = jest.fn().mockResolvedValueOnce([LIVE]).mockRejectedValueOnce(P2024());
      const $transaction = jest.fn(async () => true);
      routeDeleteAll({ romanSession: { findMany }, $transaction });
      expectCoded(await call('DELETE', '/roman/sessions'), ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE);
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('delete all: a per-row transaction fails (commit unknown) -> 503 delete-all copy', async () => {
      routeDeleteAll({
        romanSession: { findMany: jest.fn().mockResolvedValue([LIVE]) },
        $transaction: jest.fn().mockRejectedValue(P2024()),
      });
      expectCoded(await call('DELETE', '/roman/sessions'), ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE);
    });

    it('delete all: the final remaining-count read fails -> 503 delete-all copy', async () => {
      const count = jest.fn().mockRejectedValue(P2024());
      routeDeleteAll({
        romanSession: { findMany: jest.fn().mockResolvedValue([LIVE]), count },
        $transaction: jest.fn(async () => true),
      });
      expectCoded(await call('DELETE', '/roman/sessions'), ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE);
      expect(count).toHaveBeenCalledTimes(1);
      expect(ROMAN_DELETE_ALL_MAX_BATCHES).toBeGreaterThan(0);
    });
  });

  it('the chat routes stay behind the flag: reading messages is a 404 while Roman chat is OFF', async () => {
    const res = await call('GET', '/roman/sessions/s_today/messages');
    expect(res.status).toBe(404);
    expect(roman.listMessages).not.toHaveBeenCalled();
  });

  it('GET /roman/sessions/:id/messages?limit=30 is accepted (number) and no-store once the flag is ON', async () => {
    process.env[FLAG] = 'true';
    const res = await call('GET', '/roman/sessions/s_today/messages?limit=30');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(roman.listMessages.mock.calls[0][2]).toEqual({ cursor: undefined, limit: 30 });
  });
});
