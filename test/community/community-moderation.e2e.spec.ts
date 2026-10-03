/**
 * Community v1-3 moderation — end-to-end spec.
 *
 * Mirrors the v1-3 messages harness: boots the real Nest HTTP layer for the
 * moderation sub-module wired to the real PrismaService, drives it over Node's
 * built-in http against a live disposable Postgres, and stubs ONLY JwtAuthGuard.
 * RolesGuard + CommunityFeatureFlagGuard run for real; the moderator gate is the
 * service's assertModerator (role + workspace ownership).
 *
 * GATE INTENT (R66/R69): env-gated on COMMUNITY_TEST_DATABASE_URL. Unset → the
 * whole block is describe.skip-ed with a logged reason (never a silent pass).
 *
 * Covers G9 plan case 6 ("report creates moderation action"):
 *  - A member POSTs /moderation/reports for a message → 201 with the item id.
 *  - The workspace coach GETs the queue → the reported item is present.
 *  - A student GETs the queue → 403 not_moderator.
 *  - Plus: coach hides the target via PATCH → the message read path 404s.
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
import { Role } from '@prisma/client';

import { CommunityModerationController } from '../../src/community/moderation/community-moderation.controller';
import { CommunityModerationService } from '../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../src/community/moderation/community-moderation.repository';
import { CommunityMessagesController } from '../../src/community/messages/community-messages.controller';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { PlanContextService } from '../../src/community/plan-context/plan-context.service';
import { PlanContextRepository } from '../../src/community/plan-context/plan-context.repository';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { CommunityMessagesEnabledGuard } from '../../src/community/community-write-flag.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { CommunityNotificationsService } from '../../src/community/notifications/community-notifications.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { liveDbUrl } from './_support/community-db';
import { insertLiveUsers } from './_support/community-live-seed';
import { VoiceUploadProvider } from '../../src/community/voice/voice-upload.provider';
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn('[community-moderation] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.');
}

const H_USER = 'x-test-user-id';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v1-3 moderation (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    studentA: '',
    studentA2: '',
    wsA: '',
    cohortA: '',
    messageId: '',
  };

  class StubJwtAuthGuard implements CanActivate {
    constructor(private readonly p: PrismaService) {}
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const req = ctx.switchToHttp().getRequest();
      const userId = req.headers[H_USER] as string | undefined;
      if (!userId) throw new UnauthorizedException();
      // The real guard attaches the full Prisma User row; so does the stub.
      const user = await this.p.user.findUnique({ where: { id: userId } });
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
    process.env.FEATURE_COMMUNITY_MESSAGES = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityModerationController, CommunityMessagesController],
      providers: [
        CommunityModerationService,
        CommunityModerationRepository,
        CommunityMessagesService,
        CommunityMessagesRepository,
        CommunityPostsRepository,
        // CommunityMessagesService validates plan-context tags on send.
        PlanContextService,
        PlanContextRepository,
        CommunityAccessService,
        CommunitySafetyService,
        CommunityFeatureFlagGuard,
        CommunityMessagesEnabledGuard,
        CommunityRealtimeService,
        CommunityNotificationsService,
        SupabaseService,
        AnalyticsService,
        NotificationsService,
        // Signs short-lived playback links for reported voice notes.
        VoiceUploadProvider,
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
    ids.studentA = randomUUID();
    ids.studentA2 = randomUUID();

    const users: Array<[string, Role, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
      [ids.studentA2, 'student', 'Student A2', ids.coachA],
    ];
    await insertLiveUsers(prisma, users);

    const wsA = await prisma.communityWorkspace.create({
      data: { coach_id: ids.coachA, name: 'WS A', slug: `ws-a-${tag}` },
    });
    ids.wsA = wsA.id;

    const cohortA = await prisma.communityCohort.create({
      data: { workspace_id: wsA.id, name: 'Cohort A', status: 'active', sort_order: 0 },
    });
    ids.cohortA = cohortA.id;

    for (const userId of [ids.studentA, ids.studentA2]) {
      await prisma.communityMembership.create({
        data: {
          workspace_id: wsA.id,
          cohort_id: cohortA.id,
          user_id: userId,
          role: 'student',
          status: 'active',
        },
      });
    }

    const message = await prisma.communityMessage.create({
      data: {
        workspace_id: wsA.id,
        cohort_id: cohortA.id,
        scope: 'cohort',
        kind: 'text',
        sender_id: ids.studentA2,
        body: 'reportable message',
        visibility: 'active',
      },
    });
    ids.messageId = message.id;
  }

  async function cleanup() {
    const userIds = [ids.coachA, ids.studentA, ids.studentA2].filter(Boolean);
    await prisma.notification.deleteMany({ where: { user_id: { in: userIds } } });
    await prisma.communityWorkspaceBan.deleteMany({
      where: { workspace_id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.communityModerationAction.deleteMany({
      where: { workspace_id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.communityMessage.deleteMany({
      where: { workspace_id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.communityMembership.deleteMany({
      where: { user_id: { in: userIds } },
    });
    await prisma.communityWorkspace.deleteMany({
      where: { id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  describe('report creates moderation action (G9 case 6)', () => {
    let itemId = '';

    it('1. member files a report → 201 with item id', async () => {
      const res = await call('POST', `/api/community/moderation/reports`, asUser(ids.studentA), {
        target_type: 'message',
        target_id: ids.messageId,
        reason: 'spam',
      });
      expect(res.status).toBe(201);
      expect(res.body.item.id).toBeTruthy();
      expect(res.body.item.target_id).toBe(ids.messageId);
      itemId = res.body.item.id;
    });

    it('2. workspace coach sees the report in the queue', async () => {
      const res = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}/moderation/queue`,
        asUser(ids.coachA),
      );
      expect(res.status).toBe(200);
      const itemIds = res.body.items.map((i: any) => i.id);
      expect(itemIds).toContain(itemId);
    });

    it('3. a student is not a moderator → 403 not_moderator', async () => {
      const res = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}/moderation/queue`,
        asUser(ids.studentA),
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('community.moderation.not_moderator');
    });

    it('4. coach hides the target → the message read path now 404s', async () => {
      const act = await call(
        'PATCH',
        `/api/community/moderation/items/${itemId}`,
        asUser(ids.coachA),
        { action: 'hide' },
      );
      expect(act.status).toBe(200);
      expect(act.body.item.status).toBe('actioned');

      const get = await call('GET', `/api/community/messages/${ids.messageId}`, asUser(ids.coachA));
      // Soft-hidden content: body is nulled (deleted) and still reachable, OR
      // the row is filtered — either way it is no longer live content.
      if (get.status === 200) {
        expect(get.body.message.deleted).toBe(true);
        expect(get.body.message.body).toBeNull();
      } else {
        expect(get.status).toBe(404);
      }
    });
  });

  // B-610-13 (#610 fix round 6, GPT-6.1 Sol): on real Postgres, a Ban whose
  // member-notice insert fails inside the action transaction leaves NOTHING
  // behind: no ban row, memberships still active, the content visible, the
  // report open, no notice. The failure is a real database error (a probe
  // trigger on "Notification" for this member only), not a mocked client,
  // so the rollback is Postgres's own. The retry then applies all of it.
  describe('B-610-13: Ban + member notice are one transaction (live DB)', () => {
    it('5. a notice insert that fails in Postgres rolls back the ban; the retry applies everything once', async () => {
      const message = await prisma.communityMessage.create({
        data: {
          workspace_id: ids.wsA,
          cohort_id: ids.cohortA,
          scope: 'cohort',
          kind: 'text',
          sender_id: ids.studentA2,
          body: 'second reportable message',
          visibility: 'active',
        },
      });
      const report = await call('POST', `/api/community/moderation/reports`, asUser(ids.studentA), {
        target_type: 'message',
        target_id: message.id,
        reason: 'spam',
      });
      expect(report.status).toBe(201);
      const reportId: string = report.body.item.id;

      const banCount = () =>
        prisma.communityWorkspaceBan.count({
          where: { workspace_id: ids.wsA, user_id: ids.studentA2, lifted_at: null },
        });
      const memberStatuses = async () =>
        (
          await prisma.communityMembership.findMany({
            where: { workspace_id: ids.wsA, user_id: ids.studentA2 },
            select: { status: true },
          })
        ).map((m) => m.status);
      // Notices for THIS report only: case 4's Hide already stored one for
      // this member on another report.
      const noticeCount = async () =>
        (
          await prisma.notification.findMany({
            where: { user_id: ids.studentA2 },
            select: { payload: true },
          })
        ).filter((n) => {
          const payload = n.payload;
          return (
            typeof payload === 'object' &&
            payload !== null &&
            !Array.isArray(payload) &&
            payload.moderation_action_id === reportId
          );
        }).length;
      const messageRow = () =>
        prisma.communityMessage.findFirst({
          where: { id: message.id },
          select: { deleted_at: true },
        });
      const reportRow = () =>
        prisma.communityModerationAction.findUnique({
          where: { id: reportId },
          select: { status: true, action: true },
        });

      const probe = `b610_13_notice_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION ${probe}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B-610-13 probe: notice insert refused'; END $$`,
      );
      try {
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER ${probe} BEFORE INSERT ON "Notification" FOR EACH ROW WHEN (NEW.user_id = '${ids.studentA2}') EXECUTE FUNCTION ${probe}()`,
        );
        const failed = await call(
          'PATCH',
          `/api/community/moderation/items/${reportId}`,
          asUser(ids.coachA),
          { action: 'ban' },
        );
        expect(failed.status).toBe(500);
        expect(await banCount()).toBe(0);
        expect(await memberStatuses()).toEqual(['active']);
        expect((await messageRow())?.deleted_at).toBeNull();
        expect(await reportRow()).toEqual({ status: 'open', action: null });
        expect(await noticeCount()).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${probe} ON "Notification"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${probe}()`);
      }

      const retried = await call(
        'PATCH',
        `/api/community/moderation/items/${reportId}`,
        asUser(ids.coachA),
        { action: 'ban' },
      );
      expect(retried.status).toBe(200);
      expect(retried.body.item).toMatchObject({ status: 'actioned', action: 'ban' });
      expect(retried.body.member_notice.stored).toBe(true);
      expect(await banCount()).toBe(1);
      expect(await memberStatuses()).toEqual(['removed']);
      expect((await messageRow())?.deleted_at).toBeInstanceOf(Date);
      expect(await noticeCount()).toBe(1);
    });
  });
});
