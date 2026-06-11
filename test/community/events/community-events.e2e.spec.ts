/**
 * Community v2-3 event objects — end-to-end spec.
 *
 * Mirrors the v1-3 posts harness: real Nest HTTP layer for the events
 * sub-module over a live disposable Postgres; only JwtAuthGuard is stubbed
 * (header-driven). env-gated on COMMUNITY_TEST_DATABASE_URL; unset →
 * describe.skip with a logged reason (R66).
 *
 * Covers the brief's named cases that need a real DB: coach create (201),
 * client create 403, RSVP create/withdraw, replay attach → replay state,
 * reflect → reflected state, cross-tenant 403/404 non-leak (mirrors v1-2
 * doctrine), and the FEATURE_COMMUNITY_EVENTS kill-switch matrix (writes 503,
 * reads survive).
 */

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import * as http from 'http';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { CommunityEventsController } from '../../../src/community/events/community-events.controller';
import { CommunityEventsService } from '../../../src/community/events/community-events.service';
import { CommunityEventsRepository } from '../../../src/community/events/community-events.repository';
import { CommunityEventsEnabledGuard } from '../../../src/community/events/community-events-flag.guard';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../../src/community/community-feature-flag.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../../src/auth/auth.guard';
import { PrismaService } from '../../../src/prisma.service';
import { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { SupabaseService } from '../../../src/supabase/supabase.service';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { liveDbUrl } from '../_support/community-db';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-events] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.',
  );
}

const H_USER = 'x-test-user-id';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v2-3 events (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    coachB: '',
    studentA: '',
    studentB: '',
    wsA: '',
    wsB: '',
    cohortA: '',
  };

  class StubJwtAuthGuard implements CanActivate {
    constructor(private readonly p: PrismaService) {}
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const req = ctx.switchToHttp().getRequest();
      const userId = req.headers[H_USER] as string | undefined;
      if (!userId) throw new UnauthorizedException();
      const rows = await this.p.$queryRaw<
        Array<{ id: string; role: string; coach_id: string | null }>
      >`SELECT id, role, coach_id FROM "User" WHERE id = ${userId} LIMIT 1`;
      const user = rows[0];
      if (!user) throw new UnauthorizedException();
      req.user = user;
      return true;
    }
  }

  function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const h: Record<string, string> = { ...headers };
      if (payload !== undefined) {
        h['content-type'] = 'application/json';
        h['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(`${baseUrl}${path}`, { method, headers: h }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data.length ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const asUser = (id: string) => ({ [H_USER]: id });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = liveDbUrl() as string;
    process.env.FEATURE_COMMUNITY_API = 'true';
    process.env.FEATURE_COMMUNITY_EVENTS = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityEventsController],
      providers: [
        CommunityEventsService,
        CommunityEventsRepository,
        CommunityAccessService,
        CommunityFeatureFlagGuard,
        CommunityEventsEnabledGuard,
        CommunityRealtimeService,
        CommunityNotificationsService,
        SupabaseService,
        AnalyticsService,
        NotificationsService,
        Reflector,
        { provide: PrismaService, useValue: prismaForStub },
        { provide: APP_GUARD, useValue: new StubJwtAuthGuard(prismaForStub) },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtAuthGuard(prismaForStub))
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    prisma = prismaForStub;
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    if (app) await app.close();
  });

  async function seed() {
    const tag = randomUUID().slice(0, 8);
    ids.coachA = randomUUID();
    ids.coachB = randomUUID();
    ids.studentA = randomUUID();
    ids.studentB = randomUUID();

    const users: Array<[string, string, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.coachB, 'coach', 'Coach B', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
      [ids.studentB, 'student', 'Student B', ids.coachB],
    ];
    for (const [id, role, name, coachId] of users) {
      await prisma.$executeRaw`
        INSERT INTO "User" (id, role, name, coach_id)
        VALUES (${id}, ${role}, ${name}, ${coachId})
      `;
    }

    const wsA = await prisma.communityWorkspace.create({
      data: { coach_id: ids.coachA, name: 'WS A', slug: `ws-a-${tag}` },
    });
    const wsB = await prisma.communityWorkspace.create({
      data: { coach_id: ids.coachB, name: 'WS B', slug: `ws-b-${tag}` },
    });
    ids.wsA = wsA.id;
    ids.wsB = wsB.id;

    const cohortA = await prisma.communityCohort.create({
      data: { workspace_id: wsA.id, name: 'Cohort A', status: 'active', sort_order: 0 },
    });
    ids.cohortA = cohortA.id;

    await prisma.communityMembership.create({
      data: {
        workspace_id: wsA.id,
        cohort_id: cohortA.id,
        user_id: ids.studentA,
        role: 'student',
        status: 'active',
      },
    });
  }

  async function cleanup() {
    const userIds = [ids.coachA, ids.coachB, ids.studentA, ids.studentB].filter(
      Boolean,
    );
    const wsIds = [ids.wsA, ids.wsB].filter(Boolean);
    await prisma.communityEventRsvp.deleteMany({
      where: { workspace_id: { in: wsIds } },
    });
    await prisma.communityEvent.deleteMany({
      where: { workspace_id: { in: wsIds } },
    });
    await prisma.communityMembership.deleteMany({
      where: { user_id: { in: userIds } },
    });
    await prisma.communityWorkspace.deleteMany({ where: { id: { in: wsIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const futureIso = (hoursFromNow: number) =>
    new Date(Date.now() + hoursFromNow * 3600_000).toISOString();

  async function createEventAsCoach(
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/events`,
      asUser(ids.coachA),
      { title: 'Form Check Friday', starts_at: futureIso(48), ...over },
    );
    return res.body.event.id;
  }

  it('1. coach creates an event → 201 scheduled', async () => {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/events`,
      asUser(ids.coachA),
      { title: 'Live Q&A', starts_at: futureIso(72) },
    );
    expect(res.status).toBe(201);
    expect(res.body.event.state).toBe('scheduled');
    expect(res.body.event.created_by_user_id).toBe(ids.coachA);
  });

  it('2. client create → 403 coach_only', async () => {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/events`,
      asUser(ids.studentA),
      { title: 'nope', starts_at: futureIso(24) },
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('community.event.coach_only');
  });

  it('3. client RSVPs going then withdraws to declined', async () => {
    const eventId = await createEventAsCoach();
    const going = await call(
      'POST',
      `/api/community/events/${eventId}/rsvp`,
      asUser(ids.studentA),
      { status: 'going' },
    );
    expect(going.status).toBe(201);
    expect(going.body.rsvp.status).toBe('going');

    const declined = await call(
      'POST',
      `/api/community/events/${eventId}/rsvp`,
      asUser(ids.studentA),
      { status: 'declined' },
    );
    expect(declined.status).toBe(201);
    expect(declined.body.rsvp.status).toBe('declined');

    const detail = await call(
      'GET',
      `/api/community/events/${eventId}`,
      asUser(ids.studentA),
    );
    expect(detail.body.event.viewer_rsvp_status).toBe('declined');
    expect(detail.body.event.rsvp_counts.declined).toBe(1);
  });

  it('4. client cannot self-assert attended → 400', async () => {
    const eventId = await createEventAsCoach();
    const res = await call(
      'POST',
      `/api/community/events/${eventId}/rsvp`,
      asUser(ids.studentA),
      { status: 'attended' },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('community.event.invalid_rsvp_status');
  });

  it('5. lifecycle: live → replay (external link) → reflected', async () => {
    const eventId = await createEventAsCoach();
    const live = await call(
      'PATCH',
      `/api/community/events/${eventId}`,
      asUser(ids.coachA),
      { state: 'live' },
    );
    expect(live.body.event.state).toBe('live');

    const replay = await call(
      'POST',
      `/api/community/events/${eventId}/replay`,
      asUser(ids.coachA),
      { replay_url: 'https://vimeo.com/987654321' },
    );
    expect(replay.status).toBe(201);
    expect(replay.body.event.state).toBe('replay');
    expect(replay.body.event.external_url).toContain('vimeo.com');

    const reflected = await call(
      'POST',
      `/api/community/events/${eventId}/reflect`,
      asUser(ids.coachA),
      {},
    );
    expect(reflected.status).toBe(201);
    expect(reflected.body.event.state).toBe('reflected');
    expect(reflected.body.event.reflected_at).not.toBeNull();
  });

  it('6. illegal backward transition → 400', async () => {
    const eventId = await createEventAsCoach();
    await call('PATCH', `/api/community/events/${eventId}`, asUser(ids.coachA), {
      state: 'live',
    });
    const back = await call(
      'PATCH',
      `/api/community/events/${eventId}`,
      asUser(ids.coachA),
      { state: 'scheduled' },
    );
    expect(back.status).toBe(400);
    expect(back.body.code).toBe('community.event.illegal_transition');
  });

  it('7. off-allowlist link rejected → 400', async () => {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/events`,
      asUser(ids.coachA),
      {
        title: 'bad link',
        starts_at: futureIso(24),
        live_url: 'https://evil.example.com/x',
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('community.event.invalid_link');
  });

  it('8. cross-tenant: foreign student cannot read event → 404', async () => {
    const eventId = await createEventAsCoach();
    const res = await call(
      'GET',
      `/api/community/events/${eventId}`,
      asUser(ids.studentB),
    );
    expect(res.status).toBe(404);
  });

  it('9. cross-tenant: foreign student cannot RSVP → 404', async () => {
    const eventId = await createEventAsCoach();
    const res = await call(
      'POST',
      `/api/community/events/${eventId}/rsvp`,
      asUser(ids.studentB),
      { status: 'going' },
    );
    expect(res.status).toBe(404);
  });

  it('10. cross-tenant: foreign coach cannot transition another tenant event → 403', async () => {
    const eventId = await createEventAsCoach();
    const res = await call(
      'PATCH',
      `/api/community/events/${eventId}`,
      asUser(ids.coachB),
      { state: 'live' },
    );
    // coachB has no access to wsA → resolves as 404 (existence not leaked).
    expect(res.status).toBe(404);
  });

  it('11. kill switch: EVENTS flag off → writes 503, reads survive', async () => {
    const eventId = await createEventAsCoach();
    process.env.FEATURE_COMMUNITY_EVENTS = 'false';
    try {
      const write = await call(
        'POST',
        `/api/community/workspaces/${ids.wsA}/events`,
        asUser(ids.coachA),
        { title: 'blocked', starts_at: futureIso(24) },
      );
      expect(write.status).toBe(503);

      const rsvp = await call(
        'POST',
        `/api/community/events/${eventId}/rsvp`,
        asUser(ids.studentA),
        { status: 'going' },
      );
      expect(rsvp.status).toBe(503);

      const read = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}/events`,
        asUser(ids.studentA),
      );
      expect(read.status).toBe(200);
      const detail = await call(
        'GET',
        `/api/community/events/${eventId}`,
        asUser(ids.studentA),
      );
      expect(detail.status).toBe(200);
    } finally {
      process.env.FEATURE_COMMUNITY_EVENTS = 'true';
    }
  });
});
