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
import { CommunityCoachInboxController } from '../../../src/community/inbox/community-coach-inbox.controller';
import { CommunityCoachInboxService } from '../../../src/community/inbox/community-coach-inbox.service';

const MSG_ID = 'eeeeeeee-0000-0000-0000-000000000001';
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
          // B-NEW: the inbox now emits the FULL canonical ack envelope
          // (state + all three timestamps + full SLA snapshot) so the client
          // parses every ack envelope through one schema.
          ...(process.env.FEATURE_COMMUNITY_ACKS === 'true'
            ? {
                ack: {
                  state: 'none',
                  seen_at: null,
                  acked_at: null,
                  replied_at: null,
                  sla: {
                    sla_state: 'within',
                    elapsed_ms: 0,
                    soft_target_ms: 86400000,
                    hard_target_ms: 172800000,
                  },
                },
              }
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

  describe('inbox shape under the flag', () => {
    const path = `/api/community/me/coach-inbox`;

    it('acks ON → inbox row carries the FULL ack envelope (state + timestamps + sla)', async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      process.env.FEATURE_COMMUNITY_ACKS = 'true';
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      // B-NEW: the inbox ack envelope is the full canonical shape, identical to
      // the transition + message-detail envelope (one shape the client parses).
      expect(res.body.items[0].ack).toEqual({
        state: 'none',
        seen_at: null,
        acked_at: null,
        replied_at: null,
        sla: {
          sla_state: 'within',
          elapsed_ms: 0,
          soft_target_ms: 86400000,
          hard_target_ms: 172800000,
        },
      });
      // The five-field shape is exactly what the transition endpoint returns.
      expect(Object.keys(res.body.items[0].ack).sort()).toEqual([
        'acked_at',
        'replied_at',
        'seen_at',
        'sla',
        'state',
      ]);
    });

    it('acks OFF → inbox row has NO ack key (v1-6 shape preserved)', async () => {
      process.env.FEATURE_COMMUNITY_API = 'true';
      const res = await call('GET', path);
      expect(res.status).toBe(200);
      expect(res.body.items[0]).not.toHaveProperty('ack');
    });
  });
});
