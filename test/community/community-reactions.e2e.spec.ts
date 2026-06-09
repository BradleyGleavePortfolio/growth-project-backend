/**
 * Community v1-3 reactions — end-to-end spec.
 *
 * Mirrors the v1-3 messages harness: boots the real Nest HTTP layer for the
 * reactions sub-module wired to the real PrismaService, drives it over Node's
 * built-in http against a live disposable Postgres, and stubs ONLY JwtAuthGuard.
 *
 * GATE INTENT (R66/R69): env-gated on COMMUNITY_TEST_DATABASE_URL. Unset → the
 * whole block is describe.skip-ed with a logged reason (never a silent pass).
 *
 * Covers G9 plan case 5 ("reaction idempotency"):
 *  - POST the same emoji on a message twice → both 200, count stays 1.
 *  - DELETE the same emoji twice → both 200, no error on the second.
 *  - Same idempotency on a post target.
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

import { CommunityReactionsController } from '../../src/community/reactions/community-reactions.controller';
import { CommunityReactionsService } from '../../src/community/reactions/community-reactions.service';
import { CommunityReactionsRepository } from '../../src/community/reactions/community-reactions.repository';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../../src/community/posts/community-posts.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { CommunityRealtimeService } from '../../src/community/realtime/community-realtime.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { liveDbUrl } from './_support/community-db';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-reactions] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.',
  );
}

const H_USER = 'x-test-user-id';
const EMOJI = '👍';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v1-3 reactions (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    studentA: '',
    wsA: '',
    cohortA: '',
    messageId: '',
    postId: '',
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

  function emojiCount(body: any): number {
    const row = (body.reactions ?? []).find((r: any) => r.emoji === EMOJI);
    return row ? row.count : 0;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = liveDbUrl() as string;
    process.env.FEATURE_COMMUNITY_API = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityReactionsController],
      providers: [
        CommunityReactionsService,
        CommunityReactionsRepository,
        CommunityMessagesRepository,
        CommunityPostsRepository,
        CommunityAccessService,
        CommunityFeatureFlagGuard,
        CommunityRealtimeService,
        SupabaseService,
        AnalyticsService,
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

    const users: Array<[string, string, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
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
    ids.wsA = wsA.id;

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

    const message = await prisma.communityMessage.create({
      data: {
        workspace_id: wsA.id,
        cohort_id: cohortA.id,
        scope: 'cohort',
        kind: 'text',
        sender_id: ids.studentA,
        body: 'reactable message',
        visibility: 'active',
      },
    });
    ids.messageId = message.id;

    const post = await prisma.communityPost.create({
      data: {
        workspace_id: wsA.id,
        cohort_id: cohortA.id,
        scope: 'cohort',
        type: 'text',
        author_id: ids.coachA,
        title: 'reactable post',
        body: 'post body',
        visibility: 'active',
      },
    });
    ids.postId = post.id;
  }

  async function cleanup() {
    const userIds = [ids.coachA, ids.studentA].filter(Boolean);
    await prisma.communityResponse.deleteMany({
      where: { workspace_id: { in: [ids.wsA].filter(Boolean) } },
    });
    await prisma.communityPost.deleteMany({
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

  describe('message reaction idempotency (G9 case 5)', () => {
    it('1. POST same emoji twice → both 200, count stays 1', async () => {
      const first = await call(
        'POST',
        `/api/community/messages/${ids.messageId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(first.status).toBe(201);
      expect(emojiCount(first.body)).toBe(1);

      const second = await call(
        'POST',
        `/api/community/messages/${ids.messageId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(second.status).toBe(201);
      expect(emojiCount(second.body)).toBe(1);
    });

    it('2. DELETE same emoji twice → both 200, no error on the second', async () => {
      const first = await call(
        'DELETE',
        `/api/community/messages/${ids.messageId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(first.status).toBe(200);
      expect(emojiCount(first.body)).toBe(0);

      const second = await call(
        'DELETE',
        `/api/community/messages/${ids.messageId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(second.status).toBe(200);
      expect(emojiCount(second.body)).toBe(0);
    });
  });

  describe('post reaction idempotency (G9 case 5)', () => {
    it('3. POST same emoji twice on a post → both 200, count stays 1', async () => {
      const first = await call(
        'POST',
        `/api/community/posts/${ids.postId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(first.status).toBe(201);
      expect(emojiCount(first.body)).toBe(1);

      const second = await call(
        'POST',
        `/api/community/posts/${ids.postId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(second.status).toBe(201);
      expect(emojiCount(second.body)).toBe(1);
    });

    it('4. DELETE never-added emoji is a no-op 200', async () => {
      const del = await call(
        'DELETE',
        `/api/community/posts/${ids.postId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(del.status).toBe(200);
      const again = await call(
        'DELETE',
        `/api/community/posts/${ids.postId}/reactions`,
        asUser(ids.studentA),
        { emoji: EMOJI },
      );
      expect(again.status).toBe(200);
      expect(emojiCount(again.body)).toBe(0);
    });
  });
});
