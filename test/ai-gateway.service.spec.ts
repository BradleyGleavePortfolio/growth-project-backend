import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';

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
  // Coach AI v1 adds the AnthropicProviderAdapter slot in the registry.
  // Tests still want stub-only behavior, so we pass a fake adapter that
  // resolves to never-called and rely on the gateway's stub routing.
  const fakeAnthropicAdapter = {
    name: 'anthropic',
    complete: jest.fn(),
  } as any;
  const registry = new AiProviderRegistry(stub, fakeAnthropicAdapter);
  const svc = new AiGatewayService(prisma, config, redaction, registry);
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
      proposedActionPayload: { to_user_id: 'client-1', body: 'Hey, how is the week?' },
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
