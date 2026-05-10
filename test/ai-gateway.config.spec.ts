import { AiGatewayConfig, DEFAULT_APPROVAL_REQUIRED } from '../src/ai/gateway/ai-gateway.config';

describe('AiGatewayConfig', () => {
  const ORIGINAL_ENV = process.env;
  const svc = new AiGatewayConfig();

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY_ENABLED;
    delete process.env.AI_GATEWAY_PROVIDER;
    delete process.env.AI_GATEWAY_CAPABILITIES;
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('fails closed when AI_GATEWAY_ENABLED is unset', () => {
    const r = svc.resolve('chat.client_self');
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe('stub');
    expect(r.reason).toBe('gateway-disabled');
  });

  it('fails closed when capability is not in the allow-list', () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_CAPABILITIES = 'chat.client_self';
    const r = svc.resolve('draft.coach_message');
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe('stub');
    expect(r.reason).toMatch(/capability-not-allowed/);
  });

  it('fails closed when provider is set to perplexity but no key is present', () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'perplexity';
    process.env.AI_GATEWAY_CAPABILITIES = '*';
    const r = svc.resolve('chat.client_self');
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe('stub');
    expect(r.reason).toBe('provider-key-missing:perplexity');
  });

  it('reports enabled when gateway, capability, provider, and key all align', () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'perplexity';
    process.env.AI_GATEWAY_CAPABILITIES = 'chat.client_self';
    process.env.PERPLEXITY_API_KEY = 'xxx';
    const r = svc.resolve('chat.client_self');
    expect(r.enabled).toBe(true);
    expect(r.provider).toBe('perplexity');
    expect(r.reason).toBeUndefined();
  });

  it('always returns stub for unknown provider names', () => {
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'gemini';
    process.env.AI_GATEWAY_CAPABILITIES = '*';
    const r = svc.resolve('chat.client_self');
    expect(r.provider).toBe('stub');
    // stub is always valid, so the gateway is "enabled" only in name —
    // resolve() reports enabled=false because provider==='stub'.
    expect(r.enabled).toBe(false);
  });

  it('default approval list includes consequential capabilities', () => {
    expect(DEFAULT_APPROVAL_REQUIRED.has('draft.coach_message')).toBe(true);
    expect(DEFAULT_APPROVAL_REQUIRED.has('draft.client_facing_claim')).toBe(true);
    expect(svc.requireApprovalFor('draft.coach_message')).toBe(true);
    expect(svc.requireApprovalFor('chat.client_self')).toBe(false);
  });

  it('requireApprovalFor honors explicit env override', () => {
    process.env.AI_GATEWAY_REQUIRE_APPROVAL = 'chat.client_self';
    expect(svc.requireApprovalFor('chat.client_self')).toBe(true);
    expect(svc.requireApprovalFor('draft.coach_message')).toBe(false);
  });
});
