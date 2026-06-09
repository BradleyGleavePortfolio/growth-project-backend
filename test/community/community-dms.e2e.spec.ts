/**
 * Community v1-3 direct messages — end-to-end spec.
 *
 * Mirrors the v1-3 messages harness: boots the real Nest HTTP layer for the DM
 * sub-module wired to the real PrismaService, drives it over Node's built-in
 * http against a live disposable Postgres, and stubs ONLY JwtAuthGuard
 * (header-driven). RolesGuard, CommunityFeatureFlagGuard and the DM kill switch
 * all run for real.
 *
 * GATE INTENT (R66/R69): env-gated on COMMUNITY_TEST_DATABASE_URL. Unset → the
 * whole block is describe.skip-ed with a logged reason (never a silent pass).
 *
 * Covers G9 plan case 2 ("DM disabled by default"):
 *  - With FEATURE_COMMUNITY_DM unset, every DM route (read AND write) → 503
 *    with the shared disabled envelope.
 *  - With the flag ON but the workspace dm_enabled_default=false and no
 *    per-membership override, opening a thread → 403 community.dm.disabled
 *    (proves the workspace-level default-OFF gate is independent of the global
 *    flag).
 *  - Plus: self-DM → 404, and cross-tenant DM (recipient in another workspace)
 *    → 404 non-leak.
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

import { CommunityDmsController } from '../../src/community/dms/community-dms.controller';
import { CommunityDmsService } from '../../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../../src/community/dms/community-dms.repository';
import { CommunityAccessService } from '../../src/community/community-access.service';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { CommunityDmEnabledGuard } from '../../src/community/community-write-flag.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { liveDbUrl } from './_support/community-db';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-dms] COMMUNITY_TEST_DATABASE_URL not set — e2e spec skipped.',
  );
}

const H_USER = 'x-test-user-id';

interface HttpResult {
  status: number;
  body: any;
}

itLive('community v1-3 direct messages (live DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const ids = {
    coachA: '',
    studentA: '',
    studentA2: '',
    coachB: '',
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
    // FEATURE_COMMUNITY_DM is toggled per-test; start with it unset.
    delete process.env.FEATURE_COMMUNITY_DM;
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;

    const prismaForStub = new PrismaService();
    await prismaForStub.$connect();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CommunityDmsController],
      providers: [
        CommunityDmsService,
        CommunityDmsRepository,
        CommunityAccessService,
        CommunityFeatureFlagGuard,
        CommunityDmEnabledGuard,
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
    ids.coachB = randomUUID();
    ids.studentB = randomUUID();

    const users: Array<[string, string, string, string | null]> = [
      [ids.coachA, 'coach', 'Coach A', null],
      [ids.studentA, 'student', 'Student A', ids.coachA],
      [ids.studentA2, 'student', 'Student A2', ids.coachA],
      [ids.coachB, 'coach', 'Coach B', null],
      [ids.studentB, 'student', 'Student B', ids.coachB],
    ];
    for (const [id, role, name, coachId] of users) {
      await prisma.$executeRaw`
        INSERT INTO "User" (id, role, name, coach_id)
        VALUES (${id}, ${role}, ${name}, ${coachId})
      `;
    }

    // Workspace A: DMs disabled by default (the secure default).
    const wsA = await prisma.communityWorkspace.create({
      data: {
        coach_id: ids.coachA,
        name: 'WS A',
        slug: `ws-a-${tag}`,
        dm_enabled_default: false,
      },
    });
    const wsB = await prisma.communityWorkspace.create({
      data: {
        coach_id: ids.coachB,
        name: 'WS B',
        slug: `ws-b-${tag}`,
        dm_enabled_default: false,
      },
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
      ids.studentA,
      ids.studentA2,
      ids.coachB,
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

  describe('DM disabled by default (G9 case 2)', () => {
    it('1. flag OFF: GET threads → 503 disabled envelope', async () => {
      delete process.env.FEATURE_COMMUNITY_DM;
      const res = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}/dms`,
        asUser(ids.studentA),
      );
      expect(res.status).toBe(503);
      expect(res.body.disabled).toBe(true);
      expect(res.body.error).toBe('community.disabled');
    });

    it('2. flag OFF: POST open thread → 503', async () => {
      delete process.env.FEATURE_COMMUNITY_DM;
      const res = await call(
        'POST',
        `/api/community/workspaces/${ids.wsA}/dms`,
        asUser(ids.studentA),
        { recipient_user_id: ids.studentA2 },
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('community.disabled');
    });

    it('3. flag OFF: GET thread messages → 503', async () => {
      delete process.env.FEATURE_COMMUNITY_DM;
      const res = await call(
        'GET',
        `/api/community/workspaces/${ids.wsA}/dms/${ids.studentA2}/messages`,
        asUser(ids.studentA),
      );
      expect(res.status).toBe(503);
    });

    it('4. flag OFF: POST send message → 503', async () => {
      delete process.env.FEATURE_COMMUNITY_DM;
      const res = await call(
        'POST',
        `/api/community/workspaces/${ids.wsA}/dms/${ids.studentA2}/messages`,
        asUser(ids.studentA),
        { body: 'hello' },
      );
      expect(res.status).toBe(503);
    });

    it('5. flag ON but workspace default-OFF: open thread → 403 community.dm.disabled', async () => {
      process.env.FEATURE_COMMUNITY_DM = 'true';
      try {
        const res = await call(
          'POST',
          `/api/community/workspaces/${ids.wsA}/dms`,
          asUser(ids.studentA),
          { recipient_user_id: ids.studentA2 },
        );
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('community.dm.disabled');
      } finally {
        delete process.env.FEATURE_COMMUNITY_DM;
      }
    });
  });

  describe('non-leak posture', () => {
    it('6. flag ON: self-DM → 404', async () => {
      process.env.FEATURE_COMMUNITY_DM = 'true';
      try {
        const res = await call(
          'POST',
          `/api/community/workspaces/${ids.wsA}/dms`,
          asUser(ids.studentA),
          { recipient_user_id: ids.studentA },
        );
        expect(res.status).toBe(404);
      } finally {
        delete process.env.FEATURE_COMMUNITY_DM;
      }
    });

    it('7. flag ON: cross-tenant recipient (other workspace) → 404', async () => {
      process.env.FEATURE_COMMUNITY_DM = 'true';
      try {
        const res = await call(
          'POST',
          `/api/community/workspaces/${ids.wsA}/dms`,
          asUser(ids.studentA),
          { recipient_user_id: ids.studentB },
        );
        expect(res.status).toBe(404);
      } finally {
        delete process.env.FEATURE_COMMUNITY_DM;
      }
    });
  });
});
