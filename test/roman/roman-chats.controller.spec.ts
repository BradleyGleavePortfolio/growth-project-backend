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

  it.each([['limit=abc'], ['limit=0'], ['limit=101'], ['surface=web'], ['unknown=1']])(
    'GET /roman/sessions?%s is a 400 (validated, never reaches the service)',
    async (q) => {
      const res = await call('GET', `/roman/sessions?${q}`);
      expect(res.status).toBe(400);
      expect(roman.listSessions).not.toHaveBeenCalled();
    },
  );

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
