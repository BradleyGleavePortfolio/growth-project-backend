// L1-gw — fail-closed `importer.mapping` gateway.
//
// Every block maps to one guarantee in the slice brief / review R581-B-B6:
//   G1 production fail-closed (refusal, not stub output)
//   G2 provider errors are typed, closed, never swallowed
//   G3 ordered models; fallback ONLY on 429/5xx/timeout and only if configured
//   G4 hard timeout, max output tokens, daily spend cap + kill switch, audit rows
//   G5 structured JSON against the supplied schema is mandatory
//   G6 existing gateway consumers unchanged
//
// No paid calls: a fake structured provider stands in for the real adapter.
// All of these fail on the base branch (the module under test does not exist).

import { z } from 'zod';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../src/prisma.service';
import type Anthropic from '@anthropic-ai/sdk';
import type { ConfigService } from '@nestjs/config';
import type { AnthropicProviderAdapter } from '../../src/ai/gateway/providers/anthropic-provider.adapter';
import { AiGatewayConfig } from '../../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../../src/ai/gateway/ai-redaction.service';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiProviderRegistry } from '../../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../../src/ai/gateway/providers/stub-provider.adapter';
import {
  AI_GATEWAY_ERROR_CODES,
  AiGatewayError,
  AnthropicStructuredProviderAdapter,
  AiStructuredProviderAdapter,
  AiStructuredProviderRequest,
  AiStructuredProviderRegistry,
  IMPORTER_MAPPING_CAPABILITY,
  IMPORTER_MAPPING_DEFAULTS,
  ImporterMappingConfig,
  ImporterMappingGatewayService,
  ImporterMappingRequest,
  JsonSchemaObject,
  structuredContractFromZod,
  RETRYABLE_AI_ERROR_CODES,
  StubStructuredProviderAdapter,
  toAiGatewayError,
} from '../../src/ai/gateway/structured';
import { COACH_AI_METERED_CAPABILITIES } from '../../src/ai-credits/ai-credits.constants';

// ── Test doubles ──────────────────────────────────────────────────────────────
//
// Partial structural doubles are widened with the repo's sanctioned
// `@ts-expect-error` escape (see src/regimes/__tests__/prisma-test-double.ts),
// never with a double assertion (R75).

interface PrismaDouble {
  audits: any[];
  callLogs: any[];
  aiRequestAudit: { create: jest.Mock; findMany: jest.Mock };
  aICallLog: { create: jest.Mock };
}

function asPrismaDouble(mock: PrismaDouble): PrismaService {
  // @ts-expect-error partial structural mock of PrismaService — only the two
  // delegates the gateway reads are stubbed (R0-sanctioned escape).
  return mock;
}

type CreateFn = (params: Record<string, any>, options: Record<string, any>) => Promise<unknown>;

function asAnthropicClient(
  create: jest.Mock<ReturnType<CreateFn>, Parameters<CreateFn>>,
): Anthropic {
  const mock = { messages: { create } };
  // @ts-expect-error partial structural mock of the Anthropic SDK client — the
  // adapter only calls messages.create (no network in tests).
  return mock;
}

function asConfigService(get: (key: string) => string | undefined): ConfigService {
  const mock = { get };
  // @ts-expect-error partial structural mock of ConfigService — only `get` is read.
  return mock;
}

function asLegacyAnthropicAdapter(): AnthropicProviderAdapter {
  const mock = { name: 'anthropic', complete: jest.fn() };
  // @ts-expect-error partial structural mock of the legacy adapter — never called
  // on the stub path under test.
  return mock;
}

type Plan =
  | {
      kind: 'ok';
      output: unknown;
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      stopReason?: string;
    }
  | { kind: 'http'; status: number }
  | { kind: 'hang' }
  | { kind: 'throw'; err: unknown };

class FakeStructuredProvider implements AiStructuredProviderAdapter {
  readonly name = 'anthropic';
  readonly calls: AiStructuredProviderRequest[] = [];
  private readonly plans: Plan[];
  constructor(plans: Plan[]) {
    this.plans = [...plans];
  }
  async completeStructured(req: AiStructuredProviderRequest) {
    this.calls.push(req);
    const plan = this.plans.shift() ?? { kind: 'ok', output: {} };
    if (plan.kind === 'http') {
      const e = Object.assign(new Error(`http ${plan.status}`), { status: plan.status });
      throw toAiGatewayError(e, { provider: this.name, model: req.model, attempt: 0 });
    }
    if (plan.kind === 'throw') throw plan.err;
    if (plan.kind === 'hang') {
      return new Promise<never>((_, reject) => {
        req.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    return {
      provider: this.name,
      model: plan.model ?? req.model,
      output: plan.output,
      enabled: true,
      promptTokens: plan.tokensIn ?? 1000,
      responseTokens: plan.tokensOut ?? 100,
      latencyMs: 5,
      stopReason: plan.stopReason ?? 'tool_use',
    };
  }
}

function buildPrisma(existingRows: Array<{ metadata: unknown }> = []): PrismaDouble {
  const audits: any[] = [];
  const callLogs: any[] = [];
  return {
    audits,
    callLogs,
    aiRequestAudit: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `audit-${audits.length + 1}`, ...data };
        audits.push(row);
        return row;
      }),
      findMany: jest.fn(async () => [
        ...existingRows,
        ...audits.map((a) => ({ metadata: a.metadata })),
      ]),
    },
    aICallLog: {
      create: jest.fn(async ({ data }: any) => {
        callLogs.push(data);
        return { id: `call-${callLogs.length}`, ...data };
      }),
    },
  };
}

function buildSvc(fake: AiStructuredProviderAdapter, prisma = buildPrisma()) {
  const gatewayConfig = new AiGatewayConfig();
  const config = new ImporterMappingConfig(gatewayConfig);
  const registry = new AiStructuredProviderRegistry(new StubStructuredProviderAdapter(), fake);
  const svc = new ImporterMappingGatewayService(
    asPrismaDouble(prisma),
    config,
    new AiRedactionService(),
    registry,
  );
  return { svc, prisma, config, registry };
}

const Proposal = z.object({ families: z.array(z.string()), confidence: z.number() }).strict();
const contract = structuredContractFromZod(Proposal);
const schema: JsonSchemaObject = contract.responseSchema;

type Req = ImporterMappingRequest<z.infer<typeof Proposal>>;

function baseRequest(overrides: Partial<Req> = {}): Req {
  return {
    requester: { id: 'coach-1', role: 'coach' },
    tenantCoachId: 'coach-1',
    systemPrompt: 'You map structure to canonical families.',
    userContent: 'digest: {"keys":["a","b"]} contact me at jane@example.com',
    responseSchema: schema,
    schemaName: 'mapping_proposal',
    parse: contract.parse,
    ...overrides,
  };
}

// Fully-open, non-production configuration. Individual tests close one gate.
function openEnv() {
  process.env.NODE_ENV = 'test';
  process.env.AI_GATEWAY_ENABLED = 'true';
  process.env.AI_GATEWAY_PROVIDER = 'anthropic';
  process.env.AI_GATEWAY_CAPABILITIES = IMPORTER_MAPPING_CAPABILITY;
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  process.env.SCOUT_LEARN_AI_ENABLED = 'true';
  process.env.AI_MODEL_IMPORTER_MAPPING = 'model-primary';
  delete process.env.SCOUT_LEARN_MODEL_FALLBACKS;
  process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '20';
  process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '200';
  delete process.env.SCOUT_LEARN_MAX_OUTPUT_TOKENS;
  delete process.env.AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER;
  delete process.env.AI_PRICE_INPUT_USD_PER_MTOK;
  delete process.env.AI_PRICE_OUTPUT_USD_PER_MTOK;
}

async function expectCode(p: Promise<unknown>, code: string) {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AiGatewayError);
  expect((caught as AiGatewayError).code).toBe(code);
  return caught as AiGatewayError;
}

const ORIGINAL_ENV = process.env;
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  openEnv();
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ── G1: production fail-closed ───────────────────────────────────────────────

describe('G1 — fail closed: refusal, never stub output', () => {
  it('refuses with ai_unavailable when the capability is not allow-listed (audit row records the reason)', async () => {
    process.env.AI_GATEWAY_CAPABILITIES = 'chat.client_self';
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('capability-not-allowed');
    expect(fake.calls).toHaveLength(0);
    expect(prisma.audits).toHaveLength(1);
    expect(prisma.audits[0]).toMatchObject({
      capability: IMPORTER_MAPPING_CAPABILITY,
      enabled: false,
      error: 'ai_unavailable',
    });
    expect(prisma.audits[0].metadata.resolved_reason).toBe('capability-not-allowed');
  });

  it('refuses with ai_unavailable when the provider key is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('provider-key-missing:anthropic');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses with ai_unavailable when the master gateway switch is off', async () => {
    delete process.env.AI_GATEWAY_ENABLED;
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('gateway-disabled');
  });

  it('kill switch: refuses with ai_unavailable when SCOUT_LEARN_AI_ENABLED is unset (default OFF)', async () => {
    delete process.env.SCOUT_LEARN_AI_ENABLED;
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('kill-switch-off');
    expect(fake.calls).toHaveLength(0);
  });

  it('production: stub provider resolution is a refusal, not a stub answer', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    const { svc, prisma } = buildSvc(new FakeStructuredProvider([]));
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('stub-provider-not-permitted');
    expect(prisma.audits[0].enabled).toBe(false);
  });

  it('production: the dev-only stub flag is ignored', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    process.env.AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER = 'true';
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
  });

  it('production: an unwired provider name (would be stub in the legacy registry) is ai_unavailable', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AI_GATEWAY_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'k';
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('provider-not-wired:openai');
  });

  it('production: an unset spend cap refuses (default is to refuse, not $20)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD;
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('spend-cap-unset');
    expect(fake.calls).toHaveLength(0);
  });

  it('non-production: an unset spend cap falls back to the owner placeholder ($20)', () => {
    delete process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD;
    const { config } = buildSvc(new FakeStructuredProvider([]));
    const r = config.resolve();
    expect(r.ok).toBe(true);
    expect(r.dailySpendCapUsd).toBe(IMPORTER_MAPPING_DEFAULTS.dailySpendUsdPlaceholder);
  });

  it('refuses with ai_unavailable when no model is configured', async () => {
    delete process.env.AI_MODEL_IMPORTER_MAPPING;
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('model-unset');
  });

  it('test mode: stub is permitted but returns enabled:false and output:null — never a proposal', async () => {
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    const { svc, prisma } = buildSvc(new FakeStructuredProvider([]));
    const res = await svc.invokeStructured(baseRequest());
    expect(res.enabled).toBe(false);
    expect(res.output).toBeNull();
    expect(res.provider).toBe('stub');
    expect(prisma.audits[0]).toMatchObject({ provider: 'stub', enabled: false, error: null });
    expect(prisma.audits[0].metadata.outcome).toBe('stub');
  });

  it('dev: stub is permitted only with the explicit flag', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    process.env.AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER = 'true';
    const res = await svc.invokeStructured(baseRequest());
    expect(res.enabled).toBe(false);
    expect(res.output).toBeNull();
  });
});

// ── G2: typed, closed provider errors ────────────────────────────────────────

describe('G2 — provider errors surface as typed closed codes', () => {
  it('the error code set is closed and only 429/5xx/timeout are retryable', () => {
    expect([...AI_GATEWAY_ERROR_CODES].sort()).toEqual(
      [
        'ai_budget_exhausted',
        'ai_malformed_output',
        'ai_provider_error',
        'ai_rate_limited',
        'ai_request_rejected',
        'ai_timeout',
        'ai_unavailable',
      ].sort(),
    );
    expect([...RETRYABLE_AI_ERROR_CODES].sort()).toEqual([
      'ai_provider_error',
      'ai_rate_limited',
      'ai_timeout',
    ]);
  });

  it('429 → ai_rate_limited (thrown, not swallowed), audit row carries the code and status', async () => {
    const fake = new FakeStructuredProvider([{ kind: 'http', status: 429 }]);
    const { svc, prisma } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.detail.httpStatus).toBe(429);
    expect(prisma.audits).toHaveLength(1);
    expect(prisma.audits[0]).toMatchObject({
      error: 'ai_rate_limited',
      enabled: false,
      model: 'model-primary',
    });
    expect(prisma.audits[0].metadata.http_status).toBe(429);
    expect(prisma.callLogs[0]).toMatchObject({ success: false, errorMessage: 'ai_rate_limited' });
  });

  it('5xx → ai_provider_error', async () => {
    const fake = new FakeStructuredProvider([{ kind: 'http', status: 503 }]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_provider_error');
    expect(err.retryable).toBe(true);
  });

  it('other 4xx → ai_request_rejected (not retryable)', async () => {
    const fake = new FakeStructuredProvider([{ kind: 'http', status: 401 }]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_request_rejected');
    expect(err.retryable).toBe(false);
  });

  it('a raw (untyped) adapter exception is mapped, never leaked and never swallowed', async () => {
    const fake = new FakeStructuredProvider([{ kind: 'throw', err: new Error('socket hang up') }]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_provider_error');
    expect(err.detail.reason).toBe('transport-error');
  });

  it('non-conforming output → ai_malformed_output (not retryable), response hash not written', async () => {
    const fake = new FakeStructuredProvider([{ kind: 'ok', output: { families: 'nope' } }]);
    const { svc, prisma } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    expect(err.retryable).toBe(false);
    expect(err.detail.reason).toBe('schema-validation-failed');
    expect(prisma.audits[0].response_hash).toBeNull();
  });

  it('output truncated at max_tokens → ai_malformed_output', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 }, stopReason: 'max_tokens' },
    ]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    expect(err.detail.reason).toBe('truncated-at-max-tokens');
  });

  it('an adapter that reports enabled:false is ai_unavailable, not a result', async () => {
    const fake: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: async (req) => ({
        provider: 'anthropic',
        model: req.model,
        output: { families: [], confidence: 1 },
        enabled: false,
        promptTokens: 1,
        responseTokens: 1,
        latencyMs: 1,
      }),
    };
    const { svc } = buildSvc(fake);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
  });
});

// ── G3: ordered models + fallback policy ─────────────────────────────────────

describe('G3 — ordered model list; fallback only on 429/5xx/timeout and only if configured', () => {
  it('no fallback configured: a 429 on the primary is thrown after exactly one attempt', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'http', status: 429 },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_rate_limited');
    expect(fake.calls).toHaveLength(1);
  });

  it('fallback configured: 429 on primary → fallback model used and recorded as the model actually used', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const fake = new FakeStructuredProvider([
      { kind: 'http', status: 429 },
      { kind: 'ok', output: { families: ['clients'], confidence: 0.9 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const res = await svc.invokeStructured(baseRequest());
    expect(res.output).toEqual({ families: ['clients'], confidence: 0.9 });
    expect(res.model).toBe('model-fallback');
    expect(res.attempts).toBe(2);
    expect(res.fallbackUsed).toBe(true);
    expect(fake.calls.map((c) => c.model)).toEqual(['model-primary', 'model-fallback']);
    // One audit row per attempt; the fallback row records where it came from.
    expect(prisma.audits).toHaveLength(2);
    expect(prisma.audits[0]).toMatchObject({
      model: 'model-primary',
      error: 'ai_rate_limited',
      enabled: false,
    });
    expect(prisma.audits[1]).toMatchObject({ model: 'model-fallback', error: null, enabled: true });
    expect(prisma.audits[1].metadata.fallback_from).toBe('model-primary');
    expect(prisma.audits[1].request_id).not.toBe(prisma.audits[0].request_id);
  });

  it('5xx on primary → fallback tried', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const fake = new FakeStructuredProvider([
      { kind: 'http', status: 502 },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const res = await svc.invokeStructured(baseRequest());
    expect(res.model).toBe('model-fallback');
  });

  it('timeout on primary → fallback tried', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const fake = new FakeStructuredProvider([
      { kind: 'hang' },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const res = await svc.invokeStructured(baseRequest());
    expect(res.model).toBe('model-fallback');
    expect(prisma.audits[0].error).toBe('ai_timeout');
  });

  it('malformed output on primary is NOT retried on the fallback', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { wrong: true } },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    expect(fake.calls).toHaveLength(1);
  });

  it('non-429 4xx on primary is NOT retried on the fallback', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const fake = new FakeStructuredProvider([
      { kind: 'http', status: 400 },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_request_rejected');
    expect(fake.calls).toHaveLength(1);
  });

  it('each listed model is tried at most once; the last error is thrown', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback, model-primary';
    const fake = new FakeStructuredProvider([
      { kind: 'http', status: 429 },
      { kind: 'http', status: 500 },
    ]);
    const { svc } = buildSvc(fake);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_provider_error');
    expect(fake.calls.map((c) => c.model)).toEqual(['model-primary', 'model-fallback']);
  });
});

// ── G4: limits, spend cap, audit ─────────────────────────────────────────────

describe('G4 — hard timeout, max output tokens, daily spend cap, audit', () => {
  it('a hung provider is cut at SCOUT_LEARN_CALL_TIMEOUT_MS: ai_timeout, signal aborted', async () => {
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '50';
    const fake = new FakeStructuredProvider([{ kind: 'hang' }]);
    const { svc, prisma } = buildSvc(fake);
    const t0 = Date.now();
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err.retryable).toBe(true);
    expect(fake.calls[0].signal.aborted).toBe(true);
    expect(fake.calls[0].timeoutMs).toBe(50);
    expect(prisma.audits[0]).toMatchObject({ error: 'ai_timeout', enabled: false });
    // A timed-out call is charged conservatively (input estimate + max_tokens).
    expect(prisma.audits[0].metadata.usd_estimate).toBeGreaterThan(0);
  });

  it('a provider that ignores the abort signal is still cut by the gateway race', async () => {
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '50';
    const neverResolves: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: () => new Promise<never>(() => undefined),
    };
    const { svc } = buildSvc(neverResolves);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_timeout');
  });

  it('passes the configured max output tokens and temperature 0; a request may only lower the cap', async () => {
    process.env.SCOUT_LEARN_MAX_OUTPUT_TOKENS = '2048';
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
      { kind: 'ok', output: { families: [], confidence: 1 } },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    await svc.invokeStructured(baseRequest());
    await svc.invokeStructured(baseRequest({ maxOutputTokens: 512 }));
    await svc.invokeStructured(baseRequest({ maxOutputTokens: 999_999 }));
    expect(fake.calls.map((c) => c.maxOutputTokens)).toEqual([2048, 512, 2048]);
    expect(fake.calls.every((c) => c.temperature === 0)).toBe(true);
  });

  it('default limits are 45 s and 4 096 output tokens', () => {
    delete process.env.SCOUT_LEARN_CALL_TIMEOUT_MS;
    const { config } = buildSvc(new FakeStructuredProvider([]));
    const r = config.resolve();
    expect(r.callTimeoutMs).toBe(45_000);
    expect(r.maxOutputTokens).toBe(4_096);
    expect(r.temperature).toBe(0);
  });

  it("daily spend cap: refuses with ai_budget_exhausted before the call when today's ledger + reservation exceeds the cap", async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    const prisma = buildPrisma([
      { metadata: { usd_estimate: 0.7 } },
      { metadata: { usd_estimate: 0.3 } },
    ]);
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(err.detail.reason).toBe('daily-spend-cap');
    expect(fake.calls).toHaveLength(0);
    expect(prisma.audits[0]).toMatchObject({ error: 'ai_budget_exhausted', enabled: false });
    expect(prisma.audits[0].metadata.spent_today_usd).toBe(1);
    expect(prisma.audits[0].metadata.spend_cap_usd).toBe(1);
  });

  it('daily spend cap reserves input estimate + max_tokens (a near-cap ledger refuses even with headroom below the reservation)', async () => {
    // Reservation for this request at default prices: ~30 input tokens ($0.0003) + 4096 output tokens ($0.2048).
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    const prisma = buildPrisma([{ metadata: { usd_estimate: 0.9 } }]);
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(0);
  });

  it('spend ledger accumulates across calls in the same UTC day and eventually refuses', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0';
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '100'; // $0.0001/token → 4096 max_tokens reserve = $0.4096
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 }, tokensOut: 4000 }, // $0.40
      { kind: 'ok', output: { families: [], confidence: 1 }, tokensOut: 4000 }, // $0.40 → 0.80 spent
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const r1 = await svc.invokeStructured(baseRequest());
    expect(r1.usdEstimate).toBeCloseTo(0.4, 6);
    await svc.invokeStructured(baseRequest());
    // 0.80 spent + 0.4096 reserve > 1 → refuse
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(2);
  });

  it('concurrent calls in one process count in-flight reservations (no joint overshoot)', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.5';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0';
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '100'; // reserve per call = $0.4096
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: async (req) => {
        await gate;
        return {
          provider: 'anthropic',
          model: req.model,
          output: { families: [], confidence: 1 },
          enabled: true,
          promptTokens: 0,
          responseTokens: 10,
          latencyMs: 1,
        };
      },
    };
    const { svc } = buildSvc(slow);
    const p1 = svc.invokeStructured(baseRequest());
    // Let p1 pass its cap check and register its reservation.
    await new Promise((r) => setImmediate(r));
    const p2 = expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    release();
    await Promise.all([p1, p2]);
  });

  it('an unreadable spend ledger is treated as cap reached (never opens the gate)', async () => {
    const prisma = buildPrisma();
    prisma.aiRequestAudit.findMany = jest.fn(async () => {
      throw new Error('db down');
    });
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(0);
  });

  it('a successful call writes AiRequestAudit + AICallLog with capability, model, tokens, latency, outcome — and no content', async () => {
    const fake = new FakeStructuredProvider([
      {
        kind: 'ok',
        output: { families: ['clients'], confidence: 0.8 },
        model: 'model-primary-2026',
        tokensIn: 2000,
        tokensOut: 300,
      },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const res = await svc.invokeStructured(
      baseRequest({
        auditMetadata: { promptTemplateVersion: 'v1', contractHash: 'abc', round: 1 },
        contextId: 'run-1',
      }),
    );
    expect(res.enabled).toBe(true);
    expect(res.output).toEqual({ families: ['clients'], confidence: 0.8 });
    expect(res.model).toBe('model-primary-2026');
    expect(res.auditId).toBe('audit-1');

    expect(prisma.audits).toHaveLength(1);
    const audit = prisma.audits[0];
    expect(audit).toMatchObject({
      capability: IMPORTER_MAPPING_CAPABILITY,
      provider: 'anthropic',
      model: 'model-primary-2026',
      enabled: true,
      prompt_token_estimate: 2000,
      response_token_estimate: 300,
      error: null,
      approval_status: 'not_required',
      requester_id: 'coach-1',
      tenant_coach_id: 'coach-1',
    });
    expect(typeof audit.prompt_hash).toBe('string');
    expect(typeof audit.response_hash).toBe('string');
    expect(audit.metadata).toMatchObject({
      outcome: 'ok',
      attempt: 0,
      promptTemplateVersion: 'v1',
      contractHash: 'abc',
      round: 1,
      context_id: 'run-1',
      max_output_tokens: 4096,
      timeout_ms: 200,
    });
    expect(typeof audit.metadata.latency_ms).toBe('number');
    // usd_estimate at default prices: 2000×$10/M + 300×$50/M = 0.02 + 0.015
    expect(audit.metadata.usd_estimate).toBeCloseTo(0.035, 6);
    // No prompt/response content anywhere in the persisted row.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('You map structure');
    expect(serialized).not.toContain('digest:');
    expect(serialized).not.toContain('clients');
    expect(serialized).not.toContain('example.com');

    expect(prisma.callLogs).toHaveLength(1);
    expect(prisma.callLogs[0]).toMatchObject({
      capability: IMPORTER_MAPPING_CAPABILITY,
      model: 'model-primary-2026',
      tokensIn: 2000,
      tokensOut: 300,
      success: true,
      errorMessage: null,
      coachId: 'coach-1',
      costCents: 4, // ceil(3.5)
    });
  });

  it('redacts the untrusted user content before it reaches the adapter and records the summary', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const res = await svc.invokeStructured(baseRequest());
    expect(fake.calls[0].userContent).not.toContain('jane@example.com');
    expect(res.redactionsApplied.email).toBe(1);
    expect(prisma.audits[0].redactions_applied.email).toBe(1);
  });

  it('an audit write failure is logged, not turned into a different outcome', async () => {
    const prisma = buildPrisma();
    prisma.aiRequestAudit.create = jest.fn(async () => {
      throw new Error('audit table down');
    });
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    const res = await svc.invokeStructured(baseRequest());
    expect(res.enabled).toBe(true);
    expect(res.auditId).toBe('');
  });

  it('importer.mapping is not charged to the coach Coach-AI credits (global cap only)', () => {
    expect(COACH_AI_METERED_CAPABILITIES.has(IMPORTER_MAPPING_CAPABILITY)).toBe(false);
  });
});

// ── G5: structured JSON output is mandatory ──────────────────────────────────

describe('G5 — structured output against a supplied JSON schema is mandatory', () => {
  it('the adapter receives the JSON schema, the schema name and the redacted content', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    await svc.invokeStructured(baseRequest());
    const call = fake.calls[0];
    expect(call.responseSchema).toBe(schema);
    expect(call.responseSchema.type).toBe('object');
    expect(call.schemaName).toBe('mapping_proposal');
    expect(call.capability).toBe(IMPORTER_MAPPING_CAPABILITY);
    expect(typeof call.requestId).toBe('string');
  });

  it('rejects a request without an object schema, a valid schema name, or a parser', async () => {
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    const noSchema = baseRequest();
    Reflect.deleteProperty(noSchema, 'responseSchema');
    await expectCode(svc.invokeStructured(noSchema), 'ai_malformed_output');
    const stringSchema: Req = {
      ...baseRequest(),
      responseSchema: { ...schema, type: 'string' as 'object' },
    };
    await expectCode(svc.invokeStructured(stringSchema), 'ai_malformed_output');
    await expectCode(
      svc.invokeStructured(baseRequest({ schemaName: 'bad name!' })),
      'ai_malformed_output',
    );
    const noParse = baseRequest();
    Reflect.deleteProperty(noParse, 'parse');
    await expectCode(svc.invokeStructured(noParse), 'ai_malformed_output');
  });

  it('structuredContractFromZod yields a plain object JSON schema (no zod metadata) and a matching parser', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['families', 'confidence']));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema)).not.toContain('~standard');
    expect(Object.keys(schema)).not.toContain('$schema');
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(contract.parse({ families: ['a'], confidence: 1 })).toEqual({
      families: ['a'],
      confidence: 1,
    });
    expect(() => contract.parse({ families: ['a'] })).toThrow();
    expect(() => structuredContractFromZod(z.string())).toThrow(AiGatewayError);
  });

  it('a non-object provider output is ai_malformed_output', async () => {
    const fake = new FakeStructuredProvider([{ kind: 'ok', output: '{"families":[]}' }]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    expect(err.detail.reason).toBe('output-not-object');
  });

  it('the real anthropic structured adapter forces tool-use against the schema, sets maxRetries:0, and passes signal/timeout', async () => {
    const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
      model: 'model-primary-2026',
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 34 },
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'mapping_proposal',
          input: { families: ['x'], confidence: 1 },
        },
      ],
    }));
    const adapter = new AnthropicStructuredProviderAdapter(
      asConfigService(() => 'k'),
      asAnthropicClient(create),
    );
    const controller = new AbortController();
    const res = await adapter.completeStructured({
      capability: IMPORTER_MAPPING_CAPABILITY,
      requestId: 'r1',
      model: 'model-primary',
      systemPrompt: 'sys',
      userContent: 'user',
      responseSchema: schema,
      schemaName: 'mapping_proposal',
      maxOutputTokens: 4096,
      temperature: 0,
      signal: controller.signal,
      timeoutMs: 45_000,
    });
    expect(res.output).toEqual({ families: ['x'], confidence: 1 });
    expect(res.model).toBe('model-primary-2026');
    expect(res.promptTokens).toBe(12);
    expect(res.responseTokens).toBe(34);
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe('model-primary');
    expect(params.max_tokens).toBe(4096);
    expect(params.temperature).toBe(0);
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe('mapping_proposal');
    expect(params.tools[0].input_schema).toBe(schema);
    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: 'mapping_proposal',
      disable_parallel_tool_use: true,
    });
    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBe(controller.signal);
    expect(options.timeout).toBe(45_000);
  });

  it('the real anthropic structured adapter maps SDK failures to typed codes and never returns a stub', async () => {
    const mk = (impl: () => Promise<unknown>) =>
      new AnthropicStructuredProviderAdapter(
        asConfigService(() => 'k'),
        asAnthropicClient(jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(impl)),
      );
    const req = {
      capability: IMPORTER_MAPPING_CAPABILITY,
      requestId: 'r1',
      model: 'm',
      systemPrompt: 'sys',
      userContent: 'user',
      responseSchema: schema,
      schemaName: 'mapping_proposal',
      maxOutputTokens: 10,
      temperature: 0,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    };
    await expectCode(
      mk(async () => {
        throw Object.assign(new Error('rl'), { status: 429 });
      }).completeStructured(req),
      'ai_rate_limited',
    );
    await expectCode(
      mk(async () => {
        throw Object.assign(new Error('boom'), { status: 529 });
      }).completeStructured(req),
      'ai_provider_error',
    );
    await expectCode(
      mk(async () => {
        throw Object.assign(new Error('t/o'), { name: 'APIConnectionTimeoutError' });
      }).completeStructured(req),
      'ai_timeout',
    );
    await expectCode(
      mk(async () => ({
        model: 'm',
        stop_reason: 'max_tokens',
        usage: {},
        content: [],
      })).completeStructured(req),
      'ai_malformed_output',
    );
    await expectCode(
      mk(async () => ({
        model: 'm',
        stop_reason: 'end_turn',
        usage: {},
        content: [{ type: 'text', text: 'prose' }],
      })).completeStructured(req),
      'ai_malformed_output',
    );
    // Missing key is a typed refusal, not a stub answer.
    const noKey = new AnthropicStructuredProviderAdapter(asConfigService(() => undefined));
    delete process.env.ANTHROPIC_API_KEY;
    await expectCode(noKey.completeStructured(req), 'ai_unavailable');
  });
});

// ── DI wiring ────────────────────────────────────────────────────────────────

describe('DI — the new providers resolve through Nest with the real registry/adapter classes', () => {
  it('boots and fails closed through the injected graph (no key, kill switch off)', async () => {
    delete process.env.SCOUT_LEARN_AI_ENABLED;
    const prisma = buildPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [
        { provide: PrismaService, useValue: asPrismaDouble(prisma) },
        AiGatewayConfig,
        AiRedactionService,
        ImporterMappingConfig,
        StubStructuredProviderAdapter,
        AnthropicStructuredProviderAdapter,
        AiStructuredProviderRegistry,
        ImporterMappingGatewayService,
      ],
    }).compile();
    const svc = moduleRef.get(ImporterMappingGatewayService);
    expect(svc).toBeInstanceOf(ImporterMappingGatewayService);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('kill-switch-off');
    expect(prisma.audits).toHaveLength(1);
    await moduleRef.close();
  });
});

// ── G6: existing consumers unchanged ─────────────────────────────────────────

describe('G6 — the legacy gateway path is untouched for other capabilities', () => {
  it('AiGatewayService.invoke still returns the stub for a disallowed capability (historical posture)', async () => {
    delete process.env.AI_GATEWAY_ENABLED;
    const prisma = buildPrisma();
    const legacy = new AiGatewayService(
      asPrismaDouble(prisma),
      new AiGatewayConfig(),
      new AiRedactionService(),
      new AiProviderRegistry(new StubProviderAdapter(), asLegacyAnthropicAdapter()),
    );
    const res = await legacy.invoke({
      capability: 'chat.client_self',
      requester: { id: 'u1', role: 'student' },
      userMessage: 'hi',
      systemPrompt: 'sys',
    });
    expect(res.enabled).toBe(false);
    expect(res.provider).toBe('stub');
    expect(res.draftMode).toBe(true);
  });
});
