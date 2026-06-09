/**
 * Community v1-3 cohort messages — end-to-end spec.
 *
 * Mirrors the v1-2 foundation harness (community-foundation.e2e.spec.ts): boots
 * the real Nest HTTP layer for the messages sub-module wired to the real
 * PrismaService, drives it over Node's built-in http against a live disposable
 * Postgres, and stubs ONLY JwtAuthGuard (header-driven). RolesGuard,
 * CommunityFeatureFlagGuard and the message write kill switch all run for real.
 *
 * GATE INTENT (R66/R69): env-gated on COMMUNITY_TEST_DATABASE_URL. Unset → the
 * whole block is describe.skip-ed with a logged reason (never a silent pass).
 *
 * Covers: send/list/get/edit/delete, author-only edit window, moderator delete,
 * cross-tenant non-leak (404 not 403), and the kill-switch matrix (writes 503
 * when FEATURE_COMMUNITY_MESSAGES off, reads survive).
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

import { CommunityMessagesController } from '../../src/community/messages/community-messages.controller';
import { CommunityMessagesService } from '../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../src/community/messages/community-messages.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { CommunityMessagesEnabledGuard } from '../../src/community/community-write-flag.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { liveDbUrl } from './_support/community-db';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-messages] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.',
  );
}

const H_USER = 'x-test-user-id';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v1-3 cohort messages (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    coachB: '',
    studentA: '',
    studentA2: '',
    studentB: '',
    wsA: '',
    wsB: '',
    cohortA: '',
    cohortB: '',
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
    process.env.FEATURE_COMMUNITY_MESSAGES = 'true';
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityMessagesController],
      providers: [
        CommunityMessagesService,
        CommunityMessagesRepository,
        CommunityAccessService,
        CommunityFeatureFlagGuard,
        CommunityMessagesEnabledGuard,
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
    ids.studentA2 = randomUUID();
    ids.studentB = randomUUID();

    const users: Array<[string, string, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.coachB, 'coach', 'Coach B', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
      [ids.studentA2, 'student', 'Student A2', ids.coachA],
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
    const cohortB = await prisma.communityCohort.create({
      data: { workspace_id: wsB.id, name: 'Cohort B', status: 'active', sort_order: 0 },
    });
    ids.cohortA = cohortA.id;
    ids.cohortB = cohortB.id;

    for (const [cohortId, wsId, userId] of [
      [ids.cohortA, ids.wsA, ids.studentA],
      [ids.cohortA, ids.wsA, ids.studentA2],
      [ids.cohortB, ids.wsB, ids.studentB],
    ] as const) {
      await prisma.communityMembership.create({
        data: {
          workspace_id: wsId,
          cohort_id: cohortId,
          user_id: userId,
          role: 'student',
          status: 'active',
        },
      });
    }
  }

  async function cleanup() {
    const userIds = [
      ids.coachA,
      ids.coachB,
      ids.studentA,
      ids.studentA2,
      ids.studentB,
    ].filter(Boolean);
    await prisma.communityMessage.deleteMany({
      where: { workspace_id: { in: [ids.wsA, ids.wsB].filter(Boolean) } },
    });
    await prisma.communityMembership.deleteMany({
      where: { user_id: { in: userIds } },
    });
    await prisma.communityWorkspace.deleteMany({
      where: { id: { in: [ids.wsA, ids.wsB].filter(Boolean) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  it('1. anonymous send → 401', async () => {
    const res = await call('POST', `/api/community/cohorts/${ids.cohortA}/messages`, {}, {
      body: 'hi',
    });
    expect(res.status).toBe(401);
  });

  it('2. member sends + lists their cohort message', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA),
      { body: 'hello cohort' },
    );
    expect(sent.status).toBe(201);
    expect(sent.body.message.body).toBe('hello cohort');

    const list = await call(
      'GET',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA2),
    );
    expect(list.status).toBe(200);
    const bodies = list.body.messages.map((m: any) => m.body);
    expect(bodies).toContain('hello cohort');
  });

  it('3. cross-tenant: student B cannot read cohort A → 404', async () => {
    const res = await call(
      'GET',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentB),
    );
    expect(res.status).toBe(404);
  });

  it('4. cross-tenant: student B cannot send into cohort A → 404', async () => {
    const res = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentB),
      { body: 'intruder' },
    );
    expect(res.status).toBe(404);
  });

  it('5. author edits own message; non-author cannot', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA),
      { body: 'editable' },
    );
    const id = sent.body.message.id;

    const edit = await call(
      'PATCH',
      `/api/community/messages/${id}`,
      asUser(ids.studentA),
      { body: 'edited' },
    );
    expect(edit.status).toBe(200);
    expect(edit.body.message.body).toBe('edited');

    const foreignEdit = await call(
      'PATCH',
      `/api/community/messages/${id}`,
      asUser(ids.studentA2),
      { body: 'hijack' },
    );
    expect([403, 404]).toContain(foreignEdit.status);
  });

  it('6. coach (moderator) can delete a member message; idempotent', async () => {
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA),
      { body: 'deletable' },
    );
    const id = sent.body.message.id;

    const del = await call('DELETE', `/api/community/messages/${id}`, asUser(ids.coachA));
    expect(del.status).toBe(200);

    const again = await call('DELETE', `/api/community/messages/${id}`, asUser(ids.coachA));
    expect([200, 404]).toContain(again.status);
  });

  it('7. empty body → 400 validation', async () => {
    const res = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA),
      { body: '   ' },
    );
    expect(res.status).toBe(400);
  });

  it('8. kill switch: writes 503 when MESSAGES flag off, reads survive', async () => {
    process.env.FEATURE_COMMUNITY_MESSAGES = 'false';
    try {
      const write = await call(
        'POST',
        `/api/community/cohorts/${ids.cohortA}/messages`,
        asUser(ids.studentA),
        { body: 'should fail' },
      );
      expect(write.status).toBe(503);
      expect(write.body.disabled).toBe(true);
      expect(write.body.error).toBe('community.disabled');

      const read = await call(
        'GET',
        `/api/community/cohorts/${ids.cohortA}/messages`,
        asUser(ids.studentA),
      );
      expect(read.status).toBe(200);
    } finally {
      process.env.FEATURE_COMMUNITY_MESSAGES = 'true';
    }
  });

  it('10. post-comments do not bleed into the cohort message paths', async () => {
    // A plain cohort message and a post-comment share the same cohort_id; the
    // comment is a CommunityMessage row tagged with the comment discriminator.
    const sent = await call(
      'POST',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA),
      { body: 'real cohort message' },
    );
    expect(sent.status).toBe(201);

    const comment = await prisma.communityMessage.create({
      data: {
        workspace_id: ids.wsA,
        cohort_id: ids.cohortA,
        scope: 'cohort',
        kind: 'text',
        sender_id: ids.studentA,
        body: 'this is a post comment, not a chat message',
        visibility: 'active',
        plan_context_type: 'community_post_comment',
        plan_context_id: randomUUID(),
      },
    });

    // List excludes the comment.
    const list = await call(
      'GET',
      `/api/community/cohorts/${ids.cohortA}/messages`,
      asUser(ids.studentA),
    );
    expect(list.status).toBe(200);
    const listedIds = list.body.messages.map((m: any) => m.id);
    expect(listedIds).not.toContain(comment.id);
    const bodies = list.body.messages.map((m: any) => m.body);
    expect(bodies).toContain('real cohort message');

    // The comment is unreachable through every /messages/:id path → 404.
    const get = await call(
      'GET',
      `/api/community/messages/${comment.id}`,
      asUser(ids.studentA),
    );
    expect(get.status).toBe(404);

    const patch = await call(
      'PATCH',
      `/api/community/messages/${comment.id}`,
      asUser(ids.studentA),
      { body: 'tampered' },
    );
    expect(patch.status).toBe(404);

    const del = await call(
      'DELETE',
      `/api/community/messages/${comment.id}`,
      asUser(ids.studentA),
    );
    expect(del.status).toBe(404);
  });

  it('9. master flag off → 503 even on reads', async () => {
    process.env.FEATURE_COMMUNITY_API = 'false';
    try {
      const read = await call(
        'GET',
        `/api/community/cohorts/${ids.cohortA}/messages`,
        asUser(ids.studentA),
      );
      expect(read.status).toBe(503);
    } finally {
      process.env.FEATURE_COMMUNITY_API = 'true';
    }
  });
});
