/**
 * coach empty-states endpoint — GET /community/coach/empty-states.
 *
 * Proves the green path: under a coach JWT with the master community flag ON,
 * the endpoint returns the operator-locked Roman copy payload for ALL v1-6
 * coach-community surfaces, each shape mirroring RomanCopyPayload. Also proves
 * the feature-flag floor (503 when the flag is unset) and the role floor (403
 * for a non-coach), mirroring the guard order of the other v1-6 controllers.
 *
 * Pure HTTP, no DB (this repo's default suite has no Postgres): JwtAuthGuard is
 * stubbed to attach a user; RolesGuard + CommunityFeatureFlagGuard run for
 * real; VoicePolicyService is the REAL service (the copy is policy, not data).
 * Mirrors test/community/community-v1-6-feature-flag.e2e.spec.ts.
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

import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { CommunityFeatureFlagGuard } from '../src/community/community-feature-flag.guard';
import { CommunityCoachEmptyStatesController } from '../src/community/inbox/community-coach-empty-states.controller';
import { VoicePolicyService } from '../src/roman/voice/voice-policy.service';
import {
  CoachEmptyStatesResponseSchema,
  RomanCopyPayloadSchema,
} from '../src/community/inbox/dto/coach-empty-states.dto';
import { COACH_COMMUNITY_SURFACE_KEYS } from '../src/roman/voice/voice-policy.constants';

interface HttpResult {
  status: number;
  body: any;
}

const COACH = { id: 'cccccccc-0000-0000-0000-00000000000a', role: 'coach' };
const CLIENT = { id: 'dddddddd-0000-0000-0000-00000000000b', role: 'client' };

// Mutable holder so each test can pick the acting user before the guard runs.
const acting: { user: { id: string; role: string } } = { user: { ...COACH } };

class StubJwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = { ...acting.user };
    return true;
  }
}

describe('community coach empty-states (GET /community/coach/empty-states)', () => {
  let app: INestApplication;
  let baseUrl: string;

  async function call(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        { method: 'GET', headers: { 'content-type': 'application/json', ...headers } },
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
      controllers: [CommunityCoachEmptyStatesController],
      providers: [
        RolesGuard,
        CommunityFeatureFlagGuard,
        Reflector,
        VoicePolicyService,
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
    acting.user = { ...COACH };
  });

  const path = '/api/community/coach/empty-states';

  it('flag UNSET → 503 typed disabled body', async () => {
    const res = await call(path);
    expect(res.status).toBe(503);
    expect(res.body.disabled).toBe(true);
  });

  it('non-coach role → 403 (role floor), even with flag on', async () => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    acting.user = { ...CLIENT };
    const res = await call(path);
    expect(res.status).toBe(403);
  });

  it('coach JWT + flag on → 200 with all surfaces, each a valid RomanCopyPayload', async () => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    const res = await call(path);
    expect(res.status).toBe(200);

    // Whole-envelope contract: parses against the response schema (strict).
    const parsed = CoachEmptyStatesResponseSchema.parse(res.body);

    // Every COACH surface is present and self-consistent (the response is
    // scoped to the five coach surfaces — the ten P2 notification surfaces are
    // delivered through a different channel and must NOT appear here).
    expect(Object.keys(res.body).sort()).toEqual(
      [...COACH_COMMUNITY_SURFACE_KEYS].sort(),
    );
    for (const key of COACH_COMMUNITY_SURFACE_KEYS) {
      const payload = (parsed as Record<string, unknown>)[key];
      expect(payload).toBeDefined();
      const single = RomanCopyPayloadSchema.parse(payload);
      expect(single.surface_key).toBe(key);
      // Coach copy is operator-locked Roman, pinned ON independent of the P2
      // dunning rollout flag.
      expect(single.voice_variant).toBe('roman_v2');
    }

    // Moderation cleared is celebratory (smile); the rest are neutral.
    expect(res.body.coach_community_moderation_empty.avatar_crop).toBe('smile');
    expect(res.body.coach_community_home_empty.avatar_crop).toBe('neutral');
  });
});
