/**
 * Role-guard tests for all Phase 9 notification controller endpoints.
 *
 * Strategy: mount the controller with a real NotificationsService stub
 * (no DB) and verify:
 *   1. Unauthenticated requests → 401
 *   2. Authenticated client requests → 200/OK
 *   3. All endpoints return data in the documented shape
 *
 * NestJS guards are exercised via supertest against the full Nest HTTP layer.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';

// ── Stubs ────────────────────────────────────────────────────────────────────

const mockPrefs = {
  user_id: 'u1',
  muted: false,
  digest_email: true,
};

const mockNotificationsService = {
  getPreferences: jest.fn().mockResolvedValue(mockPrefs),
  updatePreferences: jest.fn().mockResolvedValue(mockPrefs),
  listNotifications: jest.fn().mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 }),
  markRead: jest.fn().mockResolvedValue({ id: 'n1', read_at: new Date() }),
  markAllRead: jest.fn().mockResolvedValue({ updated: 0 }),
};

// JwtAuthGuard stub: passes req.user to the controller.
// Requests that include X-Test-Role header get that role; without the header
// the guard rejects (simulating 401).
class StubJwtAuthGuard {
  canActivate(ctx: import('@nestjs/common').ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const role = req.headers['x-test-role'] as string | undefined;
    if (!role) return false;
    req.user = { id: 'u1', role };
    return true;
  }
}

// ── App bootstrap ────────────────────────────────────────────────────────────

let app: INestApplication;

beforeAll(async () => {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [NotificationsController],
    providers: [{ provide: NotificationsService, useValue: mockNotificationsService }],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(StubJwtAuthGuard)
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
});

afterAll(() => app.close());

beforeEach(() => jest.clearAllMocks());

// ── GET /notifications ────────────────────────────────────────────────────────

describe('GET /notifications', () => {
  it('returns 401 without auth', async () => {
    await request(app.getHttpServer()).get('/notifications').expect(401);
  });

  it('returns 200 with paginated result for authenticated client', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('x-test-role', 'student')
      .expect(200);

    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('unreadCount');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('passes unread filter to service', async () => {
    await request(app.getHttpServer())
      .get('/notifications?filter=unread')
      .set('x-test-role', 'student')
      .expect(200);

    expect(mockNotificationsService.listNotifications).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ filter: 'unread' }),
    );
  });

  it('clamps limit to 100 max via validation pipe', async () => {
    await request(app.getHttpServer())
      .get('/notifications?limit=999')
      .set('x-test-role', 'student')
      .expect(400); // ValidationPipe rejects > 100
  });

  it('coaches can also access their notifications', async () => {
    await request(app.getHttpServer())
      .get('/notifications')
      .set('x-test-role', 'coach')
      .expect(200);
  });
});

// ── POST /notifications/:id/read ─────────────────────────────────────────────

describe('POST /notifications/:id/read', () => {
  it('returns 401 without auth', async () => {
    await request(app.getHttpServer()).post('/notifications/n1/read').expect(401);
  });

  it('returns 200 and calls markRead for authenticated user', async () => {
    const res = await request(app.getHttpServer())
      .post('/notifications/n1/read')
      .set('x-test-role', 'student')
      .expect(200);

    expect(mockNotificationsService.markRead).toHaveBeenCalledWith('n1', 'u1');
    expect(res.body).toHaveProperty('id');
  });
});

// ── POST /notifications/mark-all-read ────────────────────────────────────────

describe('POST /notifications/mark-all-read', () => {
  it('returns 401 without auth', async () => {
    await request(app.getHttpServer()).post('/notifications/mark-all-read').expect(401);
  });

  it('returns 200 with updated count for authenticated user', async () => {
    const res = await request(app.getHttpServer())
      .post('/notifications/mark-all-read')
      .set('x-test-role', 'student')
      .expect(200);

    expect(mockNotificationsService.markAllRead).toHaveBeenCalledWith('u1');
    expect(res.body).toHaveProperty('updated');
  });
});

// ── GET /notifications/preferences ───────────────────────────────────────────

describe('GET /notifications/preferences', () => {
  it('returns 401 without auth', async () => {
    await request(app.getHttpServer()).get('/notifications/preferences').expect(401);
  });

  it('returns preferences object for authenticated user', async () => {
    const res = await request(app.getHttpServer())
      .get('/notifications/preferences')
      .set('x-test-role', 'student')
      .expect(200);

    expect(res.body).toHaveProperty('user_id');
    expect(mockNotificationsService.getPreferences).toHaveBeenCalledWith('u1');
  });
});

// ── PATCH /notifications/preferences ─────────────────────────────────────────

describe('PATCH /notifications/preferences', () => {
  it('returns 401 without auth', async () => {
    await request(app.getHttpServer()).patch('/notifications/preferences').expect(401);
  });

  it('updates preferences and returns updated object', async () => {
    const res = await request(app.getHttpServer())
      .patch('/notifications/preferences')
      .set('x-test-role', 'student')
      .send({ digest_email: false, muted: true })
      .expect(200);

    expect(mockNotificationsService.updatePreferences).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ digest_email: false, muted: true }),
    );
    expect(res.body).toHaveProperty('user_id');
  });

  it('strips unknown fields (whitelist validation)', async () => {
    await request(app.getHttpServer())
      .patch('/notifications/preferences')
      .set('x-test-role', 'student')
      .send({ digest_email: false, evil_field: 'hack' })
      .expect(200);

    const callArg = mockNotificationsService.updatePreferences.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(callArg).not.toHaveProperty('evil_field');
  });

  it('rejects invalid quiet_hours_start format', async () => {
    await request(app.getHttpServer())
      .patch('/notifications/preferences')
      .set('x-test-role', 'student')
      .send({ quiet_hours_start: '25:00' })
      .expect(400);
  });
});
