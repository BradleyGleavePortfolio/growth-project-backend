/**
 * MWB-5 — feature-flag gating at the gateway boundary (brief Test matrix #7).
 *
 * While FEATURE_MWB_AI_LIVE_CREATE is OFF, the two live-create capabilities
 * (`draft.create_workout_plan`, `draft.edit_workout_plan`) are NOT in the
 * gateway capability allow-list. `AiGatewayService.invoke` must reject them with
 * a 403 (AI_CAPABILITY_NOT_ENABLED) BEFORE any AiActionDraft row is created —
 * the coach never sees a card for a disabled capability. Flipping the flag ON
 * (and allow-listing the capability) lets a draft be created normally.
 *
 * This suite also pins the pure flag + config helpers so the default-OFF
 * invariant is explicit.
 */

import { ForbiddenException } from '@nestjs/common';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import {
  FEATURE_MWB_AI_LIVE_CREATE_ENV,
  MWB_LIVE_CREATE_CAPABILITIES,
  isMwbAiLiveCreateEnabled,
  isMwbLiveCreateCapability,
} from '../src/ai/gateway/mwb-live-create.feature';

const CREATE_CAP = 'draft.create_workout_plan';
const CLIENT = '22222222-2222-2222-2222-222222222222';

function buildPrisma() {
  const created = { audits: [] as any[], drafts: [] as any[] };
  return {
    created,
    aiRequestAudit: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `audit-${created.audits.length + 1}`, ...data };
        created.audits.push(row);
        return row;
      }),
    },
    aiActionDraft: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `draft-${created.drafts.length + 1}`, ...data };
        created.drafts.push(row);
        return row;
      }),
    },
  } as any;
}

function buildSvc(prisma = buildPrisma()) {
  const config = new AiGatewayConfig();
  const redaction = new AiRedactionService();
  const stub = new StubProviderAdapter();
  const fakeAnthropicAdapter = { name: 'anthropic', complete: jest.fn() } as any;
  const registry = new AiProviderRegistry(stub, fakeAnthropicAdapter);
  const svc = new AiGatewayService(prisma, config, redaction, registry);
  return { svc, prisma };
}

function createReq() {
  return {
    capability: CREATE_CAP,
    requester: { id: 'coach-1', role: 'coach' },
    subjectUserId: CLIENT,
    tenantCoachId: 'coach-1',
    userMessage: 'Build a push day for this client.',
    systemPrompt: 'context',
    proposedActionPayload: {
      capability: CREATE_CAP,
      target_client_id: CLIENT,
      diff: [
        { kind: 'add_exercise', client_ref: 'r1', exercise_external_id: 'bench', sets: 4, reps_or_duration_seconds: 8 },
      ],
    },
  };
}

describe('MWB-5 flag helpers (default OFF invariant)', () => {
  it('isMwbAiLiveCreateEnabled is OFF unless the env value is exactly "true"', () => {
    expect(isMwbAiLiveCreateEnabled({} as any)).toBe(false);
    expect(isMwbAiLiveCreateEnabled({ [FEATURE_MWB_AI_LIVE_CREATE_ENV]: '' } as any)).toBe(false);
    expect(isMwbAiLiveCreateEnabled({ [FEATURE_MWB_AI_LIVE_CREATE_ENV]: '1' } as any)).toBe(false);
    expect(isMwbAiLiveCreateEnabled({ [FEATURE_MWB_AI_LIVE_CREATE_ENV]: 'yes' } as any)).toBe(false);
    expect(isMwbAiLiveCreateEnabled({ [FEATURE_MWB_AI_LIVE_CREATE_ENV]: 'true' } as any)).toBe(true);
    expect(isMwbAiLiveCreateEnabled({ [FEATURE_MWB_AI_LIVE_CREATE_ENV]: 'TRUE' } as any)).toBe(true);
  });

  it('isMwbLiveCreateCapability recognises exactly the two live-create capabilities', () => {
    expect(MWB_LIVE_CREATE_CAPABILITIES).toContain('draft.create_workout_plan');
    expect(MWB_LIVE_CREATE_CAPABILITIES).toContain('draft.edit_workout_plan');
    expect(isMwbLiveCreateCapability('draft.create_workout_plan')).toBe(true);
    expect(isMwbLiveCreateCapability('draft.edit_workout_plan')).toBe(true);
    expect(isMwbLiveCreateCapability('draft.coach_message')).toBe(false);
  });
});

describe('AiGatewayConfig.capabilityAllowed — flag gating', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY_ENABLED;
    delete process.env.AI_GATEWAY_PROVIDER;
    delete process.env.AI_GATEWAY_CAPABILITIES;
    delete process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV];
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('refuses a live-create capability when the flag is OFF even if allow-listed', () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = CREATE_CAP;
    // Flag OFF.
    const cfg = new AiGatewayConfig();
    expect(cfg.resolve(CREATE_CAP).capabilityAllowed).toBe(false);
  });

  it('allows a live-create capability only when flag is ON AND allow-listed', () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = CREATE_CAP;
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'true';
    const cfg = new AiGatewayConfig();
    expect(cfg.resolve(CREATE_CAP).capabilityAllowed).toBe(true);
  });
});

describe('AiGatewayService.invoke — live-create flag gating (#7)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY_ENABLED;
    delete process.env.AI_GATEWAY_PROVIDER;
    delete process.env.AI_GATEWAY_CAPABILITIES;
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
    delete process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV];
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('rejects with 403 AI_CAPABILITY_NOT_ENABLED and creates NO draft when the flag is OFF', async () => {
    // Gateway enabled + capability allow-listed, but the MWB-5 flag is OFF.
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = CREATE_CAP;
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = CREATE_CAP;

    const { svc, prisma } = buildSvc();
    await expect(svc.invoke(createReq())).rejects.toBeInstanceOf(ForbiddenException);
    // The hard invariant: NO AiActionDraft row was ever created.
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it('surfaces error code AI_CAPABILITY_NOT_ENABLED in the rejection', async () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = CREATE_CAP;
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = CREATE_CAP;
    const { svc } = buildSvc();
    try {
      await svc.invoke(createReq());
      fail('expected ForbiddenException');
    } catch (e) {
      const resp = (e as ForbiddenException).getResponse() as any;
      expect(resp.error).toBe('AI_CAPABILITY_NOT_ENABLED');
      expect(resp.capability).toBe(CREATE_CAP);
    }
  });

  it('creates a pending draft when the flag is ON and the capability is allow-listed', async () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = CREATE_CAP;
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = CREATE_CAP;
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'true';

    const { svc, prisma } = buildSvc();
    const result = await svc.invoke(createReq());
    expect(result.approvalStatus).toBe('pending');
    expect(result.approvalDraftId).toBeTruthy();
    expect(prisma.aiActionDraft.create).toHaveBeenCalledTimes(1);
    const draftData = prisma.aiActionDraft.create.mock.calls[0][0].data;
    expect(draftData.capability).toBe(CREATE_CAP);
    expect(draftData.status).toBe('pending');
    expect(draftData.payload.target_client_id).toBe(CLIENT);
  });

  it('still rejects when the flag is ON but the capability is NOT allow-listed', async () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    // Allow-list omits the create capability.
    process.env.AI_GATEWAY_CAPABILITIES = 'chat.client_self';
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = CREATE_CAP;
    process.env[FEATURE_MWB_AI_LIVE_CREATE_ENV] = 'true';

    const { svc, prisma } = buildSvc();
    await expect(svc.invoke(createReq())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });
});
