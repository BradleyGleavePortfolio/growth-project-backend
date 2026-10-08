// GUIDE-READ-128 (FW-TRAIN-128 U1): a client can read the guidelines their
// coach wrote for them. The app is built from CoachModule's own controllers
// that serve a guidelines route, behind the real CoachGuard, RolesGuard and
// ClientEntitlementGuard; only JwtAuthGuard is swapped for a header double.
// On main the only handler for GET /coach/my-guidelines sits behind the
// class-level CoachGuard, so the client cases below fail there with 403.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { CanActivate, ExecutionContext, INestApplication, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { CoachModule } from '../src/coach/coach.module';
import { CoachService } from '../src/coach/coach.service';
import { PrismaService } from '../src/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ConsentService } from '../src/consent/consent.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AdminPtmService } from '../src/admin/ptm/admin-ptm.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';

/** `x-test-user: <id>:<role>` becomes req.user. */
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const [id, role] = String(req.headers['x-test-user']).split(':');
    req.user = { id, role };
    return true;
  }
}

const coachOf: Record<string, string | null> = { 'client-1': 'coach-1', 'client-2': 'coach-1', 'client-solo': null };
const guidelines: Record<string, { content: string; created_at: Date; updated_at: Date }> = {
  'coach-1:client-1': {
    content: 'Walk 20 minutes after dinner.',
    created_at: new Date('2026-10-01T12:00:00.000Z'),
    updated_at: new Date('2026-10-03T09:30:00.000Z'),
  },
};
const prisma = {
  user: {
    findUnique: jest.fn(async (args: { where: { id: string } }) =>
      args.where.id in coachOf ? { coach_id: coachOf[args.where.id] } : null,
    ),
  },
  coachGuideline: {
    findUnique: jest.fn(
      async (args: { where: { CoachGuideline_coach_client_key: { coach_id: string; client_id: string } } }) => {
        const key = args.where.CoachGuideline_coach_client_key;
        return guidelines[`${key.coach_id}:${key.client_id}`] ?? null;
      },
    ),
  },
  // ClientEntitlementGuard: every client has an active package except client-unpaid.
  clientPurchase: {
    findFirst: jest.fn(async (args: { where: { client_user_id: string } }) =>
      args.where.client_user_id === 'client-unpaid' ? null : { id: 'p1', status: 'active', access_expires_at: null },
    ),
  },
};

describe('GET /coach/my-guidelines: a client reads their coach guidelines', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const all: Type[] = Reflect.getMetadata('controllers', CoachModule);
    const controllers = all.filter((c) =>
      Object.getOwnPropertyNames(c.prototype).some((m) =>
        String(Reflect.getMetadata('path', c.prototype[m]) ?? '').includes('guidelines'),
      ),
    );
    const ref = await Test.createTestingModule({
      controllers,
      providers: [
        CoachService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ConsentService, useValue: {} },
        { provide: SubCoachScopeService, useValue: {} },
        { provide: AnalyticsService, useValue: { capture: jest.fn() } },
        { provide: AdminPtmService, useValue: {} },
        // Same global order as AppModule: auth first, then RolesGuard.
        { provide: APP_GUARD, useClass: HeaderAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const call = async (user: string, path = '/coach/my-guidelines', init: RequestInit = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { 'x-test-user': user, 'content-type': 'application/json' } });
    return { status: r.status, text: await r.text() };
  };

  it('a client gets the guideline their current coach wrote: the text and its dates, nothing else', async () => {
    const r = await call('client-1:student');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      description: 'Walk 20 minutes after dinner.',
      created_at: '2026-10-01T12:00:00.000Z',
      updated_at: '2026-10-03T09:30:00.000Z',
    });
    expect(prisma.coachGuideline.findUnique).toHaveBeenCalledWith({
      where: { CoachGuideline_coach_client_key: { coach_id: 'coach-1', client_id: 'client-1' } },
      select: { content: true, created_at: true, updated_at: true },
    });
  });

  it('nothing written yet, or no coach: 200 with an empty body (the app shows "No guidelines yet")', async () => {
    expect(await call('client-2:student')).toEqual({ status: 200, text: '' });
    expect(await call('client-solo:student')).toEqual({ status: 200, text: '' });
  });

  it("a client cannot ask for another client's guideline: only the signed-in id is read", async () => {
    expect(await call('client-2:student', '/coach/my-guidelines?client_id=client-1&coach_id=coach-1')).toEqual({
      status: 200,
      text: '',
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'client-2' }, select: { coach_id: true } });
  });

  it('a client without an active package gets the paywall (402), like the rest of Train, and nothing is read', async () => {
    expect((await call('client-unpaid:student')).status).toBe(402);
    expect(prisma.coachGuideline.findUnique).not.toHaveBeenCalled();
  });

  it('the coach-side guideline routes stay coach-only', async () => {
    expect((await call('client-1:student', '/coach/guidelines/client-1')).status).toBe(403);
    const post = { method: 'POST', body: JSON.stringify({ guidelines: 'Eat more.' }) };
    expect((await call('client-1:student', '/coach/guidelines/client-1', post)).status).toBe(403);
    expect(prisma.coachGuideline.findUnique).not.toHaveBeenCalled();
  });
});
