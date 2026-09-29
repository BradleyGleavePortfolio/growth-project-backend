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
  AuditSpendLedger,
  SPEND_LEDGER,
  IMPORTER_MAPPING_CAPABILITY,
  IMPORTER_MAPPING_DEFAULTS,
  ImporterMappingConfig,
  ImporterMappingGatewayService,
  ImporterMappingRequest,
  IMPORTER_MAPPING_ENV_KEYS,
  INPUT_OVERHEAD_TOKENS,
  JsonSchemaObject,
  RESERVE_TX_OPTIONS,
  addMicros,
  advisoryLockKey,
  estimateInputTokens,
  microsToCentsCeil,
  parseUsdToMicros,
  tokenCostMicros,
  structuredContractFromZod,
  RETRYABLE_AI_ERROR_CODES,
  StubStructuredProviderAdapter,
  StructuredValidation,
  sumCharges,
  toAiGatewayError,
} from '../../src/ai/gateway/structured';
import { COACH_AI_METERED_CAPABILITIES } from '../../src/ai-credits/ai-credits.constants';
import { Prisma } from '@prisma/client';

// ── Test doubles ──────────────────────────────────────────────────────────────
//
// Partial structural doubles are widened with the repo's sanctioned
// `@ts-expect-error` escape (see src/regimes/__tests__/prisma-test-double.ts),
// never with a double assertion (R75).

interface PrismaDouble {
  audits: any[];
  callLogs: any[];
  lockCalls: string[];
  lockKeys: bigint[];
  txOptions: unknown[];
  // The database clock the double reports for `SELECT now()` (r3: the ledger
  // derives the accounting day from it). Tests set it to probe UTC midnight.
  clock: () => Date;
  aiRequestAudit: { create: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  aICallLog: { create: jest.Mock };
  $transaction: jest.Mock;
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
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

// In-memory Prisma double. `$transaction` hands the SAME double to the callback
// and serialises transactions through a mutex — the stand-in for the
// `pg_advisory_xact_lock` the real ledger takes (the raw SQL, the bound lock
// key and the transaction options are recorded so tests can assert them).
// `findMany` honours the `created_at` window and `id.not` filters the ledger
// uses; rows without a `created_at` (seeded `existingRows`) count as today.
// The REAL lock/window/visibility proof runs against PostgreSQL in
// test/ai/importer-mapping-spend-ledger.live.spec.ts.
function buildPrisma(existingRows: Array<{ metadata: unknown }> = []): PrismaDouble {
  const audits: any[] = [];
  const callLogs: any[] = [];
  const lockCalls: string[] = [];
  const lockKeys: bigint[] = [];
  const txOptions: unknown[] = [];
  let mutex: Promise<void> = Promise.resolve();
  const inWindow = (row: any, where: any): boolean => {
    const w = where?.created_at;
    if (!w || !(row.created_at instanceof Date)) return true;
    const t = row.created_at.getTime();
    if (w.gte instanceof Date && t < w.gte.getTime()) return false;
    if (w.lt instanceof Date && t >= w.lt.getTime()) return false;
    return true;
  };
  const double: PrismaDouble = {
    audits,
    callLogs,
    lockCalls,
    lockKeys,
    txOptions,
    clock: () => new Date(),
    aiRequestAudit: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `audit-${audits.length + 1}`, ...data };
        audits.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any = {}) =>
        [...existingRows.map((r, i) => ({ id: `seed-${i}`, ...r })), ...audits]
          .filter((a) => inWindow(a, where))
          .filter((a) => where?.id?.not == null || a.id !== where.id.not)
          .map((a) => ({ id: a.id, metadata: a.metadata })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = audits.find((a) => a.id === where.id);
        if (!row) throw new Error('row not found');
        Object.assign(row, data);
        return { id: row.id };
      }),
    },
    aICallLog: {
      create: jest.fn(async ({ data }: any) => {
        callLogs.push(data);
        return { id: `call-${callLogs.length}`, ...data };
      }),
    },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      lockCalls.push(strings.join('?'));
      for (const v of values) if (typeof v === 'bigint') lockKeys.push(v);
      return 0;
    }),
    $queryRaw: jest.fn(async () => [{ now: double.clock() }]),
    $transaction: jest.fn(async (fn: (tx: PrismaDouble) => Promise<unknown>, options?: unknown) => {
      txOptions.push(options);
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const prev = mutex;
      mutex = prev.then(() => mine);
      await prev;
      try {
        return await fn(double);
      } finally {
        release();
      }
    }),
  };
  return double;
}

// Seed a same-day ledger row charged `usd` (stored as integer µUSD, like the
// ledger writes it).
function chargedRow(usd: number): { metadata: unknown } {
  return { metadata: { charge_micros: Math.round(usd * 1_000_000), usd_estimate: usd } };
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
    new AuditSpendLedger(asPrismaDouble(prisma)),
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
    validate: contract.validate,
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
  delete process.env.SCOUT_LEARN_MAX_INPUT_TOKENS;
  delete process.env.AI_PROVIDER_IMPORTER_MAPPING;
  delete process.env.AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER;
  delete process.env.AI_PRICE_INPUT_USD_PER_MTOK;
  delete process.env.AI_PRICE_OUTPUT_USD_PER_MTOK;
}

// Production with EVERY money/model value set explicitly (production has no
// defaults for them, r3). Tests then unset one value to probe its refusal.
function productionEnv() {
  process.env.NODE_ENV = 'production';
  process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '20';
  process.env.AI_PRICE_INPUT_USD_PER_MTOK = '10';
  process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '50';
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
    productionEnv();
    process.env.AI_GATEWAY_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'k';
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('provider-not-wired:openai');
  });

  it('production: an unset spend cap refuses (default is to refuse, not $20)', async () => {
    productionEnv();
    delete process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD;
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('spend-cap-unset');
    expect(fake.calls).toHaveLength(0);
  });

  it('non-production: an unset spend cap falls back to the owner placeholder ($20, as integer µUSD)', () => {
    delete process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD;
    const { config } = buildSvc(new FakeStructuredProvider([]));
    const r = config.resolve();
    expect(r.ok).toBe(true);
    expect(r.dailySpendCapMicros).toBe(IMPORTER_MAPPING_DEFAULTS.dailySpendMicrosPlaceholder);
    expect(r.dailySpendCapMicros).toBe(20_000_000);
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

  it('default limits are 90 s (record D-L0-7.3), 24 000 input and 4 096 output tokens', () => {
    delete process.env.SCOUT_LEARN_CALL_TIMEOUT_MS;
    const { config } = buildSvc(new FakeStructuredProvider([]));
    const r = config.resolve();
    expect(r.callTimeoutMs).toBe(90_000);
    expect(r.maxInputTokens).toBe(24_000);
    expect(r.maxOutputTokens).toBe(4_096);
    expect(r.temperature).toBe(0);
  });

  it("daily spend cap: refuses with ai_budget_exhausted before the call when today's ledger + reservation exceeds the cap", async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    const prisma = buildPrisma([chargedRow(0.7), chargedRow(0.3)]);
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(err.detail.reason).toBe('daily-spend-cap');
    expect(fake.calls).toHaveLength(0);
    // No reservation row was inserted (nothing to charge), and the lock was taken.
    expect(prisma.audits).toHaveLength(0);
    expect(prisma.lockCalls.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('daily spend cap reserves input estimate + max_tokens (a near-cap ledger refuses even with headroom below the reservation)', async () => {
    // Reservation for this request at default prices: ~30 input tokens ($0.0003) + 4096 output tokens ($0.2048).
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    const prisma = buildPrisma([chargedRow(0.9)]);
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(0);
  });

  it('spend ledger accumulates across calls in the same UTC day and eventually refuses', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0.001'; // negligible (zero is refused, see r2 block)
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '100'; // $0.0001/token → 4096 max_tokens reserve ≈ $0.4096
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 }, tokensOut: 4000 }, // $0.40
      { kind: 'ok', output: { families: [], confidence: 1 }, tokensOut: 4000 }, // $0.40 → 0.80 spent
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    const r1 = await svc.invokeStructured(baseRequest());
    expect(r1.usdEstimate).toBeCloseTo(0.4, 4);
    await svc.invokeStructured(baseRequest());
    // 0.80 spent + 0.4096 reserve > 1 → refuse
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(2);
  });

  it('concurrent calls: the second reservation sees the first (committed reserved row), no joint overshoot', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.5';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0.001';
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
    const { svc, prisma } = buildSvc(slow);
    const p1 = svc.invokeStructured(baseRequest());
    // Let p1 commit its reservation and reach the provider.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(prisma.audits).toHaveLength(1);
    expect(prisma.audits[0].metadata.outcome).toBe('reserved');
    // p2 is refused at reservation time, while p1 is still in flight (the
    // gate is not released until p2 has been refused — deterministic).
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(prisma.audits).toHaveLength(1);
    release();
    await p1;
    // Settled to the actual charge afterwards.
    expect(prisma.audits[0].metadata.outcome).toBe('ok');
    expect(prisma.audits[0].metadata.usd_estimate).toBeLessThan(
      prisma.audits[0].metadata.usd_reserved,
    );
  });

  it('an unreadable spend ledger refuses (ai_unavailable, ledger-unavailable) — never opens the gate', async () => {
    const prisma = buildPrisma();
    prisma.aiRequestAudit.findMany = jest.fn(async () => {
      throw new Error('db down');
    });
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('ledger-unavailable');
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
        auditMetadata: { promptTemplateVersion: 'v1', contractHash: 'abcdef01', round: 1 },
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
      caller: { promptTemplateVersion: 'v1', contractHash: 'abcdef01', round: 1 },
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

  it('a reservation insert failure (e.g. requester_id FK) refuses BEFORE any provider call — fail closed', async () => {
    const prisma = buildPrisma();
    prisma.aiRequestAudit.create = jest.fn(async () => {
      throw new Error('FK violation requester_id');
    });
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('ledger-unavailable');
    expect(fake.calls).toHaveLength(0);
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
    const noValidate = baseRequest();
    Reflect.deleteProperty(noValidate, 'validate');
    await expectCode(svc.invokeStructured(noValidate), 'ai_malformed_output');
  });

  it('structuredContractFromZod yields a plain object JSON schema (no zod metadata) and a matching parser', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['families', 'confidence']));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema)).not.toContain('~standard');
    expect(Object.keys(schema)).not.toContain('$schema');
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(contract.validate({ families: ['a'], confidence: 1 })).toEqual({
      ok: true,
      value: { families: ['a'], confidence: 1 },
    });
    const bad = contract.validate({ families: ['a'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.errors[0]).toEqual({ path: '$.confidence', detail: expect.any(String) });
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
        { provide: SPEND_LEDGER, useClass: AuditSpendLedger },
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

// ── r2 — closures for R592-A (A1-A3, B1-B4) and R592-B (B1-B6) ──────────────
//
// Each test is a port of a reviewer probe, asserting the CORRECT behaviour;
// every one fails on 52196217 (the r1 head).

// A structurally identical copy of PR #591's readonly `JsonSchema` union
// (src/scout/learn/schema.ts). The gateway must accept it without a cast.
type LearnJsonSchema =
  | { readonly type: 'null' }
  | { readonly type: 'boolean' }
  | { readonly type: 'integer' | 'number'; readonly minimum?: number; readonly maximum?: number }
  | {
      readonly type: 'string';
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly enum?: readonly string[];
      readonly const?: string;
    }
  | { readonly type: 'array'; readonly items: LearnJsonSchema; readonly maxItems?: number }
  | {
      readonly type: 'object';
      readonly properties?: Readonly<Record<string, LearnJsonSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: false | LearnJsonSchema;
    }
  | { readonly anyOf: readonly LearnJsonSchema[] };

function learnSchema(): LearnJsonSchema {
  return {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
    additionalProperties: false,
  };
}

describe('r2 — spend: reserve-before-call in the ledger (R592-A-A1/A2, R592-B-B1/B2/B3)', () => {
  const okAt = (tokensOut: number) =>
    new FakeStructuredProvider(
      Array.from({ length: 12 }, () => ({
        kind: 'ok' as const,
        output: { families: [], confidence: 1 },
        tokensIn: 0,
        tokensOut,
      })),
    );
  function tightCap() {
    // Reserve per call = 2000 max_tokens × $100/MTok = $0.20, plus the input
    // estimate (~1.1k tokens incl. the fixed overhead) at $0.001/MTok, which
    // rounds UP to 2 µUSD (a reservation is never rounded to zero).
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.31';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0.001';
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '100';
    process.env.SCOUT_LEARN_MAX_OUTPUT_TOKENS = '2000';
  }

  it('A2/B-B1: when the ledger cannot persist the reservation, sequential calls are ALL refused (no paid call slips through)', async () => {
    tightCap();
    const prisma = buildPrisma();
    prisma.aiRequestAudit.create = jest.fn(async () => {
      throw new Error('audit unavailable');
    });
    const fake = okAt(1000);
    const { svc } = buildSvc(fake, prisma);
    for (let i = 0; i < 4; i++)
      await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(fake.calls).toHaveLength(0);
  });

  it('A1/B-B2: the reservation is committed before the provider is called and settled after — a second caller during the call is refused', async () => {
    tightCap();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const prisma = buildPrisma();
    const slow: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: async (req) => {
        seen.push(prisma.audits.map((a) => a.metadata.outcome).join(','));
        await gate;
        return {
          provider: 'anthropic',
          model: req.model,
          output: { families: [], confidence: 1 },
          enabled: true,
          promptTokens: 0,
          responseTokens: 1000,
          latencyMs: 1,
        };
      },
    };
    const { svc } = buildSvc(slow, prisma);
    const p1 = svc.invokeStructured(baseRequest());
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // The reserved row existed when the provider was entered.
    expect(seen).toEqual(['reserved']);
    // Cap 0.31, reserved 0.2 → a second 0.2 reservation is refused while p1 is in flight.
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    release();
    const r1 = await p1;
    // 1000 output tokens × $100/MTok = $0.10 exactly; input: 0 tokens → 0.
    expect(r1.chargeMicros).toBe(100_000);
    expect(r1.usdEstimate).toBeCloseTo(0.1, 6);
    expect(prisma.audits[0].metadata).toMatchObject({
      outcome: 'ok',
      charge_micros: 100_000,
      usd_estimate: 0.1,
      usage_basis: 'provider',
    });
    // Reserved = 2000 max_tokens × $100/MTok ($0.20) + the input estimate at $0.001/MTok.
    expect(prisma.audits[0].metadata.reserved_micros).toBeGreaterThanOrEqual(200_000);
    expect(prisma.audits[0].metadata.reserved_micros).toBeLessThan(201_000);
    // Now 0.1 spent → one more fits, then refused.
    await svc.invokeStructured(baseRequest());
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
  });

  it('A1: two gateway instances against one ledger cannot both reserve past the cap (advisory lock + committed reservation)', async () => {
    tightCap();
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.25'; // room for exactly one $0.20 reservation
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prisma = buildPrisma();
    const mk = (calls: unknown[]): AiStructuredProviderAdapter => ({
      name: 'anthropic',
      completeStructured: async (req) => {
        calls.push(req.model);
        await gate;
        return {
          provider: 'anthropic',
          model: req.model,
          output: { families: [], confidence: 1 },
          enabled: true,
          promptTokens: 0,
          responseTokens: 1000,
          latencyMs: 1,
        };
      },
    });
    const calls1: unknown[] = [];
    const calls2: unknown[] = [];
    const { svc: instance1 } = buildSvc(mk(calls1), prisma);
    const { svc: instance2 } = buildSvc(mk(calls2), prisma);
    const a = instance1.invokeStructured(baseRequest());
    const b = instance2.invokeStructured(baseRequest());
    // One of the two is refused before the gate opens; observe it so the
    // rejection is not flagged as unhandled while we wait.
    const observedA = a.catch((e: unknown) => e);
    const observedB = b.catch((e: unknown) => e);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(calls1.length + calls2.length).toBe(1);
    release();
    await Promise.all([observedA, observedB]);
    const results = await Promise.allSettled([a, b]);
    const codes = results
      .map((r) => (r.status === 'rejected' ? (r.reason as AiGatewayError).code : 'ok'))
      .sort();
    expect(codes).toEqual(['ai_budget_exhausted', 'ok']);
    expect(prisma.lockCalls.filter((q) => q.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('A2: a ledger row whose charge is missing or malformed closes the gate (never counted as $0)', async () => {
    tightCap();
    const prisma = buildPrisma([{ metadata: { outcome: 'ok' } }]);
    const fake = okAt(10);
    const { svc } = buildSvc(fake, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(err.detail.reason).toBe('ledger-malformed');
    expect(fake.calls).toHaveLength(0);
    expect(sumCharges([chargedRow(0.1), chargedRow(0.2)])).toBe(300_000);
    // Only the integer field counts: a float-only row (r2 shape) or a
    // non-integer / negative / unsafe charge is a defect, never $0.
    expect(sumCharges([{ metadata: { usd_estimate: 0.1 } }])).toBeNull();
    expect(sumCharges([{ metadata: { charge_micros: 'x' } }])).toBeNull();
    expect(sumCharges([{ metadata: { charge_micros: 0.5 } }])).toBeNull();
    expect(sumCharges([{ metadata: { charge_micros: -1 } }])).toBeNull();
    expect(sumCharges([{ metadata: { charge_micros: Number.MAX_SAFE_INTEGER } }])).toBeNull();
    expect(sumCharges([{ metadata: null }])).toBeNull();
    expect(sumCharges([])).toBe(0);
  });

  it('a timed-out attempt keeps the conservative maximum charge (usage unknown); a settle failure leaves the reservation at max', async () => {
    tightCap();
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '5';
    const prisma = buildPrisma();
    const { svc } = buildSvc(new FakeStructuredProvider([{ kind: 'hang' }]), prisma);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_timeout');
    expect(prisma.audits[0].metadata.outcome).toBe('ai_timeout');
    expect(prisma.audits[0].metadata.usd_estimate).toBeCloseTo(0.2, 3);

    const prisma2 = buildPrisma();
    prisma2.aiRequestAudit.update = jest.fn(async () => {
      throw new Error('settle failed');
    });
    const { svc: svc2 } = buildSvc(okAt(10), prisma2);
    const r = await svc2.invokeStructured(baseRequest());
    expect(r.enabled).toBe(true);
    expect(prisma2.audits[0].metadata).toMatchObject({
      outcome: 'reserved',
      usd_estimate: prisma2.audits[0].metadata.usd_reserved,
    });
  });

  it('B-B3: the ledger is a port (SPEND_LEDGER); a replacement ledger is consulted and its refusal is final', async () => {
    const fake = okAt(10);
    const reserve = jest.fn(async () => {
      throw new AiGatewayError('ai_budget_exhausted', { reason: 'daily-spend-cap' });
    });
    const svc = new ImporterMappingGatewayService(
      asPrismaDouble(buildPrisma()),
      new ImporterMappingConfig(new AiGatewayConfig()),
      new AiRedactionService(),
      new AiStructuredProviderRegistry(new StubStructuredProviderAdapter(), fake),
      { reserve, settle: jest.fn(async () => ({ ok: true, overage: false, capExceeded: false })) },
    );
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('r2 — audit metadata allow-list (R592-A-A3)', () => {
  it('a caller cannot overwrite the charge: unknown keys such as usd_estimate reject the request before any call', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const evil: ImporterMappingRequest<unknown> = {
      ...baseRequest(),
      // @ts-expect-error probing a key outside the allow-list
      auditMetadata: { usd_estimate: 0 },
    };
    await expect(svc.invokeStructured(evil)).rejects.toThrow('auditMetadata key not allowed');
    expect(fake.calls).toHaveLength(0);
    expect(prisma.audits).toHaveLength(0);
  });

  it('a caller cannot persist free text: `description` is rejected and nothing with the marker reaches the row', async () => {
    const secret = 'PRIVATE_CLIENT_NAME_ABC';
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const evil: ImporterMappingRequest<unknown> = {
      ...baseRequest(),
      // @ts-expect-error probing a free-text key
      auditMetadata: { description: secret },
    };
    await expect(svc.invokeStructured(evil)).rejects.toThrow('auditMetadata key not allowed');
    expect(JSON.stringify(prisma.audits)).not.toContain(secret);
    // Allowed keys are typed: a version with free text is rejected too.
    await expect(
      svc.invokeStructured(
        baseRequest({ auditMetadata: { promptTemplateVersion: `v1 ${secret}` } }),
      ),
    ).rejects.toThrow('auditMetadata.promptTemplateVersion invalid');
    expect(prisma.audits).toHaveLength(0);
  });

  it('allowed keys are nested under metadata.caller so they can never shadow computed fields', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    await svc.invokeStructured(baseRequest({ auditMetadata: { callKind: 'repair', round: 2 } }));
    expect(prisma.audits[0].metadata.caller).toEqual({ callKind: 'repair', round: 2 });
    expect(prisma.audits[0].metadata.usd_estimate).toBeGreaterThan(0);
    expect(prisma.audits[0].ip).toBeNull();
    expect(prisma.audits[0].user_agent).toBeNull();
  });

  it('requester must be a real User with an allowed role — no system requester path', async () => {
    const { svc } = buildSvc(new FakeStructuredProvider([]));
    await expect(
      svc.invokeStructured(baseRequest({ requester: { id: 'system', role: 'system' } })),
    ).rejects.toThrow('requester.role not allowed');
    await expect(
      svc.invokeStructured(baseRequest({ requester: { id: '', role: 'coach' } })),
    ).rejects.toThrow('requester.id');
  });
});

describe('r2 — kill switch re-checked before every attempt and while in flight (R592-A-B1)', () => {
  it('flipped while the provider is in flight: the call is aborted and refused, not returned', async () => {
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '5000';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aborted = false;
    const slow: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: async (req) => {
        req.signal.addEventListener('abort', () => (aborted = true));
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
    const { svc, prisma } = buildSvc(slow);
    const pending = svc.invokeStructured(baseRequest());
    await new Promise((r) => setTimeout(r, 20));
    process.env.SCOUT_LEARN_AI_ENABLED = 'false';
    const err = await expectCode(pending, 'ai_unavailable');
    expect(err.detail.reason).toBe('kill-switch-off');
    expect(aborted).toBe(true);
    release();
    // Charged at the conservative maximum (usage unknown after an abort).
    expect(prisma.audits[0].metadata.outcome).toBe('ai_unavailable');
    expect(prisma.audits[0].metadata.usd_estimate).toBe(prisma.audits[0].metadata.usd_reserved);
  });

  it('flipped during the first attempt: the configured fallback is NOT started', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const models: string[] = [];
    const provider: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: async (req) => {
        models.push(req.model);
        process.env.SCOUT_LEARN_AI_ENABLED = 'false';
        throw toAiGatewayError(Object.assign(new Error('rate limit'), { status: 429 }), {
          provider: 'anthropic',
          model: req.model,
          attempt: 0,
        });
      },
    };
    const { svc } = buildSvc(provider);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('kill-switch-off');
    expect(models).toEqual(['model-primary']);
  });
});

describe('r2 — strict config (R592-A-B2, R592-B-B5, R592-B-C4, R592-B-C2)', () => {
  it('zero / NaN / negative prices refuse (config-invalid), even with a zero cap', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, config } = buildSvc(fake);
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0';
    for (const price of ['0', '-1', 'NaN', 'abc', '1e3', '0.0000001', '']) {
      process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = price;
      if (price === '') {
        expect(config.resolve().ok).toBe(true); // unset → default (non-production), then the $0 cap refuses
        await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
      } else {
        const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
        expect(err.detail.reason).toBe('config-invalid:AI_PRICE_OUTPUT_USD_PER_MTOK');
      }
    }
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '50';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0';
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(fake.calls).toHaveLength(0);
  });

  it('durations are parsed strictly with units; garbage refuses instead of defaulting', () => {
    const { config } = buildSvc(new FakeStructuredProvider([]));
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '90s';
    expect(config.resolve()).toMatchObject({ ok: true, callTimeoutMs: 90_000 });
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '2m';
    expect(config.resolve().callTimeoutMs).toBe(120_000);
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '1500ms';
    expect(config.resolve().callTimeoutMs).toBe(1_500);
    for (const bad of ['90 s', '1.5s', '-1', 'soon', '0']) {
      process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = bad;
      const r = config.resolve();
      expect(r.ok).toBe(false);
      expect(r.refusalReason).toBe('config-invalid:SCOUT_LEARN_CALL_TIMEOUT_MS');
    }
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '200';
    process.env.SCOUT_LEARN_MAX_OUTPUT_TOKENS = '-1';
    expect(config.resolve()).toMatchObject({
      ok: false,
      refusalReason: 'config-invalid:positive-integer',
    });
    process.env.SCOUT_LEARN_MAX_OUTPUT_TOKENS = '4096';
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '20 dollars';
    expect(config.resolve()).toMatchObject({
      ok: false,
      refusalReason: 'config-invalid:SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD',
    });
  });

  it('C2: AI_PROVIDER_IMPORTER_MAPPING selects the provider for this capability; the global setting is the default', () => {
    const { config } = buildSvc(new FakeStructuredProvider([]));
    expect(config.resolve().provider).toBe('anthropic');
    process.env.AI_PROVIDER_IMPORTER_MAPPING = 'stub';
    expect(config.resolve()).toMatchObject({ provider: 'stub', stubPermitted: true });
    productionEnv();
    expect(config.resolve()).toMatchObject({
      ok: false,
      refusalReason: 'stub-provider-not-permitted',
    });
    process.env.AI_PROVIDER_IMPORTER_MAPPING = 'anthropic';
    process.env.AI_GATEWAY_PROVIDER = 'stub';
    expect(config.resolve()).toMatchObject({ ok: true, provider: 'anthropic' });
  });

  it('B-B6: every env key the capability reads is registered in prod-switches.yml with the agreed posture', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const yaml = fs.readFileSync(path.resolve(__dirname, '../../prod-switches.yml'), 'utf8');
    for (const key of IMPORTER_MAPPING_ENV_KEYS) expect(yaml).toContain(`- name: ${key}\n`);
    const row = (name: string) =>
      yaml
        .slice(yaml.indexOf(`- name: ${name}\n`))
        .split('\n')
        .slice(0, 6)
        .join('\n');
    expect(row('SCOUT_LEARN_AI_ENABLED')).toContain('tier: feature');
    expect(row('SCOUT_LEARN_AI_ENABLED')).toContain('prod_default: OFF');
    expect(row('SCOUT_LEARN_AI_ENABLED')).toContain('auto_flip_on_in_prod: false');
    expect(row('AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER')).toContain('prod_default: OFF');
    expect(row('SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD')).toContain('prod_default: MUST_SET');
    // Keys are read through in-file consts (`process.env[ENV_X]`) so discovery finds them.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/ai/gateway/structured/importer-mapping.config.ts'),
      'utf8',
    );
    for (const key of IMPORTER_MAPPING_ENV_KEYS) expect(src).toContain(`= '${key}'`);
  });
});

describe('r2 — adapter: exactly one tool call (R592-A-B3); conservative input estimate and cap (R592-A-B4)', () => {
  const req: AiStructuredProviderRequest = {
    capability: IMPORTER_MAPPING_CAPABILITY,
    requestId: 'r',
    model: 'model-primary',
    systemPrompt: 'trusted',
    userContent: 'digest',
    schemaName: 'result',
    responseSchema: { type: 'object' },
    maxOutputTokens: 100,
    temperature: 0,
    signal: new AbortController().signal,
    timeoutMs: 1000,
  };
  const adapterWith = (content: unknown[], stop = 'tool_use') =>
    new AnthropicStructuredProviderAdapter(
      asConfigService(() => 'fake-test-key'),
      asAnthropicClient(
        jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
          model: 'model-primary',
          stop_reason: stop,
          usage: { input_tokens: 5, output_tokens: 5 },
          content,
        })),
      ),
    );

  it('two tool-use blocks are ambiguous → ai_malformed_output', async () => {
    const err = await expectCode(
      adapterWith([
        { type: 'tool_use', name: 'result', input: { good: true } },
        { type: 'tool_use', name: 'result', input: { good: false } },
      ]).completeStructured(req),
      'ai_malformed_output',
    );
    expect(err.detail.reason).toBe('ambiguous-structured-output');
  });

  it('a foreign tool name, a non-text extra block, or an unexpected stop reason are rejected; one matching call passes', async () => {
    await expectCode(
      adapterWith([{ type: 'tool_use', name: 'other', input: {} }]).completeStructured(req),
      'ai_malformed_output',
    );
    await expectCode(
      adapterWith([
        { type: 'tool_use', name: 'result', input: {} },
        { type: 'server_tool_use', name: 'x', input: {} },
      ]).completeStructured(req),
      'ai_malformed_output',
    );
    const stop = await expectCode(
      adapterWith([{ type: 'tool_use', name: 'result', input: {} }], 'end_turn').completeStructured(
        req,
      ),
      'ai_malformed_output',
    );
    expect(stop.detail.reason).toBe('unexpected-stop-reason');
    const ok = await adapterWith([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', name: 'result', input: { good: true } },
    ]).completeStructured(req);
    expect(ok.output).toEqual({ good: true });
  });

  it('B4: the input estimate is conservative (≥ chars/2 incl. schema) and an over-limit request is refused before any spend', async () => {
    expect(estimateInputTokens('a'.repeat(1000))).toBeGreaterThanOrEqual(500);
    process.env.SCOUT_LEARN_MAX_INPUT_TOKENS = '100';
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const err = await expectCode(
      svc.invokeStructured(baseRequest({ userContent: 'x'.repeat(400) })),
      'ai_request_rejected',
    );
    expect(err.detail.reason).toBe('input-too-large');
    expect(err.retryable).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(prisma.audits[0].metadata.usd_estimate).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('B4: actual usage above the estimate is charged as actual, re-checked under the day lock, and recorded as an overage', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 }, tokensIn: 100_000, tokensOut: 10 },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const r = await svc.invokeStructured(baseRequest());
    expect(r.usdEstimate).toBeGreaterThan(1); // 100k × $10/M
    expect(r.chargeMicros).toBe(1_000_000 + 500); // 100k in × $10/MTok + 10 out × $50/MTok
    expect(prisma.audits[0].metadata.charge_micros).toBeGreaterThan(
      prisma.audits[0].metadata.reserved_micros,
    );
    expect(prisma.audits[0].metadata.overage_micros).toBe(
      prisma.audits[0].metadata.charge_micros - prisma.audits[0].metadata.reserved_micros,
    );
    expect(prisma.audits[0].metadata.cap_exceeded).toBe(false); // $1.0005 < $20 cap
    // The overage settlement took the day lock (second locked transaction).
    expect(prisma.lockCalls.filter((q) => q.includes('pg_advisory_xact_lock'))).toHaveLength(2);
  });
});

describe('r2 — readonly schema + validator errors for the repair call (R592-B-B4)', () => {
  it("accepts PR #591's readonly JsonSchema union and a LearnParseResult-shaped validator without casts", async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { ok: true } },
      { kind: 'ok', output: { ok: false } },
    ]);
    const { svc } = buildSvc(fake);
    const validate = (raw: unknown): StructuredValidation<{ ok: boolean }> => {
      const obj = raw as { ok?: unknown };
      return typeof obj.ok === 'boolean'
        ? { ok: true, value: { ok: obj.ok } }
        : { ok: false, errors: [{ path: '$.ok', detail: 'expected boolean' }] };
    };
    const schemaWithTitle: Record<string, unknown> = { title: 'proposal', ...learnSchema() };
    const r = await svc.invokeStructured({
      requester: { id: 'coach-1', role: 'coach' },
      systemPrompt: 'sys',
      userContent: 'digest',
      responseSchema: learnSchema(),
      schemaName: 'proposal',
      validate,
    });
    expect(r.output).toEqual({ ok: true });
    const r2 = await svc.invokeStructured({
      ...baseRequest(),
      responseSchema: schemaWithTitle,
      schemaName: 'proposal',
      validate,
    });
    expect(r2.enabled).toBe(true);
  });

  it('a validation failure returns the content-free errors and the raw object on the error, and persists neither', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: 'nope', confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    expect(err.detail.reason).toBe('schema-validation-failed');
    expect(err.validation?.errors[0]).toEqual({ path: '$.families', detail: expect.any(String) });
    expect(err.validation?.rawOutput).toEqual({ families: 'nope', confidence: 1 });
    expect(JSON.stringify(err.detail)).not.toContain('$.families');
    expect(JSON.stringify(prisma.audits)).not.toContain('nope');
    expect(prisma.audits[0].metadata.validation_error_count).toBe(1);
  });
});

// ── r3: closures for the c7 audits (R592-c7A-01..07, R592-c7B-01..03, C01/C02/C05/C06) ──
//
// The r3 blocks below drive the REAL AnthropicStructuredProviderAdapter (mock
// SDK client, no network) through the real gateway and the real
// AuditSpendLedger, exactly as auditor B's probe did — and assert the
// opposite outcome: every billed response settles its actual usage.

function realAdapterSvc(
  create: jest.Mock<ReturnType<CreateFn>, Parameters<CreateFn>>,
  prisma = buildPrisma(),
) {
  const adapter = new AnthropicStructuredProviderAdapter(
    asConfigService(() => 'k'),
    asAnthropicClient(create),
  );
  return { ...buildSvc(adapter, prisma), create };
}

// Default prices ($10 / $50 per MTok) → 20 000 in + 4 096 out = $0.4048 = 404 800 µUSD.
const BILLED_USAGE = { input_tokens: 20_000, output_tokens: 4_096 };
const BILLED_MICROS = 20_000 * 10 + 4_096 * 50;

describe('r3 — money is integer µUSD, rounded up; a reservation is never zero (R592-c7A-01, R592-c7B-C02)', () => {
  it('parseUsdToMicros: decimal strings become exact integers; floats, signs, exponents and >6 decimals are rejected', () => {
    expect(parseUsdToMicros('20')).toBe(20_000_000);
    expect(parseUsdToMicros('0.1')).toBe(100_000);
    expect(parseUsdToMicros('0.2')).toBe(200_000);
    expect(parseUsdToMicros('3.75')).toBe(3_750_000);
    expect(parseUsdToMicros('0.000001')).toBe(1);
    expect(parseUsdToMicros('0')).toBe(0);
    for (const bad of ['0.0000001', '-1', '1e3', 'NaN', 'abc', '', '.5', '1.', '1_000']) {
      expect(parseUsdToMicros(bad)).toBeNull();
    }
    // 0.1 + 0.2 is exactly 0.3 in µUSD.
    expect(addMicros(parseUsdToMicros('0.1')!, parseUsdToMicros('0.2')!)).toBe(
      parseUsdToMicros('0.3'),
    );
  });

  it('tokenCostMicros rounds UP: any positive token count at any positive price costs at least 1 µUSD', () => {
    expect(tokenCostMicros(1, 1)).toBe(1); // 1 token at $0.000001/MTok
    expect(tokenCostMicros(1_000, 1)).toBe(1);
    expect(tokenCostMicros(1_000_001, 1)).toBe(2);
    expect(tokenCostMicros(0, 50_000_000)).toBe(0);
    expect(tokenCostMicros(4_096, 50_000_000)).toBe(204_800);
    expect(() => tokenCostMicros(-1, 1)).toThrow(RangeError);
    expect(() => tokenCostMicros(1.5, 1)).toThrow(RangeError);
    expect(() => tokenCostMicros(1, -1)).toThrow(RangeError);
    expect(microsToCentsCeil(35_000)).toBe(4);
    expect(microsToCentsCeil(1)).toBe(1);
    expect(microsToCentsCeil(0)).toBe(0);
  });

  it('A-01: a $0 cap with the smallest accepted positive prices refuses EVERY paid call (r2 rounded the reservation to $0 and admitted it)', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0.000001';
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '0.000001';
    const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
      model: 'model-primary',
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [
        { type: 'tool_use', name: 'mapping_proposal', input: { families: [], confidence: 1 } },
      ],
    }));
    const { svc, prisma } = realAdapterSvc(create);
    for (let i = 0; i < 5; i++) {
      const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
      expect(err.detail.reason).toBe('daily-spend-cap');
    }
    expect(create).not.toHaveBeenCalled();
    expect(prisma.audits).toHaveLength(0);
  });

  it('A-01: tiny prices accumulate — the reservation is ≥ 1 µUSD per side and the cap is reached', async () => {
    // $0.000003 cap; each call reserves ≥ 2 µUSD (1 in + 1 out) → the second call cannot fit.
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.000003';
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '0.000001';
    process.env.AI_PRICE_OUTPUT_USD_PER_MTOK = '0.000001';
    const fake = new FakeStructuredProvider(
      Array.from({ length: 3 }, () => ({
        kind: 'ok' as const,
        output: { families: [], confidence: 1 },
        tokensIn: 1,
        tokensOut: 1,
      })),
    );
    const { svc, prisma } = buildSvc(fake);
    const r1 = await svc.invokeStructured(baseRequest());
    expect(r1.chargeMicros).toBe(2);
    expect(prisma.audits[0].metadata.reserved_micros).toBe(2);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(1);
  });

  it('the ledger refuses a non-positive or non-integer reservation and never inserts it', async () => {
    const prisma = buildPrisma();
    const ledger = new AuditSpendLedger(asPrismaDouble(prisma));
    const audit = {
      requestId: 'r',
      requesterId: 'coach-1',
      requesterRole: 'coach',
      tenantCoachId: null,
      provider: 'anthropic',
      model: 'm',
      promptHash: 'h',
      redactions: null,
      metadata: {},
    };
    for (const maxMicros of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await expectCode(
        ledger.reserve({
          capability: IMPORTER_MAPPING_CAPABILITY,
          capMicros: 1_000,
          maxMicros,
          audit,
        }),
        'ai_unavailable',
      );
      expect(err.detail.reason).toBe('ledger-invalid-amount');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.audits).toHaveLength(0);
  });

  it('all charge fields on ledger rows are integers (charge_micros / reserved_micros / spend_cap_micros); usd_* are derived for display', async () => {
    const { svc, prisma } = buildSvc(
      new FakeStructuredProvider([
        { kind: 'ok', output: { families: [], confidence: 1 }, tokensIn: 2000, tokensOut: 300 },
      ]),
    );
    await svc.invokeStructured(baseRequest());
    const m = prisma.audits[0].metadata;
    expect(Number.isSafeInteger(m.charge_micros)).toBe(true);
    expect(Number.isSafeInteger(m.reserved_micros)).toBe(true);
    expect(Number.isSafeInteger(m.spend_cap_micros)).toBe(true);
    expect(Number.isSafeInteger(m.spent_before_micros)).toBe(true);
    expect(m.charge_micros).toBe(35_000);
    expect(m.usd_estimate).toBe(0.035);
    expect(m.spend_cap_micros).toBe(20_000_000);
    expect(prisma.callLogs[0].costCents).toBe(4);
  });
});

describe('r3 — every billed response settles its ACTUAL usage; unknown usage keeps the reservation (R592-c7A-02, R592-c7B-01)', () => {
  const settledCharges = (prisma: PrismaDouble) =>
    prisma.audits.map((a) => a.metadata.charge_micros as number);

  it('B-01 probe, inverted: 10 responses truncated at max_tokens against a $1 cap → each is charged $0.4048 and the cap refuses from the third call', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '1';
    const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
      model: 'model-primary',
      stop_reason: 'max_tokens',
      usage: BILLED_USAGE,
      content: [
        { type: 'tool_use', name: 'mapping_proposal', input: { families: [], confidence: 1 } },
      ],
    }));
    const { svc, prisma } = realAdapterSvc(create);
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      try {
        await svc.invokeStructured(baseRequest());
        codes.push('ok');
      } catch (e) {
        codes.push(AiGatewayError.is(e) ? e.code : 'other');
      }
    }
    // Two paid calls fit under $1 ($0.4048 each); the reservation for the
    // third (~$0.42 at default prices) does not.
    expect(codes.slice(0, 2)).toEqual(['ai_malformed_output', 'ai_malformed_output']);
    expect(codes.slice(2).every((c) => c === 'ai_budget_exhausted')).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(settledCharges(prisma)).toEqual([BILLED_MICROS, BILLED_MICROS]);
    for (const a of prisma.audits) {
      expect(a.metadata).toMatchObject({
        outcome: 'ai_malformed_output',
        error_reason: 'truncated-at-max-tokens',
        stop_reason: 'max_tokens',
        usage_basis: 'provider',
      });
      expect(a.prompt_token_estimate).toBe(20_000);
      expect(a.response_token_estimate).toBe(4_096);
      expect(a.error).toBe('ai_malformed_output');
    }
    expect(prisma.callLogs.map((c) => c.costCents)).toEqual([41, 41]); // ceil(40.48)
    expect(prisma.callLogs.map((c) => [c.tokensIn, c.tokensOut])).toEqual([
      [20_000, 4_096],
      [20_000, 4_096],
    ]);
  });

  it.each([
    [
      'provider refusal (stop_reason: refusal)',
      { stop_reason: 'refusal', content: [] },
      'ai_request_rejected',
      'provider-refusal',
    ],
    [
      'unexpected stop reason (end_turn, prose only)',
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'prose' }] },
      'ai_malformed_output',
      'unexpected-stop-reason',
    ],
    [
      'two tool calls (ambiguous)',
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', name: 'mapping_proposal', input: { families: [], confidence: 1 } },
          { type: 'tool_use', name: 'mapping_proposal', input: { families: [], confidence: 0 } },
        ],
      },
      'ai_malformed_output',
      'ambiguous-structured-output',
    ],
    [
      'zero tool calls',
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'x' }] },
      'ai_malformed_output',
      'no-structured-block',
    ],
    [
      'foreign tool name',
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'other_tool', input: { a: 1 } }],
      },
      'ai_malformed_output',
      'no-structured-block',
    ],
    [
      'non-text extra block',
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', name: 'mapping_proposal', input: { families: [], confidence: 1 } },
          { type: 'image', source: {} },
        ],
      },
      'ai_malformed_output',
      'ambiguous-structured-output',
    ],
    [
      'conforming tool call that fails the local validator',
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'mapping_proposal',
            input: { families: 'nope', confidence: 1 },
          },
        ],
      },
      'ai_malformed_output',
      'schema-validation-failed',
    ],
  ])(
    'a billed response rejected as %s settles the provider usage, not $0',
    async (_label, body, code, reason) => {
      const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
        model: 'model-primary-2026',
        usage: BILLED_USAGE,
        ...body,
      }));
      const { svc, prisma } = realAdapterSvc(create);
      const err = await expectCode(svc.invokeStructured(baseRequest()), code);
      expect(err.detail.reason).toBe(reason);
      expect(settledCharges(prisma)).toEqual([BILLED_MICROS]);
      expect(prisma.audits[0]).toMatchObject({
        model: 'model-primary-2026',
        prompt_token_estimate: 20_000,
        response_token_estimate: 4_096,
        error: code,
      });
      expect(prisma.audits[0].metadata).toMatchObject({
        outcome: code,
        usage_basis: 'provider',
        error_reason: reason,
        usd_estimate: 0.4048,
      });
      expect(prisma.callLogs[0]).toMatchObject({
        costCents: 41,
        tokensIn: 20_000,
        tokensOut: 4_096,
      });
    },
  );

  it('the adapter carries the provider usage on every rejection it raises (unit)', async () => {
    const adapter = new AnthropicStructuredProviderAdapter(
      asConfigService(() => 'k'),
      asAnthropicClient(
        jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
          model: 'm-used',
          stop_reason: 'max_tokens',
          usage: { input_tokens: 7, output_tokens: 9 },
          content: [],
        })),
      ),
    );
    const err = await expectCode(
      adapter.completeStructured({
        capability: IMPORTER_MAPPING_CAPABILITY,
        requestId: 'r',
        model: 'm',
        systemPrompt: 's',
        userContent: 'u',
        responseSchema: schema,
        schemaName: 'mapping_proposal',
        maxOutputTokens: 9,
        temperature: 0,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
      'ai_malformed_output',
    );
    expect(err.usage).toEqual({
      promptTokens: 7,
      responseTokens: 9,
      model: 'm-used',
      stopReason: 'max_tokens',
    });
  });

  it.each([
    [
      'transport error after send (socket reset)',
      () => Object.assign(new Error('socket hang up'), { name: 'APIConnectionError' }),
      'ai_provider_error',
    ],
    ['HTTP 500', () => Object.assign(new Error('boom'), { status: 500 }), 'ai_provider_error'],
    [
      'HTTP 529 overloaded',
      () => Object.assign(new Error('overloaded'), { status: 529 }),
      'ai_provider_error',
    ],
    [
      'SDK timeout',
      () => Object.assign(new Error('t/o'), { name: 'APIConnectionTimeoutError' }),
      'ai_timeout',
    ],
  ])(
    'a failure with UNKNOWN usage (%s) keeps the full reservation — never refunded to zero',
    async (_label, mkErr, code) => {
      const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => {
        throw mkErr();
      });
      const { svc, prisma } = realAdapterSvc(create);
      await expectCode(svc.invokeStructured(baseRequest()), code);
      const m = prisma.audits[0].metadata;
      expect(m.charge_micros).toBe(m.reserved_micros);
      expect(m.charge_micros).toBeGreaterThan(200_000); // ≥ 4096 × $50/MTok
      expect(m.usage_basis).toBe('unknown-kept-reservation');
      expect(m.outcome).toBe(code);
      expect(prisma.callLogs[0].costCents).toBe(Math.ceil(m.charge_micros / 10_000));
    },
  );

  it('a provider HTTP 4xx (request rejected before any generation, proven unbilled) settles to 0; a 429 does too', async () => {
    for (const status of [400, 401, 413, 429]) {
      const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => {
        throw Object.assign(new Error('rejected'), { status });
      });
      const { svc, prisma } = realAdapterSvc(create);
      await expectCode(
        svc.invokeStructured(baseRequest()),
        status === 429 ? 'ai_rate_limited' : 'ai_request_rejected',
      );
      expect(prisma.audits[0].metadata).toMatchObject({
        charge_micros: 0,
        usage_basis: 'provider-rejected-4xx',
        http_status: status,
      });
      expect(prisma.audits[0].metadata.reserved_micros).toBeGreaterThan(0);
    }
  });

  it('a kill-switch abort in flight keeps the reservation (usage unknown)', async () => {
    const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(
      (_p, options) =>
        new Promise((_, reject) =>
          (options.signal as AbortSignal).addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })),
          ),
        ),
    );
    const { svc, prisma } = realAdapterSvc(create);
    process.env.SCOUT_LEARN_CALL_TIMEOUT_MS = '5000';
    const p = expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    process.env.SCOUT_LEARN_AI_ENABLED = 'false';
    const err = await p;
    expect(err.detail.reason).toBe('kill-switch-off');
    const m = prisma.audits[0].metadata;
    expect(m.charge_micros).toBe(m.reserved_micros);
    expect(m.usage_basis).toBe('unknown-kept-reservation');
  });

  it('the truncation charge counts against a later admission: a paid max_tokens response followed by a call at a tight cap is refused', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.5';
    const create = jest.fn<ReturnType<CreateFn>, Parameters<CreateFn>>(async () => ({
      model: 'model-primary',
      stop_reason: 'max_tokens',
      usage: BILLED_USAGE,
      content: [],
    }));
    const { svc, prisma } = realAdapterSvc(create);
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(create).toHaveBeenCalledTimes(1);
    expect(settledCharges(prisma)).toEqual([BILLED_MICROS]);
  });
});

describe('r3 — settlement above the reservation is re-checked under the day lock (R592-c7A-03, R592-c7B-C03)', () => {
  it('the input estimate carries a fixed overhead allowance for the tool-use framing the provider bills', () => {
    expect(estimateInputTokens('')).toBe(INPUT_OVERHEAD_TOKENS);
    expect(estimateInputTokens('a'.repeat(1000))).toBe(500 + INPUT_OVERHEAD_TOKENS);
  });

  it('an overage that pushes the day over the cap is recorded (cap_exceeded) and closes the gate for the day', async () => {
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.6';
    const fake = new FakeStructuredProvider([
      // Reserved ≈ 1.1k in + 4096 out ≈ $0.216; actual 60k in × $10/MTok = $0.60 + out → over the cap.
      { kind: 'ok', output: { families: [], confidence: 1 }, tokensIn: 60_000, tokensOut: 100 },
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, prisma } = buildSvc(fake);
    const r = await svc.invokeStructured(baseRequest());
    expect(r.chargeMicros).toBe(600_000 + 5_000);
    expect(prisma.audits[0].metadata).toMatchObject({
      outcome: 'ok',
      charge_micros: 605_000,
      cap_exceeded: true,
    });
    expect(prisma.audits[0].metadata.overage_micros).toBe(
      605_000 - prisma.audits[0].metadata.reserved_micros,
    );
    // The overage settlement took the day lock and excluded its own row from the re-sum.
    expect(prisma.lockCalls.filter((q) => q.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(prisma.aiRequestAudit.findMany.mock.calls[1][0].where.id).toEqual({ not: 'audit-1' });
    // Next admission is refused: the recorded truth is above the cap.
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');
    expect(fake.calls).toHaveLength(1);
  });

  it('a settle failure on the overage path leaves the reservation charged (never below the maximum)', async () => {
    const prisma = buildPrisma();
    prisma.aiRequestAudit.update = jest.fn(async () => {
      throw new Error('settle failed');
    });
    const { svc } = buildSvc(
      new FakeStructuredProvider([
        { kind: 'ok', output: { families: [], confidence: 1 }, tokensIn: 100_000, tokensOut: 10 },
      ]),
      prisma,
    );
    const r = await svc.invokeStructured(baseRequest());
    // The result reports what the ledger actually holds: the reservation.
    expect(r.chargeMicros).toBe(prisma.audits[0].metadata.reserved_micros);
    expect(prisma.audits[0].metadata.outcome).toBe('reserved');
    expect(prisma.callLogs[0].costCents).toBe(Math.ceil(r.chargeMicros / 10_000));
  });
});

describe('r3 — UTC-midnight: one database clock read drives day key, lock, window and created_at (R592-c7A-04, R592-c7B-C01)', () => {
  it('a reservation whose transaction starts at 23:59:59.999Z is dated, locked and summed on THAT day; the next at 00:00:00.001Z on the next day, not counting the first', async () => {
    // Each call: reserve ≈ $0.216 (1.1k in + 4096 out), settled at ≈ $0.215
    // (1000 in + 4096 out) → one fits per day under a $0.40 cap, two do not.
    process.env.SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD = '0.4';
    const prisma = buildPrisma();
    const clocks = [new Date('2026-09-30T23:59:59.999Z'), new Date('2026-10-01T00:00:00.001Z')];
    prisma.clock = () => clocks.shift() ?? new Date('2026-10-01T00:00:00.002Z');
    const fake = new FakeStructuredProvider(
      Array.from({ length: 3 }, () => ({
        kind: 'ok' as const,
        output: { families: [], confidence: 1 },
        tokensOut: 4096,
      })),
    );
    const { svc } = buildSvc(fake, prisma);
    await svc.invokeStructured(baseRequest());
    await svc.invokeStructured(baseRequest());
    // Third call (still 2026-10-01) sees the second and is refused; the first
    // (2026-09-30) is outside its window.
    await expectCode(svc.invokeStructured(baseRequest()), 'ai_budget_exhausted');

    expect(prisma.audits[0].created_at).toEqual(new Date('2026-09-30T23:59:59.999Z'));
    expect(prisma.audits[0].metadata.accounting_day).toBe('2026-09-30');
    expect(prisma.audits[1].created_at).toEqual(new Date('2026-10-01T00:00:00.001Z'));
    expect(prisma.audits[1].metadata.accounting_day).toBe('2026-10-01');
    expect(prisma.lockKeys.slice(0, 3)).toEqual([
      advisoryLockKey(IMPORTER_MAPPING_CAPABILITY, '2026-09-30'),
      advisoryLockKey(IMPORTER_MAPPING_CAPABILITY, '2026-10-01'),
      advisoryLockKey(IMPORTER_MAPPING_CAPABILITY, '2026-10-01'),
    ]);
    expect(advisoryLockKey(IMPORTER_MAPPING_CAPABILITY, '2026-09-30')).not.toBe(
      advisoryLockKey(IMPORTER_MAPPING_CAPABILITY, '2026-10-01'),
    );
    // The window the ledger summed for the second call is the new day.
    const where = prisma.aiRequestAudit.findMany.mock.calls[1][0].where;
    expect(where.created_at).toEqual({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-02T00:00:00.000Z'),
    });
    // Gateway passes no day of its own: the ledger owns it.
    expect(prisma.audits[1].metadata.spent_before_micros).toBe(0);
  });

  it('the reserve transaction is pinned to READ COMMITTED with bounded maxWait/timeout (R592-c7B-02, C07)', async () => {
    const { svc, prisma } = buildSvc(
      new FakeStructuredProvider([{ kind: 'ok', output: { families: [], confidence: 1 } }]),
    );
    await svc.invokeStructured(baseRequest());
    expect(prisma.txOptions[0]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 15_000,
    });
    expect(RESERVE_TX_OPTIONS.isolationLevel).toBe('ReadCommitted');
  });

  it('an unreadable transaction clock refuses (ledger-unavailable) — the day is never taken from the app clock', async () => {
    const prisma = buildPrisma();
    prisma.$queryRaw = jest.fn(async () => [{ now: 'not a date' }]);
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('ledger-unavailable');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('r3 — production has no silent defaults for model or prices; boot fails closed (R592-c7A-05, R592-c7B-03)', () => {
  it('B-03: production refuses when either price is unset (price-unset:<NAME>) — before any call', async () => {
    productionEnv();
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, config } = buildSvc(fake);
    expect(config.resolve().ok).toBe(true);
    delete process.env.AI_PRICE_INPUT_USD_PER_MTOK;
    let err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('price-unset:AI_PRICE_INPUT_USD_PER_MTOK');
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '10';
    delete process.env.AI_PRICE_OUTPUT_USD_PER_MTOK;
    err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('price-unset:AI_PRICE_OUTPUT_USD_PER_MTOK');
    expect(fake.calls).toHaveLength(0);
    // Non-production keeps the conservative list-price default.
    process.env.NODE_ENV = 'test';
    expect(config.resolve()).toMatchObject({
      ok: true,
      outputPriceMicrosPerMTok: IMPORTER_MAPPING_DEFAULTS.outputPriceMicrosPerMTok,
    });
  });

  it('B-03: both prices and the primary model are registered prod / MUST_SET in prod-switches.yml', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const yaml = fs.readFileSync(path.resolve(__dirname, '../../prod-switches.yml'), 'utf8');
    const row = (name: string) =>
      yaml
        .slice(yaml.indexOf(`- name: ${name}\n`))
        .split('\n')
        .slice(0, 6)
        .join('\n');
    for (const key of [
      'AI_PRICE_INPUT_USD_PER_MTOK',
      'AI_PRICE_OUTPUT_USD_PER_MTOK',
      'AI_MODEL_IMPORTER_MAPPING',
      'SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD',
    ]) {
      expect(row(key)).toContain('tier: prod');
      expect(row(key)).toContain('prod_default: MUST_SET');
    }
    // The operator-keys artifact lists them (regenerated by scripts/gen-operator-keys.ts).
    const keys = fs.readFileSync(path.resolve(__dirname, '../../OPERATOR_KEYS_NEEDED.md'), 'utf8');
    for (const key of [
      'AI_PRICE_INPUT_USD_PER_MTOK',
      'AI_PRICE_OUTPUT_USD_PER_MTOK',
      'AI_MODEL_IMPORTER_MAPPING',
    ]) {
      expect(keys).toContain(`fly secrets set ${key}=<value>`);
    }
  });

  it('A-05: an unset primary with configured fallbacks refuses (model-unset) — a fallback is never promoted to primary', async () => {
    delete process.env.AI_MODEL_IMPORTER_MAPPING;
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc, config } = buildSvc(fake);
    expect(config.models()).toEqual({ ok: false, reason: 'model-unset' });
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('model-unset');
    expect(fake.calls).toHaveLength(0);
  });

  it('A-05: a malformed primary or a malformed / empty fallback entry refuses with the offending key (never silently dropped)', () => {
    const { config } = buildSvc(new FakeStructuredProvider([]));
    process.env.AI_MODEL_IMPORTER_MAPPING = 'model primary'; // space is not allowed
    expect(config.resolve()).toMatchObject({
      ok: false,
      refusalReason: 'config-invalid:AI_MODEL_IMPORTER_MAPPING',
    });
    process.env.AI_MODEL_IMPORTER_MAPPING = 'model-primary';
    for (const bad of ['model-fallback,', ',model-fallback', 'ok-model,bad model', 'a,,b']) {
      process.env.SCOUT_LEARN_MODEL_FALLBACKS = bad;
      expect(config.resolve()).toMatchObject({
        ok: false,
        refusalReason: 'config-invalid:SCOUT_LEARN_MODEL_FALLBACKS',
      });
    }
    // Valid list: ordered, primary first; a repeated id is collapsed (each model at most once).
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = ' model-b , model-c, model-primary ';
    expect(config.models()).toEqual({ ok: true, value: ['model-primary', 'model-b', 'model-c'] });
    expect(config.resolve()).toMatchObject({
      ok: true,
      models: ['model-primary', 'model-b', 'model-c'],
    });
  });

  it('boot: production with the kill switch ON and an unset price / cap / model THROWS (fails the boot); switch OFF logs and refuses per call', () => {
    productionEnv();
    process.env.AI_MODEL_IMPORTER_MAPPING = 'model-primary';
    const { config } = buildSvc(new FakeStructuredProvider([]));
    expect(() => config.assertBootPosture()).not.toThrow();
    for (const unset of [
      'AI_PRICE_INPUT_USD_PER_MTOK',
      'AI_PRICE_OUTPUT_USD_PER_MTOK',
      'SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD',
      'AI_MODEL_IMPORTER_MAPPING',
    ]) {
      const saved = process.env[unset];
      delete process.env[unset];
      expect(() => config.assertBootPosture()).toThrow(/SCOUT_LEARN_AI_ENABLED is on/);
      expect(() => config.onModuleInit()).toThrow();
      process.env.SCOUT_LEARN_AI_ENABLED = 'false';
      expect(() => config.assertBootPosture()).not.toThrow();
      process.env.SCOUT_LEARN_AI_ENABLED = 'true';
      process.env[unset] = saved;
    }
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = 'garbage';
    expect(() => config.assertBootPosture()).toThrow(/config-invalid:AI_PRICE_INPUT_USD_PER_MTOK/);
    // A missing provider key is an operations gap, not a defaults problem: logged, not fatal.
    process.env.AI_PRICE_INPUT_USD_PER_MTOK = '10';
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => config.assertBootPosture()).not.toThrow();
    // Outside production nothing throws.
    process.env.NODE_ENV = 'test';
    delete process.env.AI_MODEL_IMPORTER_MAPPING;
    expect(() => config.assertBootPosture()).not.toThrow();
  });

  it('boot: the Nest module init runs the boot posture check (onModuleInit) and throws in production with the switch on', async () => {
    productionEnv();
    delete process.env.AI_PRICE_OUTPUT_USD_PER_MTOK;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [AiGatewayConfig, ImporterMappingConfig],
    }).compile();
    await expect(moduleRef.init()).rejects.toThrow(/price-unset:AI_PRICE_OUTPUT_USD_PER_MTOK/);
  });
});

describe('r3 — class C closures (R592-c7B-C05, R592-c7B-C06, R592-c7A-07)', () => {
  it('C05: a kill-switch refusal on a fallback attempt writes its own audit row (attempt-scoped request_id, no unique collision)', async () => {
    process.env.SCOUT_LEARN_MODEL_FALLBACKS = 'model-fallback';
    const provider: AiStructuredProviderAdapter = {
      name: 'anthropic',
      completeStructured: async (req) => {
        process.env.SCOUT_LEARN_AI_ENABLED = 'false';
        throw toAiGatewayError(Object.assign(new Error('rate limit'), { status: 429 }), {
          provider: 'anthropic',
          model: req.model,
          attempt: 0,
        });
      },
    };
    const prisma = buildPrisma();
    // Enforce request_id uniqueness like the real column does.
    const seen = new Set<string>();
    const create = prisma.aiRequestAudit.create;
    prisma.aiRequestAudit.create = jest.fn(async (args: any) => {
      if (seen.has(args.data.request_id)) throw new Error('unique violation request_id');
      seen.add(args.data.request_id);
      return create(args);
    });
    const { svc } = buildSvc(provider, prisma);
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_unavailable');
    expect(err.detail.reason).toBe('kill-switch-off');
    expect(prisma.audits).toHaveLength(2);
    expect(prisma.audits[1].request_id).toBe(`${prisma.audits[0].request_id}:1`);
    expect(prisma.audits[1].metadata).toMatchObject({
      outcome: 'ai_unavailable',
      resolved_reason: 'kill-switch-off',
      attempt: 1,
      fallback_from: 'model-primary',
      charge_micros: 0,
    });
  });

  it('C06: AiGatewayError.validation (raw model output) is non-enumerable — a generic serializer never sees it', async () => {
    const { svc } = buildSvc(
      new FakeStructuredProvider([
        { kind: 'ok', output: { families: 'SECRET-MARKER', confidence: 1 } },
      ]),
    );
    const err = await expectCode(svc.invokeStructured(baseRequest()), 'ai_malformed_output');
    expect(err.validation?.rawOutput).toEqual({ families: 'SECRET-MARKER', confidence: 1 });
    expect(Object.keys(err)).not.toContain('validation');
    expect(JSON.stringify(err)).not.toContain('SECRET-MARKER');
    expect(JSON.stringify({ ...err })).not.toContain('SECRET-MARKER');
    expect(Object.entries(err).map(([k]) => k)).not.toContain('validation');
    // Usage, by contrast, is plain data and may be serialized.
    expect(
      Object.keys(
        new AiGatewayError('ai_timeout', {}, undefined, undefined, {
          promptTokens: 1,
          responseTokens: 2,
          model: 'm',
          stopReason: null,
        }),
      ),
    ).toContain('usage');
  });

  it('A-07: a request-supplied maxOutputTokens that is not a positive number is a caller bug and is refused, not silently raised to the cap', async () => {
    const fake = new FakeStructuredProvider([
      { kind: 'ok', output: { families: [], confidence: 1 } },
    ]);
    const { svc } = buildSvc(fake);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      await expect(svc.invokeStructured(baseRequest({ maxOutputTokens: bad }))).rejects.toThrow(
        /maxOutputTokens invalid/,
      );
    }
    expect(fake.calls).toHaveLength(0);
    await svc.invokeStructured(baseRequest({ maxOutputTokens: 100 }));
    expect(fake.calls[0].maxOutputTokens).toBe(100);
  });
});
