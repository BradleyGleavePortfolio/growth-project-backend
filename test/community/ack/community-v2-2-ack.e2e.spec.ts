/**
 * v2-2 coach ack-signals — HTTP integration / E2E (R1).
 *
 * Covers the wiring the colocated unit specs (src/community/ack/*.spec.ts)
 * cannot: the full guard chain on the real routes + the inbox response-shape
 * contract under the flag.
 *
 *  - Transition endpoints, FEATURE_COMMUNITY_ACKS OFF → 404 (dark launch);
 *  - Transition endpoints, flag ON → reach the (mocked) service (200);
 *  - A CLIENT (student) JWT is rejected by RolesGuard → 403 (cannot transition);
 *  - Inbox shape: when the flag is ON the inbox row carries an `ack` envelope;
 *    when OFF the row has NO `ack` key (v1-6 shape preserved).
 *
 * Pure HTTP, no DB (mirrors community-v1-6-feature-flag.e2e.spec.ts): JwtAuthGuard
 * is stubbed to attach a chosen user; RolesGuard, CommunityFeatureFlagGuard and
 * AckFeatureFlagGuard run for real; services are mocked. HTTP via Node's http.
 *
 * The community master switch (FEATURE_COMMUNITY_API) must be 'true' for any of
 * these routes to clear CommunityFeatureFlagGuard; each test sets it explicitly.
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

import { JwtAuthGuard } from '../../../src/auth/auth.guard';
import { RolesGuard } from '../../../src/auth/roles.guard';
import { CommunityFeatureFlagGuard } from '../../../src/community/community-feature-flag.guard';
import { AckController } from '../../../src/community/ack/ack.controller';
import { AckFeatureFlagGuard } from '../../../src/community/ack/ack-flag.guard';
import { AckService } from '../../../src/community/ack/ack.service';
import { AckRepository } from '../../../src/community/ack/ack.repository';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { CommunityCoachInboxController } from '../../../src/community/inbox/community-coach-inbox.controller';
import { CommunityCoachInboxService } from '../../../src/community/inbox/community-coach-inbox.service';

// Valid v4 UUID: the route param is now guarded by ParseUUIDPipe({ version:
// '4' }), so the path id must carry the v4 version/variant nibbles.
const MSG_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const COHORT = '11111111-1111-1111-1111-111111111111';
const COACH = { id: 'cccccccc-0000-0000-0000-00000000000a', role: 'coach' };
const CLIENT = { id: 'dddddddd-0000-0000-0000-00000000000b', role: 'student' };

let CURRENT_USER: { id: string; role: string } = { ...COACH };

interface HttpResult {
  status: number;
  body: any;
}

class StubJwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = { ...CURRENT_USER };
    return true;
  }
}

describe('community v2-2 coach ack signals (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  const ackService = {
    applyTransition: jest.fn(async () => ({
      message_id: MSG_ID,
      ack: {
        state: 'seen',
        seen_at: new Date().toISOString(),
        acked_at: null,
        replied_at: null,
        sla: {
          sla_state: 'within',
          elapsed_ms: 0,
          soft_target_ms: 1,
          hard_target_ms: 2,
        },
      },
    })),
  };

  const inbox = {
    list: jest.fn(async () => ({
      items: [
        {
          id: MSG_ID,
          type: 'message',
          cohort_id: COHORT,
          cohort_name: 'Spring',
          author_user_id: CLIENT.id,
          author_display_name: 'Client',
          preview: 'hello',
          created_at: new Date().toISOString(),
          item_url_path: `/community/cohorts/${COHORT}/messages/${MSG_ID}`,
          ...(process.env.FEATURE_COMMUNITY_ACKS === 'true'
            ? { ack: { state: 'none', sla_state: 'within' } }
            : {}),
        },
      ],
      next_cursor: null,
    })),
  };

  async function call(
    method: string,
    path: string,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        { method, headers: { 'content-type': 'application/json' } },
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
      req.end();
    });
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AckController, CommunityCoachInboxController],
      providers: [
        RolesGuard,
        CommunityFeatureFlagGuard,
        AckFeatureFlagGuard,
        Reflector,
        { provide: AckService, useValue: ackService },
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
    delete process.env.FEATURE_COMMUNITY_ACKS;
    CURRENT_USER = { ...COACH };
    jest.clearAllMocks();
  });

  describe('transition endpoints — flag gating', () => {
    const path = `/api/community/ack/${MSG_ID}/seen`;

    it('community ON + acks UNSET → 404 (dark launch), service untouched', async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const res = await call('POST', path);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('community.ack.disabled');
      expect(ackService.applyTransition).not.toHaveBeenCalled();
    });

    it("community ON + acks 'false' → 404 (explicit off)", async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_ACKS = 'false';
      const res = await call('POST', path);
      expect(res.status).toBe(404);
      expect(ackService.applyTransition).not.toHaveBeenCalled();
    });

    it("community ON + acks 'true' → reaches the service (200)", async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      const res = await call('POST', path);
      expect(res.status).toBe(200);
      expect(res.body.message_id).toBe(MSG_ID);
      expect(res.body.ack.state).toBe('seen');
      expect(ackService.applyTransition).toHaveBeenCalledTimes(1);
    });

    it('community master switch OFF → 503 (master kill switch precedes ack flag)', async () => {
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      const res = await call('POST', path);
      expect(res.status).toBe(503);
      expect(ackService.applyTransition).not.toHaveBeenCalled();
    });
  });

  describe('authorization — client cannot transition', () => {
    it('a student JWT is rejected by RolesGuard → 403', async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      CURRENT_USER = { ...CLIENT };
      const res = await call('POST', `/api/community/ack/${MSG_ID}/acked`);
      expect(res.status).toBe(403);
      expect(ackService.applyTransition).not.toHaveBeenCalled();
    });
  });

  describe('param validation — ParseUUIDPipe v4 (R1)', () => {
    beforeEach(() => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
    });

    it('a malformed messageId → 400, service untouched', async () => {
      const res = await call('POST', '/api/community/ack/not-a-uuid/seen');
      expect(res.status).toBe(400);
      expect(ackService.applyTransition).not.toHaveBeenCalled();
    });

    it('a well-formed but non-v4 messageId → 400, service untouched', async () => {
      const res = await call(
        'POST',
        '/api/community/ack/eeeeeeee-0000-0000-0000-000000000001/acked',
      );
      expect(res.status).toBe(400);
      expect(ackService.applyTransition).not.toHaveBeenCalled();
    });

    it('a valid v4 messageId reaches the service (200)', async () => {
      const res = await call('POST', `/api/community/ack/${MSG_ID}/replied`);
      expect(res.status).toBe(200);
      expect(ackService.applyTransition).toHaveBeenCalledTimes(1);
    });
  });

  describe('inbox shape under the flag', () => {
    const path = `/api/community/me/coach-inbox`;

    it('acks ON → inbox row carries an ack envelope', async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      expect(res.body.items[0].ack).toEqual({
        state: 'none',
        sla_state: 'within',
      });
    });

    it('acks OFF → inbox row has NO ack key (v1-6 shape preserved)', async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      expect(res.body.items[0]).not.toHaveProperty('ack');
    });
  });
});

/**
 * v2-2 ack non-leak + eligibility at the HTTP boundary (R1).
 *
 * Wires the REAL AckService (so the authorize() non-leak + client-authored
 * eligibility rules execute) behind the real route + full guard chain, with
 * the repository / access / analytics dependencies mocked (no DB). Proves that
 * an absent message, a foreign-workspace message, and an ineligible
 * (coach/owner-authored) message ALL surface the SAME 404 over HTTP — no
 * 403-vs-404 existence oracle.
 */
describe('community v2-2 ack non-leak + eligibility (HTTP, real service)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const WORKSPACE = '22222222-2222-2222-2222-222222222222';

  const repo = {
    findById: jest.fn(),
    findSenderRole: jest.fn(),
    stampAck: jest.fn(),
  };
  const access = { isWorkspaceCoach: jest.fn() };
  const analytics = { capture: jest.fn() };

  function rowFor(overrides: Record<string, unknown> = {}) {
    return {
      id: MSG_ID,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      workspace_id: WORKSPACE,
      cohort_id: COHORT,
      scope: 'cohort',
      sender_id: CLIENT.id,
      deleted_at: null,
      coach_seen_at: null,
      coach_acked_at: null,
      coach_replied_at: null,
      ...overrides,
    };
  }

  async function call(method: string, path: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        { method, headers: { 'content-type': 'application/json' } },
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
      req.end();
    });
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AckController],
      providers: [
        AckService,
        RolesGuard,
        CommunityFeatureFlagGuard,
        AckFeatureFlagGuard,
        Reflector,
        { provide: AckRepository, useValue: repo },
        { provide: CommunityAccessService, useValue: access },
        { provide: AnalyticsService, useValue: analytics },
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
    process.env.FEATURE_COMMUNITY_API = 'true';
    process.env.FEATURE_COMMUNITY_ACKS = 'true';
    CURRENT_USER = { ...COACH };
    jest.clearAllMocks();
    access.isWorkspaceCoach.mockResolvedValue(true);
    repo.findSenderRole.mockResolvedValue('student');
  });

  it('absent message → 404, no stamp', async () => {
    repo.findById.mockResolvedValue(null);
    const res = await call('POST', `/api/community/ack/${MSG_ID}/seen`);
    expect(res.status).toBe(404);
    expect(repo.stampAck).not.toHaveBeenCalled();
  });

  it('foreign-workspace message → SAME 404 (no 403 oracle)', async () => {
    repo.findById.mockResolvedValue(rowFor());
    access.isWorkspaceCoach.mockResolvedValue(false);
    const res = await call('POST', `/api/community/ack/${MSG_ID}/seen`);
    expect(res.status).toBe(404);
    expect(repo.stampAck).not.toHaveBeenCalled();
  });

  it('coach-authored message → 404 (ineligible, non-leaking)', async () => {
    repo.findById.mockResolvedValue(rowFor({ sender_id: COACH.id }));
    repo.findSenderRole.mockResolvedValue('coach');
    const res = await call('POST', `/api/community/ack/${MSG_ID}/acked`);
    expect(res.status).toBe(404);
    expect(repo.stampAck).not.toHaveBeenCalled();
  });

  it('owner/system-authored message → 404 (ineligible, non-leaking)', async () => {
    repo.findById.mockResolvedValue(rowFor());
    repo.findSenderRole.mockResolvedValue('owner');
    const res = await call('POST', `/api/community/ack/${MSG_ID}/replied`);
    expect(res.status).toBe(404);
    expect(repo.stampAck).not.toHaveBeenCalled();
  });

  it('absent and foreign messages return identical 404 bodies (no oracle)', async () => {
    repo.findById.mockResolvedValueOnce(null);
    const absent = await call('POST', `/api/community/ack/${MSG_ID}/seen`);
    repo.findById.mockResolvedValueOnce(rowFor());
    access.isWorkspaceCoach.mockResolvedValue(false);
    const foreign = await call('POST', `/api/community/ack/${MSG_ID}/seen`);
    expect(absent.status).toBe(foreign.status);
    expect(absent.body).toEqual(foreign.body);
  });

  it('client-authored, owned, eligible message → 200 (stamps + emits)', async () => {
    repo.findById.mockResolvedValue(rowFor());
    repo.stampAck.mockResolvedValue({
      advanced: true,
      message: rowFor({ coach_seen_at: new Date('2026-01-02T00:00:00.000Z') }),
    });
    const res = await call('POST', `/api/community/ack/${MSG_ID}/seen`);
    expect(res.status).toBe(200);
    expect(res.body.ack.state).toBe('seen');
    expect(repo.stampAck).toHaveBeenCalledTimes(1);
    expect(analytics.capture).toHaveBeenCalledTimes(1);
  });
});
