/**
 * Community v1-3 Lab posts + comments — end-to-end spec.
 *
 * Mirrors the v1-2 foundation harness: real Nest HTTP layer for the posts
 * sub-module + real PrismaService over a live disposable Postgres; only
 * JwtAuthGuard is stubbed (header-driven). env-gated on
 * COMMUNITY_TEST_DATABASE_URL; unset → describe.skip with a logged reason (R66).
 *
 * Covers the brief's named post cases: coach creates a post (201), a client's
 * create is rejected (403, clientPostsEnabled default off — see service
 * docblock), any active member may comment (201), plus cross-tenant non-leak and
 * the kill-switch matrix (post writes gated by FEATURE_COMMUNITY_POSTS, comment
 * writes by FEATURE_COMMUNITY_MESSAGES, reads survive both).
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

import { CommunityPostsController } from '../../src/community/posts/community-posts.controller';
import { CommunityPostsService } from '../../src/community/posts/community-posts.service';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import {
  CommunityMessagesEnabledGuard,
  CommunityPostsEnabledGuard,
} from '../../src/community/community-write-flag.guard';
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
import { CommunitySafetyService } from '../../src/community/safety/community-safety.service';
import { CommunityController } from '../../src/community/community.controller';
import { CommunityService } from '../../src/community/community.service';
import { CommunityRepository } from '../../src/community/community.repository';
import { ClientEntitlementGuard } from '../../src/common/guards/client-entitlement.guard';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn('[community-posts] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.');
}

const H_USER = 'x-test-user-id';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v1-3 Lab posts + comments (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    coachB: '',
    studentA: '',
    studentB: '',
    coachNoSpace: '',
    studentNoSpace: '',
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
    process.env.FEATURE_COMMUNITY_POSTS = 'true';
    process.env.FEATURE_COMMUNITY_MESSAGES = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityPostsController, CommunityController],
      providers: [
        CommunityService,
        CommunityRepository,
        ClientEntitlementGuard,
        CommunityPostsService,
        CommunityPostsRepository,
        CommunityMessagesRepository,
        CommunityReactionsRepository,
        CommunityAccessService,
        CommunitySafetyService,
        CommunityFeatureFlagGuard,
        CommunityPostsEnabledGuard,
        CommunityMessagesEnabledGuard,
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
    ids.coachNoSpace = randomUUID();
    ids.studentNoSpace = randomUUID();

    const users: Array<[string, Role, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.coachB, 'coach', 'Coach B', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
      [ids.studentB, 'student', 'Student B', ids.coachB],
      // B-E2E-1: a coach with no community space and one client.
      [ids.coachNoSpace, 'coach', 'Coach C', null],
      [ids.studentNoSpace, 'student', 'Student C', ids.coachNoSpace],
    ];
    await insertLiveUsers(prisma, users);

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
    const userIds = [
      ids.coachA,
      ids.coachB,
      ids.studentA,
      ids.studentB,
      ids.coachNoSpace,
      ids.studentNoSpace,
    ].filter(Boolean);
    // Includes the space /community/me created for coachNoSpace (B-E2E-1).
    const created = ids.coachNoSpace
      ? await prisma.communityWorkspace.findMany({
          where: { coach_id: ids.coachNoSpace },
          select: { id: true },
        })
      : [];
    const wsIds = [ids.wsA, ids.wsB, ...created.map((w) => w.id)].filter(Boolean);
    await prisma.communityMessage.deleteMany({
      where: { workspace_id: { in: wsIds } },
    });
    await prisma.communityPost.deleteMany({
      where: { workspace_id: { in: wsIds } },
    });
    await prisma.communityMembership.deleteMany({
      where: { user_id: { in: userIds } },
    });
    await prisma.communityWorkspace.deleteMany({
      where: { id: { in: wsIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  async function createPostAsCoach(): Promise<string> {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/posts`,
      asUser(ids.coachA),
      { title: 'Lab Post', body: 'first post body' },
    );
    return res.body.post.id;
  }

  it('1. coach creates a post → 201', async () => {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/posts`,
      asUser(ids.coachA),
      { title: 'Welcome', body: 'intro' },
    );
    expect(res.status).toBe(201);
    expect(res.body.post.title).toBe('Welcome');
    expect(res.body.post.author_user_id).toBe(ids.coachA);
  });

  it('2. an active member (client) creates a post → 201 (B-E2E-1)', async () => {
    const res = await call(
      'POST',
      `/api/community/workspaces/${ids.wsA}/posts`,
      asUser(ids.studentA),
      { title: 'Client post', body: 'first week done' },
    );
    expect(res.status).toBe(201);
    expect(res.body.post.author_user_id).toBe(ids.studentA);
  });

  it('2b. B-E2E-1: client of a coach with no space gets one on /me and can post → 201', async () => {
    const before = await prisma.communityWorkspace.count({
      where: { coach_id: ids.coachNoSpace },
    });
    expect(before).toBe(0);

    const me = await call('GET', '/api/community/me', asUser(ids.studentNoSpace));
    expect(me.status).toBe(200);
    expect(me.body.workspace_id).toEqual(expect.any(String));
    expect(me.body.membership).not.toBeNull();
    expect(me.body.membership.role).toBe('client');
    const workspaceId: string = me.body.workspace_id;

    const ws = await prisma.communityWorkspace.findUnique({ where: { id: workspaceId } });
    expect(ws?.coach_id).toBe(ids.coachNoSpace);
    expect(ws?.slug).toBe(`coach-${ids.coachNoSpace}`);
    expect(ws?.name).toBe('Community');
    const cohorts = await prisma.communityCohort.findMany({
      where: { workspace_id: workspaceId },
    });
    expect(cohorts.map((c) => [c.name, c.sort_order])).toEqual([['All members', 0]]);

    // Second open and the coach's own open land on the same space.
    const again = await call('GET', '/api/community/me', asUser(ids.studentNoSpace));
    expect(again.body.workspace_id).toBe(workspaceId);
    const coachMe = await call('GET', '/api/community/me', asUser(ids.coachNoSpace));
    expect(coachMe.status).toBe(200);
    expect(coachMe.body.workspace_id).toBe(workspaceId);
    expect(await prisma.communityWorkspace.count({ where: { coach_id: ids.coachNoSpace } })).toBe(
      1,
    );

    const post = await call(
      'POST',
      `/api/community/workspaces/${workspaceId}/posts`,
      asUser(ids.studentNoSpace),
      { title: 'Hello', body: 'first post in the Hall' },
    );
    expect(post.status).toBe(201);
    expect(post.body.post.workspace_id).toBe(workspaceId);

    // Another coach's client still cannot post there.
    const foreign = await call(
      'POST',
      `/api/community/workspaces/${workspaceId}/posts`,
      asUser(ids.studentB),
      { title: 'Nope', body: 'not my space' },
    );
    expect(foreign.status).toBe(404);
  });

  it('3. any active member may comment → 201', async () => {
    const postId = await createPostAsCoach();
    const res = await call(
      'POST',
      `/api/community/posts/${postId}/comments`,
      asUser(ids.studentA),
      { body: 'great post' },
    );
    expect(res.status).toBe(201);
    expect(res.body.comment.body).toBe('great post');
    expect(res.body.comment.post_id).toBe(postId);
  });

  it('4. cross-tenant: foreign student cannot read post → 404', async () => {
    const postId = await createPostAsCoach();
    const res = await call('GET', `/api/community/posts/${postId}`, asUser(ids.studentB));
    expect(res.status).toBe(404);
  });

  it('5. cross-tenant: foreign student cannot comment → 404', async () => {
    const postId = await createPostAsCoach();
    const res = await call(
      'POST',
      `/api/community/posts/${postId}/comments`,
      asUser(ids.studentB),
      { body: 'intruder' },
    );
    expect(res.status).toBe(404);
  });

  it('6. post list readable by member', async () => {
    await createPostAsCoach();
    const res = await call(
      'GET',
      `/api/community/workspaces/${ids.wsA}/posts`,
      asUser(ids.studentA),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.posts)).toBe(true);
    expect(res.body.posts.length).toBeGreaterThan(0);
  });

  it('7. kill switch: POSTS flag off → post create 503, reads survive', async () => {
    process.env.FEATURE_COMMUNITY_POSTS = 'false';
    try {
      const write = await call(
        'POST',
        `/api/community/workspaces/${ids.wsA}/posts`,
        asUser(ids.coachA),
        { title: 'blocked', body: 'x' },
      );
      expect(write.status).toBe(503);

      const read = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}/posts`,
        asUser(ids.studentA),
      );
      expect(read.status).toBe(200);
    } finally {
      process.env.FEATURE_COMMUNITY_POSTS = 'true';
    }
  });

  it('8. kill switch: MESSAGES flag off → comment create 503', async () => {
    const postId = await createPostAsCoach();
    process.env.FEATURE_COMMUNITY_MESSAGES = 'false';
    try {
      const res = await call(
        'POST',
        `/api/community/posts/${postId}/comments`,
        asUser(ids.studentA),
        { body: 'blocked comment' },
      );
      expect(res.status).toBe(503);
    } finally {
      process.env.FEATURE_COMMUNITY_MESSAGES = 'true';
    }
  });

  it('9. posts and replies show the author first name and the stored reactions (CF-COMM-BE-128)', async () => {
    const postId = await createPostAsCoach();
    await prisma.communityResponse.create({
      data: {
        workspace_id: ids.wsA,
        target_type: 'post',
        target_id: postId,
        user_id: ids.studentA,
        response_kind: '👍',
      },
    });
    const reply = await call(
      'POST',
      `/api/community/posts/${postId}/comments`,
      asUser(ids.studentA),
      { body: 'on it' },
    );
    expect(reply.status).toBe(201);
    expect(reply.body.comment.author_name).toBe('Student');
    expect(reply.body.comment.reactions).toEqual([]);

    const mine = await call('GET', `/api/community/posts/${postId}`, asUser(ids.studentA));
    expect(mine.status).toBe(200);
    expect(mine.body.post.author_name).toBe('Coach');
    expect(mine.body.post.reactions).toEqual([{ emoji: '👍', count: 1, reacted_by_me: true }]);

    const feed = await call('GET', `/api/community/workspaces/${ids.wsA}/posts`, asUser(ids.coachA));
    expect(feed.status).toBe(200);
    const row = feed.body.posts.find((p: { id: string }) => p.id === postId);
    expect(row.author_name).toBe('Coach');
    expect(row.reactions).toEqual([{ emoji: '👍', count: 1, reacted_by_me: false }]);

    const thread = await call('GET', `/api/community/posts/${postId}/comments`, asUser(ids.coachA));
    expect(thread.status).toBe(200);
    expect(thread.body.comments.map((c: { author_name: string }) => c.author_name)).toEqual([
      'Student',
    ]);
    // Full names never leave the API on these surfaces.
    expect(JSON.stringify([reply.body, mine.body, feed.body, thread.body])).not.toMatch(
      /Coach A|Student A/,
    );
  });
});
