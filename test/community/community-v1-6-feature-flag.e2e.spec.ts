/**
 * v1-6 coach-admin feature-flag default-off coverage (R1-P2-003).
 *
 * The three v1-6 controllers (cohort write, members, coach inbox) declare
 * CommunityFeatureFlagGuard, the community master kill switch. No prior v1-6
 * test asserted these specific routes are gated and DEFAULT-OFF, so this suite
 * makes the contract explicit: with FEATURE_COMMUNITY_API unset/'false' a
 * representative route on each controller returns 503 (typed disabled body);
 * with '=== true' it reaches the (mocked) service and returns 200.
 *
 * Pure HTTP, no DB: JwtAuthGuard is stubbed to attach a coach user; RolesGuard
 * and CommunityFeatureFlagGuard run for real; the services are mocked. HTTP is
 * issued via Node's built-in http module (supertest is absent from this repo),
 * mirroring test/community/community-foundation.e2e.spec.ts.
 */
import 'reflect-metadata';
import * as http from 'http';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { CommunityFeatureFlagGuard } from '../../src/community/community-feature-flag.guard';
import { CommunityCohortWriteController } from '../../src/community/cohorts/community-cohort-write.controller';
import { CommunityCohortWriteService } from '../../src/community/cohorts/community-cohort-write.service';
import { CommunityCohortMembersController } from '../../src/community/cohorts/community-cohort-members.controller';
import { CommunityCohortMembersService } from '../../src/community/cohorts/community-cohort-members.service';
import { CommunityCoachInboxController } from '../../src/community/inbox/community-coach-inbox.controller';
import { CommunityCoachInboxService } from '../../src/community/inbox/community-coach-inbox.service';

const COACH = { id: 'cccccccc-0000-0000-0000-00000000000a', role: 'coach' };
const COHORT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';

interface HttpResult {
  status: number;
  body: any;
}

// Stub JwtAuthGuard: attach the coach user (the real guard verifies a JWT and
// attaches the Prisma User; here we attach directly so RolesGuard + the flag
// guard run against a real req.user).
class StubJwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = { ...COACH };
    return true;
  }
}

describe('community v1-6 coach-admin feature flag (default-off)', () => {
  let app: INestApplication;
  let baseUrl: string;

  // Mocked services: the flag guard runs BEFORE the handler, so when the flag
  // is off these are never hit; when on they return a trivial 200 envelope.
  const cohortWrite = { create: jest.fn(async () => ({ ok: true })) };
  const members = { list: jest.fn(async () => ({ members: [], next_cursor: null })) };
  const inbox = { list: jest.fn(async () => ({ items: [], next_cursor: null })) };

  async function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<HttpResult> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            ...headers,
          },
        },
        (res) => {
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
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        CommunityCohortWriteController,
        CommunityCohortMembersController,
        CommunityCoachInboxController,
      ],
      providers: [
        RolesGuard,
        CommunityFeatureFlagGuard,
        Reflector,
        { provide: CommunityCohortWriteService, useValue: cohortWrite },
        { provide: CommunityCohortMembersService, useValue: members },
        { provide: CommunityCoachInboxService, useValue: inbox },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new StubJwtAuthGuard())
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    delete process.env.FEATURE_COMMUNITY_API;
    delete process.env.FEATURE_COMMUNITY_API_ALLOWLIST;
    jest.clearAllMocks();
  });

  describe('cohort write — POST /workspaces/:id/cohorts', () => {
    const path = `/api/community/workspaces/${WORKSPACE}/cohorts`;

    it('flag UNSET → 503 typed disabled body, service untouched', async () => {
      const res = await call('POST', path, {}, { name: 'Spring' });
      expect(res.status).toBe(503);
      expect(res.body.disabled).toBe(true);
      expect(res.body.error).toBe('community.disabled');
      expect(cohortWrite.create).not.toHaveBeenCalled();
    });

    it("flag 'false' → 503 (explicit off)", async () => {
      process.env.FEATURE_COMMUNITY_API = 'false';
      const res = await call('POST', path, {}, { name: 'Spring' });
      expect(res.status).toBe(503);
      expect(cohortWrite.create).not.toHaveBeenCalled();
    });

    it("flag 'true' → reaches the service (200)", async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const res = await call('POST', path, {}, { name: 'Spring 2026' });
      expect(res.status).toBe(201);
      expect(cohortWrite.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('cohort members — GET /cohorts/:id/members', () => {
    const path = `/api/community/cohorts/${COHORT}/members`;

    it('flag UNSET → 503, service untouched', async () => {
      const res = await call('GET', path);
      expect(res.status).toBe(503);
      expect(res.body.disabled).toBe(true);
      expect(members.list).not.toHaveBeenCalled();
    });

    it("flag 'true' → reaches the service (200)", async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      expect(members.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('coach inbox — GET /me/coach-inbox', () => {
    const path = `/api/community/me/coach-inbox`;

    it('flag UNSET → 503, service untouched', async () => {
      const res = await call('GET', path);
      expect(res.status).toBe(503);
      expect(res.body.disabled).toBe(true);
      expect(inbox.list).not.toHaveBeenCalled();
    });

    it("flag 'true' → reaches the service (200)", async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      expect(inbox.list).toHaveBeenCalledTimes(1);
    });
  });
});
