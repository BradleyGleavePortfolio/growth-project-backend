import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import { deriveGatewayDataSubject } from '../src/ai/gateway/ai-gateway.service';
import { AiEgressService } from '../src/ai-egress/ai-egress.service';
import { AiConsentRequiredException } from '../src/ai-egress/ai-consent-required.exception';
import { clientDataSubject, noClientDataSubject } from '../src/ai-egress/ai-egress.types';
import { egressWithGrants, grantAllEgress } from './ai-egress/ai-egress.fakes';

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
    // R2b — roster for the gateway's tenancy pre-flight: coach-1 coaches
    // client-1 and client-2 directly; sub-1 holds client-3 by delegation.
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        ['client-1', 'client-2']
          .filter((id) => where.id.in.includes(id) && where.coach_id === 'coach-1')
          .map((id) => ({ id })),
      ),
    },
    subCoachAssignment: {
      findMany: jest.fn(async ({ where }: any) =>
        where.sub_coach_id === 'sub-1' && where.client_id.in.includes('client-3')
          ? [{ client_id: 'client-3' }]
          : [],
      ),
    },
  } as any;
}

function buildSvc(
  prisma = buildPrisma(),
  egress: AiEgressService = grantAllEgress(),
  anthropicComplete: jest.Mock = jest.fn(),
) {
  const config = new AiGatewayConfig();
  const redaction = new AiRedactionService();
  const stub = new StubProviderAdapter();
  // Coach AI v1 adds the AnthropicProviderAdapter slot in the registry.
  // Tests still want stub-only behavior, so we pass a fake adapter that
  // resolves to never-called and rely on the gateway's stub routing.
  const fakeAnthropicAdapter = {
    name: 'anthropic',
    complete: anthropicComplete,
  } as any;
  const registry = new AiProviderRegistry(stub, fakeAnthropicAdapter);
  const svc = new AiGatewayService(prisma, config, redaction, registry, egress);
  return { svc, prisma, registry };
}

describe('AiGatewayService', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY_ENABLED;
    delete process.env.AI_GATEWAY_PROVIDER;
    delete process.env.AI_GATEWAY_CAPABILITIES;
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('returns the stub response and writes an audit row when AI is disabled', async () => {
    const { svc, prisma } = buildSvc();
    const result = await svc.invoke({
      capability: 'chat.client_self',
      requester: { id: 'u-1', role: 'student' },
      userMessage: 'How am I doing today?',
      systemPrompt: 'You are GP.',
    });
    expect(result.enabled).toBe(false);
    expect(result.provider).toBe('stub');
    expect(result.draftMode).toBe(true); // stub means client should treat as draft
    expect(result.reply).toMatch(/\[ai-disabled\]/);
    expect(prisma.aiRequestAudit.create).toHaveBeenCalledTimes(1);
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
    const auditData = prisma.aiRequestAudit.create.mock.calls[0][0].data;
    expect(auditData.provider).toBe('stub');
    expect(auditData.enabled).toBe(false);
    expect(auditData.requester_id).toBe('u-1');
    expect(auditData.approval_status).toBe('not_required');
    expect(typeof auditData.prompt_hash).toBe('string');
    expect(typeof auditData.response_hash).toBe('string');
  });

  it('redacts user messages BEFORE handing them to the provider adapter', async () => {
    const { svc, prisma, registry } = buildSvc();
    const completeSpy = jest.spyOn(registry.resolve('stub'), 'complete');
    await svc.invoke({
      capability: 'chat.client_self',
      requester: { id: 'u-1', role: 'student' },
      userMessage: 'My email is brad@example.com and phone (415) 555-0199',
      systemPrompt: 'context',
    });
    const callArgs = completeSpy.mock.calls[0][0];
    const lastTurn = callArgs.turns[callArgs.turns.length - 1].content;
    expect(lastTurn).not.toContain('brad@example.com');
    expect(lastTurn).not.toContain('415');
    expect(lastTurn).toContain('[redacted-email]');
    expect(lastTurn).toContain('[redacted-phone]');
    const auditData = prisma.aiRequestAudit.create.mock.calls[0][0].data;
    expect(auditData.redactions_applied.email).toBe(1);
    expect(auditData.redactions_applied.phone).toBe(1);
    completeSpy.mockRestore();
  });

  it('opens a pending AiActionDraft for capabilities that require approval', async () => {
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = 'draft.coach_message';
    const { svc, prisma } = buildSvc();
    const result = await svc.invoke({
      capability: 'draft.coach_message',
      requester: { id: 'coach-1', role: 'coach' },
      subjectUserId: 'client-1',
      tenantCoachId: 'coach-1',
      userMessage: 'Draft a check-in nudge for the client.',
      systemPrompt: 'context',
      // PR AI-3 (PRODUCT-1): payload must match CoachMessagePayloadSchema —
      // { clientId: uuid, body: non-empty string } — or draft creation 400s
      // BEFORE persistence. UUIDs are required (not just any string) so the
      // downstream MessagingService.sendAsCoach call can resolve a client.
      proposedActionPayload: {
        clientId: '22222222-2222-2222-2222-222222222222',
        body: 'Hey, how is the week?',
      },
    });
    expect(result.approvalRequired).toBe(true);
    expect(result.approvalStatus).toBe('pending');
    expect(result.approvalDraftId).toBeTruthy();
    expect(result.draftMode).toBe(true);
    expect(prisma.aiActionDraft.create).toHaveBeenCalledTimes(1);
    const draftData = prisma.aiActionDraft.create.mock.calls[0][0].data;
    expect(draftData.status).toBe('pending');
    expect(draftData.requester_id).toBe('coach-1');
    expect(draftData.subject_user_id).toBe('client-1');
    expect(draftData.tenant_coach_id).toBe('coach-1');
    expect(draftData.payload.body).toBe('Hey, how is the week?');
    const auditData = prisma.aiRequestAudit.create.mock.calls[0][0].data;
    expect(auditData.approval_status).toBe('pending');
    expect(auditData.approval_draft_id).toBe(result.approvalDraftId);
  });

  it('does NOT throw when audit insertion fails — only logs', async () => {
    const prisma = buildPrisma();
    prisma.aiRequestAudit.create = jest.fn().mockRejectedValue(new Error('audit table down'));
    const { svc } = buildSvc(prisma);
    const result = await svc.invoke({
      capability: 'chat.client_self',
      requester: { id: 'u-1', role: 'student' },
      userMessage: 'hi',
      systemPrompt: 'context',
    });
    expect(result.reply).toMatch(/\[ai-disabled\]/);
    expect(result.auditId).toBe('');
  });

  it('rejects a draft.coach_message invocation with a malformed payload BEFORE persisting the draft row (PR AI-3 PRODUCT-1)', async () => {
    // Verifies the shift-left validation: malformed payloads must 400 at
    // invoke time so the coach never sees a broken draft card. Critically,
    // aiActionDraft.create must NOT be called — we don't want orphan rows
    // that the materialiser would later reject.
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = 'draft.coach_message';
    const { svc, prisma } = buildSvc();
    await expect(
      svc.invoke({
        capability: 'draft.coach_message',
        requester: { id: 'coach-1', role: 'coach' },
        subjectUserId: 'client-1',
        tenantCoachId: 'coach-1',
        userMessage: 'Draft a nudge.',
        systemPrompt: 'context',
        // clientId is not a UUID + body is empty whitespace — two violations.
        proposedActionPayload: { clientId: 'not-a-uuid', body: '   ' },
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'AI_DRAFT_PAYLOAD_INVALID' }),
    });
    expect(prisma.aiActionDraft.create).not.toHaveBeenCalled();
  });

  it('throws when invoked without an authenticated requester', async () => {
    const { svc } = buildSvc();
    await expect(
      svc.invoke({
        capability: 'chat.client_self',
        // @ts-expect-error intentional
        requester: null,
        userMessage: 'hi',
        systemPrompt: 'ctx',
      }),
    ).rejects.toThrow(/requester/);
  });
});

describe('AiGatewayService — R2b box-2 consent', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_GATEWAY_CAPABILITIES = 'client_chat';
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // The real AnthropicProviderAdapter hands req.dataSubject to the egress
  // gate at send time; this fake does the same so revocation between the
  // pre-flight and the send is observable.
  function sendingAdapter(egress: AiEgressService): jest.Mock {
    return jest.fn(async (req: any) => {
      await egress.assertMaySend(req.dataSubject, 'anthropic', 'gateway');
      return {
        text: 'ok',
        enabled: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        promptTokenEstimate: 1,
        responseTokenEstimate: 1,
        meta: {},
      };
    });
  }

  const coachAbout = (subjectUserId: string) => ({
    capability: 'client_chat',
    requester: { id: 'coach-1', role: 'coach' as const },
    subjectUserId,
    userMessage: 'How is this client doing?',
    systemPrompt: 'x',
  });

  it('grant: the request is sent with the client as data subject', async () => {
    const { egress } = egressWithGrants(['client-1']);
    const complete = sendingAdapter(egress);
    const { svc } = buildSvc(buildPrisma(), egress, complete);
    await svc.invoke(coachAbout('client-1'));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].dataSubject).toEqual(clientDataSubject('client-1', 'coach'));
  });

  it('no grant: 403 ai_consent_required, provider never called, no stub fallback', async () => {
    const { egress } = egressWithGrants([]);
    const complete = sendingAdapter(egress);
    const { svc, prisma } = buildSvc(buildPrisma(), egress, complete);
    await expect(svc.invoke(coachAbout('client-1'))).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(complete).not.toHaveBeenCalled();
    expect(prisma.created.audits).toHaveLength(0);
  });

  it('revoked between pre-flight and send: refusal surfaces (not masked as a stub reply)', async () => {
    const { egress, reader } = egressWithGrants(['client-1']);
    const send = sendingAdapter(egress);
    const complete = jest.fn(async (req: any) => {
      reader.revoke('client-1');
      return send(req);
    });
    const { svc } = buildSvc(buildPrisma(), egress, complete);
    await expect(svc.invoke(coachAbout('client-1'))).rejects.toBeInstanceOf(AiConsentRequiredException);
  });

  it('ledger error: fails closed, provider never called', async () => {
    const { egress, reader } = egressWithGrants(['client-1']);
    reader.failWith = new Error('db down');
    const complete = sendingAdapter(egress);
    const { svc } = buildSvc(buildPrisma(), egress, complete);
    await expect(svc.invoke(coachAbout('client-1'))).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('another coach\'s client: 404 before any consent read (no oracle)', async () => {
    const { egress, reader } = egressWithGrants(['client-9']);
    const complete = sendingAdapter(egress);
    const { svc } = buildSvc(buildPrisma(), egress, complete);
    await expect(svc.invoke(coachAbout('client-9'))).rejects.toThrow('Client not found');
    expect(reader.calls).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('delegated sub-coach passes tenancy; consent still required', async () => {
    const { egress } = egressWithGrants([]);
    const complete = sendingAdapter(egress);
    const { svc } = buildSvc(buildPrisma(), egress, complete);
    await expect(
      svc.invoke({ ...coachAbout('client-3'), requester: { id: 'sub-1', role: 'coach' } }),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
  });

  it('a client id in the proposed payload is gated even with no subjectUserId', async () => {
    const { egress } = egressWithGrants(['client-1']);
    const complete = sendingAdapter(egress);
    const { svc } = buildSvc(buildPrisma(), egress, complete);
    await expect(
      svc.invoke({
        capability: 'client_chat',
        requester: { id: 'coach-1', role: 'coach' },
        userMessage: 'draft',
        systemPrompt: 'x',
        proposedActionPayload: { clientId: 'client-2' },
      }),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('stub provider: nothing leaves the server, so no consent read', async () => {
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    const { egress, reader } = egressWithGrants([]);
    const { svc } = buildSvc(buildPrisma(), egress);
    const out = await svc.invoke(coachAbout('client-1'));
    expect(out.provider).toBe('stub');
    expect(reader.calls).toHaveLength(0);
  });
});

describe('deriveGatewayDataSubject (R2b)', () => {
  const base = { capability: 'client_chat', userMessage: 'x', systemPrompt: 'x' };
  it('coach about own scope -> no client data', () => {
    expect(
      deriveGatewayDataSubject({ ...base, requester: { id: 'coach-1', role: 'coach' }, subjectUserId: 'coach-1' }),
    ).toEqual(noClientDataSubject('coach_own_scope'));
  });
  it('client with no subject -> themself, client audience', () => {
    expect(deriveGatewayDataSubject({ ...base, requester: { id: 'client-1', role: 'student' } })).toEqual(
      clientDataSubject('client-1', 'client'),
    );
  });
  it('strictest wins: subject + payload ids + declared dataClientIds', () => {
    expect(
      deriveGatewayDataSubject({
        ...base,
        requester: { id: 'coach-1', role: 'coach' },
        subjectUserId: 'a',
        proposedActionPayload: { target_client_id: 'b', client_id: 'a' },
        dataClientIds: ['c'],
      }),
    ).toEqual(clientDataSubject(['a', 'b', 'c'], 'coach'));
  });
});
