/**
 * B-AIBSUB-126 — Ask AI is hidden for sub-coaches at launch.
 *
 * A sub-coach (a coach whom SubCoachScopeService.getHeadCoachIdForSubCoach maps to another coach) gets:
 *   - GET /ai/gateway/workout-builder/status: the exact 404 of a route this backend never mounted (what an older backend
 *     answers), so the app hides the Ask AI entry;
 *   - the same 404 from AiGatewayService.invoke for both workout-builder capabilities (POST /ai/gateway/workout-builder/propose
 *     and POST /ai/gateway/invoke both go through it), before any draft, audit row or provider call.
 * Head coaches (including a head coach with a sub-coach), solo coaches and owners are unchanged.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiGatewayService, type AiGatewayRequest } from '../src/ai/gateway/ai-gateway.service';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import type { AnthropicProviderAdapter } from '../src/ai/gateway/providers/anthropic-provider.adapter';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import type { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { WorkoutBuilderStatusController } from '../src/ai/gateway/workout-builder/workout-builder-status.controller';
import { WorkoutBuilderStatusService } from '../src/ai/gateway/workout-builder/workout-builder-status.service';
import { isSubCoachOfAnotherCoach } from '../src/ai/gateway/workout-builder/workout-builder-sub-coach.gate';
import { grantAllEgress } from './ai-egress/ai-egress.fakes';

const fake = <T>(v: unknown): T => v as T;
const CREATE = 'draft.create_workout_plan';
const EDIT = 'draft.edit_workout_plan';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';
const H_USER = 'x-test-user';
const H_ROLE = 'x-test-role';
// sub-1 is on head-1's team; head-1 is a head coach with a sub-coach; solo-1 has no team.
const HEAD_OF: Record<string, string> = { 'sub-1': 'head-1' };

function scopeFake() {
  return {
    getHeadCoachIdForSubCoach: jest.fn(async (id: string) => HEAD_OF[id] ?? null),
  };
}

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: req.headers[H_ROLE] ?? 'coach' };
    return true;
  }
}

const STATUS_BODY = {
  state: 'paused',
  create: false,
  edit: false,
  credits: { remaining_pct: null, resets_at: null },
  label: 'AI-suggested, coach-approved',
};

describe('B-AIBSUB-126: GET /ai/gateway/workout-builder/status hides Ask AI for sub-coaches', () => {
  let app: INestApplication;
  let baseUrl: string;
  const scope = scopeFake();
  const status = { getStatus: jest.fn(async (_coachUserId: string) => STATUS_BODY) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkoutBuilderStatusController],
      providers: [
        { provide: WorkoutBuilderStatusService, useValue: status },
        { provide: SubCoachScopeService, useValue: scope },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${fake<AddressInfo>(app.getHttpServer().address()).port}`;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => jest.clearAllMocks());

  function get(path: string, user: string, role = 'coach'): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${path}`, { headers: { [H_USER]: user, [H_ROLE]: role } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        })
        .on('error', reject);
    });
  }

  it('sub-coach -> the same 404 body as a route the backend never mounted; status is never computed', async () => {
    const res = await get('/ai/gateway/workout-builder/status', 'sub-1');
    const unmounted = await get('/ai/gateway/workout-builder/not-mounted', 'sub-1');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      message: 'Cannot GET /ai/gateway/workout-builder/status',
      error: 'Not Found',
      path: '/ai/gateway/workout-builder/status',
    });
    expect(unmounted.status).toBe(404);
    expect(unmounted.body.message).toBe('Cannot GET /ai/gateway/workout-builder/not-mounted');
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(unmounted.body).sort());
    expect(scope.getHeadCoachIdForSubCoach).toHaveBeenCalledWith('sub-1');
    expect(status.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['head coach with a sub-coach', 'head-1', 'coach'],
    ['solo coach', 'solo-1', 'coach'],
    ['owner', 'owner-1', 'owner'],
  ])('%s -> unchanged 200 with the status body', async (_label, user, role) => {
    const res = await get('/ai/gateway/workout-builder/status', user, role);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STATUS_BODY);
    expect(status.getStatus).toHaveBeenCalledWith(user);
  });

  it('isSubCoachOfAnotherCoach: only a coach mapped to a different coach', async () => {
    const s = scopeFake();
    expect(await isSubCoachOfAnotherCoach(s, { id: 'sub-1', role: 'coach' })).toBe(true);
    expect(await isSubCoachOfAnotherCoach(s, { id: 'head-1', role: 'coach' })).toBe(false);
    expect(await isSubCoachOfAnotherCoach(s, { id: 'solo-1', role: 'coach' })).toBe(false);
    expect(await isSubCoachOfAnotherCoach(s, { id: 'sub-1', role: 'owner' })).toBe(false);
    expect(await isSubCoachOfAnotherCoach({ getHeadCoachIdForSubCoach: async () => 'self' }, { id: 'self', role: 'coach' })).toBe(false);
  });
});

describe('B-AIBSUB-126: AiGatewayService.invoke (propose + /ai/gateway/invoke) refuses workout-builder drafts for sub-coaches', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_GATEWAY_ENABLED: 'true',
      AI_GATEWAY_PROVIDER: 'stub',
      AI_GATEWAY_CAPABILITIES: `${CREATE},${EDIT}`,
      AI_GATEWAY_REQUIRE_APPROVAL: `${CREATE},${EDIT}`,
      FEATURE_MWB_AI_LIVE_CREATE: 'true',
    };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function build() {
    const prisma = {
      aiRequestAudit: { create: jest.fn(async ({ data }: { data: object }) => ({ id: 'audit-1', ...data })) },
      aiActionDraft: { create: jest.fn(async ({ data }: { data: object }) => ({ id: 'draft-1', ...data })) },
    };
    const scope = scopeFake();
    const anthropic = fake<AnthropicProviderAdapter>({ name: 'anthropic', complete: jest.fn() });
    const svc = new AiGatewayService(
      fake<PrismaService>(prisma),
      new AiGatewayConfig(),
      new AiRedactionService(),
      new AiProviderRegistry(new StubProviderAdapter(), anthropic),
      grantAllEgress(),
      undefined,
      undefined,
      fake<SubCoachScopeService>(scope),
    );
    return { svc, prisma, scope };
  }

  const request = (capability: string, requester: { id: string; role: string }): AiGatewayRequest => ({
    capability,
    requester,
    subjectUserId: CLIENT,
    userMessage: 'Swap squats for a knee-friendly option.',
    systemPrompt: 'context',
    proposedActionPayload:
      capability === CREATE
        ? {
            capability,
            target_client_id: CLIENT,
            diff: [{ kind: 'add_exercise', client_ref: 'r1', exercise_external_id: 'bench', sets: 4, reps_or_duration_seconds: 8 }],
          }
        : {
            capability,
            target_plan_id: PLAN,
            base_revision_index: 0,
            diff: [{ kind: 'add_exercise', client_ref: 'r1', exercise_external_id: 'bench', sets: 4, reps_or_duration_seconds: 8 }],
          },
  });

  it.each([CREATE, EDIT])('sub-coach + %s -> 404; no audit row, no draft', async (capability) => {
    const { svc, prisma, scope } = build();
    await expect(svc.invoke(request(capability, { id: 'sub-1', role: 'coach' }))).rejects.toBeInstanceOf(NotFoundException);
    expect(scope.getHeadCoachIdForSubCoach).toHaveBeenCalledWith('sub-1');
    expect(prisma.aiRequestAudit.create).not.toHaveBeenCalled();
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it.each([
    ['head coach with a sub-coach', 'head-1', 'coach'],
    ['solo coach', 'solo-1', 'coach'],
    ['owner', 'owner-1', 'owner'],
  ])('%s -> unchanged: a pending draft is written', async (_label, id, role) => {
    const { svc, prisma } = build();
    const result = await svc.invoke(request(CREATE, { id, role }));
    expect(result.approvalStatus).toBe('pending');
    expect(prisma.aiActionDraft.create).toHaveBeenCalledTimes(1);
  });

  it('other draft capabilities are not affected (no sub-coach lookup)', async () => {
    const { svc, scope } = build();
    await svc.invoke({ ...request(CREATE, { id: 'sub-1', role: 'coach' }), capability: 'chat.client_self', proposedActionPayload: undefined });
    expect(scope.getHeadCoachIdForSubCoach).not.toHaveBeenCalled();
  });
});
