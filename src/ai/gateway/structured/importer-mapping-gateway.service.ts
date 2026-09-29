import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import { AiRedactionService, RedactionSummary } from '../ai-redaction.service';
import {
  IMPORTER_MAPPING_CAPABILITY,
  ImporterMappingConfig,
  ImporterMappingResolvedConfig,
} from './importer-mapping.config';
import { AiStructuredProviderRegistry } from './structured-provider.registry';
import {
  AiStructuredProviderAdapter,
  AiStructuredProviderResponse,
  JsonSchemaObject,
} from './structured-provider.types';
import { AiGatewayError, AiGatewayErrorCode, toAiGatewayError } from './structured-ai.errors';
import { estimateTokens } from './stub-structured-provider.adapter';

// L1-gw — fail-closed, observable gateway for capability `importer.mapping`.
//
// This is the ONLY path by which source structure reaches an external model
// (record D-L0-2/D-L0-7). It is deliberately separate from
// `AiGatewayService.invoke` so every other capability keeps its current
// behaviour (stub fallback, approval drafts, Coach-AI metering); nothing in
// that service changes.
//
// Guarantees (each has a test in test/ai/importer-mapping-gateway.spec.ts):
//   1. Fail closed. Kill switch off, capability not allowed, gateway off,
//      provider key missing, unwired provider, stub provider in production,
//      model or spend cap unset in production ⇒ `AiGatewayError('ai_unavailable')`.
//      The stub adapter runs only when NODE_ENV=test or AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER
//      is set outside production, and then returns `enabled:false, output:null`
//      — never something parseable as a proposal.
//   2. Provider errors are typed and never swallowed: timeout, 429, 5xx, other
//      4xx, malformed / truncated / non-conforming output all surface as
//      `AiGatewayError` with a closed `code`.
//   3. Ordered model list from config. The next model is tried ONLY on
//      retryable codes (ai_timeout / ai_rate_limited / ai_provider_error) and
//      only when a fallback is explicitly configured; each model at most once.
//   4. Hard per-request timeout (AbortSignal + race), max output tokens (config
//      cap; request may only lower it), temperature 0, and a global daily
//      spend cap with reservation of input + max_tokens before each call, plus
//      an in-process in-flight reservation so concurrent calls in one process
//      cannot jointly overshoot. Every attempt writes one AiRequestAudit row
//      (capability, provider, model, tokens, latency, outcome code, usd
//      estimate) and one AICallLog row; hashes only, never prompt or response
//      content.
//   5. Structured JSON output against the caller's JSON schema is mandatory:
//      the adapter sends the schema to the provider and the gateway validates
//      the returned object with the caller's `parse` before returning it.
//
// Coach-AI budget: `importer.mapping` is NOT charged to the coach's Coach-AI
// credits (`COACH_AI_METERED_CAPABILITIES` unchanged). It is bounded by the
// global daily cap here (owner D3 placeholder $20/day; measurement duty in
// the record).

export interface ImporterMappingRequest<T> {
  requester: { id: string; role: string };
  tenantCoachId?: string | null;
  // Trusted, already permission-scoped instructions. Not redacted (same
  // posture as the legacy gateway's systemPrompt).
  systemPrompt: string;
  // Untrusted structural digest. Redacted before it reaches an adapter.
  userContent: string;
  responseSchema: JsonSchemaObject;
  // [A-Za-z0-9_]{1,64}; used as the provider tool name.
  schemaName: string;
  // Local validator for the provider's object. Throw on mismatch. Typically
  // `(raw) => zodSchema.parse(raw)`.
  parse: (raw: unknown) => T;
  // May only LOWER the configured SCOUT_LEARN_MAX_OUTPUT_TOKENS.
  maxOutputTokens?: number;
  // Content-free scalars for the audit row (promptTemplateVersion,
  // contractHash, round, ...). Strings are capped at 200 chars.
  auditMetadata?: Record<string, string | number | boolean | null>;
  // Opaque id linking the row to the caller's unit of work (e.g. a run id).
  contextId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ImporterMappingResult<T> {
  requestId: string;
  // Audit id of the successful (or stub) attempt; '' if the audit write failed.
  auditId: string;
  provider: string;
  model: string;
  // False only on the permitted stub path; then `output` is null.
  enabled: boolean;
  output: T | null;
  promptTokens: number;
  responseTokens: number;
  latencyMs: number;
  usdEstimate: number;
  // 1-based number of provider attempts made (1 = primary succeeded).
  attempts: number;
  fallbackUsed: boolean;
  redactionsApplied: RedactionSummary;
}

type AttemptOutcome = 'ok' | 'stub' | AiGatewayErrorCode;

interface AuditArgs {
  requestId: string;
  req: ImporterMappingRequest<unknown>;
  cfg: ImporterMappingResolvedConfig | null;
  provider: string;
  model: string | null;
  enabled: boolean;
  outcome: AttemptOutcome;
  attempt: number;
  promptTokens: number | null;
  responseTokens: number | null;
  latencyMs: number;
  usdEstimate: number;
  promptHash: string | null;
  responseHash: string | null;
  redactions: RedactionSummary | null;
  extra?: Record<string, unknown>;
}

const SCHEMA_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

@Injectable()
export class ImporterMappingGatewayService {
  private readonly logger = new Logger(ImporterMappingGatewayService.name);
  // In-flight USD reservations for this process (see guarantee 4).
  private inflightUsd = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ImporterMappingConfig,
    private readonly redaction: AiRedactionService,
    private readonly providers: AiStructuredProviderRegistry,
  ) {}

  async invokeStructured<T>(req: ImporterMappingRequest<T>): Promise<ImporterMappingResult<T>> {
    if (!req.requester || !req.requester.id) {
      throw new Error('ImporterMappingGatewayService.invokeStructured called without requester');
    }
    if (!req.responseSchema || req.responseSchema.type !== 'object') {
      throw new AiGatewayError('ai_malformed_output', { reason: 'response-schema-required' });
    }
    if (!SCHEMA_NAME_RE.test(req.schemaName ?? '')) {
      throw new AiGatewayError('ai_malformed_output', { reason: 'schema-name-invalid' });
    }
    if (typeof req.parse !== 'function') {
      throw new AiGatewayError('ai_malformed_output', { reason: 'parse-required' });
    }

    const requestId = randomUUID();
    const cfg = this.config.resolve();

    // ── 1. Fail closed on configuration ─────────────────────────────────────
    if (!cfg.ok) {
      const err = new AiGatewayError('ai_unavailable', {
        provider: cfg.provider,
        model: cfg.models[0] ?? null,
        reason: cfg.refusalReason ?? 'refused',
      });
      await this.writeAudit({
        requestId,
        req,
        cfg,
        provider: cfg.provider,
        model: cfg.models[0] ?? null,
        enabled: false,
        outcome: err.code,
        attempt: 0,
        promptTokens: null,
        responseTokens: null,
        latencyMs: 0,
        usdEstimate: 0,
        promptHash: null,
        responseHash: null,
        redactions: null,
        extra: { resolved_reason: cfg.refusalReason },
      });
      throw err;
    }

    // ── 2. Redact untrusted input before any adapter sees it ────────────────
    const redacted = this.redaction.redact(req.userContent ?? '');
    const promptHash = sha256(req.systemPrompt + '\n' + redacted.text);
    const schemaHash = sha256(stableStringify(req.responseSchema));
    const inputTokenEstimate = estimateTokens(req.systemPrompt) + estimateTokens(redacted.text);
    const maxOutputTokens = clampMaxOutput(cfg.maxOutputTokens, req.maxOutputTokens);

    // ── 3. Permitted stub (test / explicit dev flag only; never production) ─
    if (cfg.stubPermitted) {
      const stub = this.providers.resolveStub();
      const resp = await stub.completeStructured({
        capability: IMPORTER_MAPPING_CAPABILITY,
        requestId,
        model: 'disabled',
        systemPrompt: req.systemPrompt,
        userContent: redacted.text,
        responseSchema: req.responseSchema,
        schemaName: req.schemaName,
        maxOutputTokens,
        temperature: cfg.temperature,
        signal: new AbortController().signal,
        timeoutMs: cfg.callTimeoutMs,
      });
      const auditId = await this.writeAudit({
        requestId,
        req,
        cfg,
        provider: resp.provider,
        model: resp.model,
        enabled: false,
        outcome: 'stub',
        attempt: 0,
        promptTokens: resp.promptTokens,
        responseTokens: resp.responseTokens,
        latencyMs: resp.latencyMs,
        usdEstimate: 0,
        promptHash,
        responseHash: null,
        redactions: redacted.summary,
        extra: { schema_hash: schemaHash, resolved_reason: 'stub-permitted' },
      });
      return {
        requestId,
        auditId,
        provider: resp.provider,
        model: resp.model,
        enabled: false,
        output: null,
        promptTokens: resp.promptTokens,
        responseTokens: resp.responseTokens,
        latencyMs: resp.latencyMs,
        usdEstimate: 0,
        attempts: 0,
        fallbackUsed: false,
        redactionsApplied: redacted.summary,
      };
    }

    // ── 4. Real provider, ordered models, fallback only on retryable codes ──
    let adapter: AiStructuredProviderAdapter;
    try {
      adapter = this.providers.resolveRealOrThrow(cfg.provider);
    } catch (e) {
      const err = AiGatewayError.is(e)
        ? e
        : toAiGatewayError(e, { provider: cfg.provider, model: null, attempt: 0 });
      await this.writeAudit({
        requestId,
        req,
        cfg,
        provider: cfg.provider,
        model: cfg.models[0] ?? null,
        enabled: false,
        outcome: err.code,
        attempt: 0,
        promptTokens: null,
        responseTokens: null,
        latencyMs: 0,
        usdEstimate: 0,
        promptHash,
        responseHash: null,
        redactions: redacted.summary,
        extra: { resolved_reason: err.detail.reason ?? null },
      });
      throw err;
    }

    const cap = cfg.dailySpendCapUsd as number; // non-null when cfg.ok && !stub
    let lastError: AiGatewayError | null = null;

    for (let attempt = 0; attempt < cfg.models.length; attempt++) {
      const model = cfg.models[attempt];
      const fallbackFrom = attempt > 0 ? cfg.models[attempt - 1] : null;
      const reserveUsd = this.estimateUsd(cfg, inputTokenEstimate, maxOutputTokens);

      // 4a. Spend cap with reservation (input estimate + max_tokens), including
      //     this process's in-flight reservations.
      const spentToday = await this.spentTodayUsd();
      if (spentToday + this.inflightUsd + reserveUsd > cap) {
        const err = new AiGatewayError('ai_budget_exhausted', {
          provider: adapter.name,
          model,
          attempt,
          reason: 'daily-spend-cap',
        });
        await this.writeAudit({
          requestId,
          req,
          cfg,
          provider: adapter.name,
          model,
          enabled: false,
          outcome: err.code,
          attempt,
          promptTokens: null,
          responseTokens: null,
          latencyMs: 0,
          usdEstimate: 0,
          promptHash,
          responseHash: null,
          redactions: redacted.summary,
          extra: {
            schema_hash: schemaHash,
            spend_cap_usd: cap,
            spent_today_usd: round6(spentToday),
            inflight_usd: round6(this.inflightUsd),
            reserve_usd: round6(reserveUsd),
            fallback_from: fallbackFrom,
          },
        });
        this.logger.warn(
          `[importer.mapping] daily spend cap reached: spent=${round6(spentToday)} inflight=${round6(this.inflightUsd)} reserve=${round6(reserveUsd)} cap=${cap}`,
        );
        throw err;
      }

      // 4b. Hard timeout: AbortSignal to the adapter AND a race so a hung
      //     adapter cannot hold the caller past the deadline.
      this.inflightUsd += reserveUsd;
      const controller = new AbortController();
      const startedAt = Date.now();
      let timer: NodeJS.Timeout | null = null;
      let timedOut = false;
      let resp: AiStructuredProviderResponse | null = null;
      let failure: AiGatewayError | null = null;
      try {
        const timeoutP = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(
              new AiGatewayError('ai_timeout', {
                provider: adapter.name,
                model,
                attempt,
                reason: 'request-timeout',
              }),
            );
          }, cfg.callTimeoutMs);
        });
        resp = await Promise.race([
          adapter.completeStructured({
            capability: IMPORTER_MAPPING_CAPABILITY,
            requestId,
            model,
            systemPrompt: req.systemPrompt,
            userContent: redacted.text,
            responseSchema: req.responseSchema,
            schemaName: req.schemaName,
            maxOutputTokens,
            temperature: cfg.temperature,
            signal: controller.signal,
            timeoutMs: cfg.callTimeoutMs,
          }),
          timeoutP,
        ]);
      } catch (e) {
        failure = AiGatewayError.is(e)
          ? e
          : toAiGatewayError(e, { provider: adapter.name, model, attempt, timedOut });
        if (timedOut && failure.code !== 'ai_timeout') {
          failure = new AiGatewayError('ai_timeout', {
            provider: adapter.name,
            model,
            attempt,
            reason: 'request-timeout',
          });
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.inflightUsd = Math.max(0, this.inflightUsd - reserveUsd);
      }
      const latencyMs = Date.now() - startedAt;

      // 4c. Validate a returned object against the caller's schema parser.
      let parsed: T | null = null;
      if (!failure && resp) {
        if (!resp.enabled) {
          failure = new AiGatewayError('ai_unavailable', {
            provider: resp.provider,
            model: resp.model,
            attempt,
            reason: 'adapter-reported-disabled',
          });
        } else if (resp.stopReason === 'max_tokens') {
          failure = new AiGatewayError('ai_malformed_output', {
            provider: resp.provider,
            model: resp.model,
            attempt,
            reason: 'truncated-at-max-tokens',
          });
        } else if (resp.output == null || typeof resp.output !== 'object') {
          failure = new AiGatewayError('ai_malformed_output', {
            provider: resp.provider,
            model: resp.model,
            attempt,
            reason: 'output-not-object',
          });
        } else {
          try {
            parsed = req.parse(resp.output);
          } catch {
            failure = new AiGatewayError('ai_malformed_output', {
              provider: resp.provider,
              model: resp.model,
              attempt,
              reason: 'schema-validation-failed',
            });
          }
        }
      }

      // 4d. Audit this attempt (one row per attempt, always).
      const promptTokens =
        resp?.promptTokens ?? (failure?.code === 'ai_timeout' ? inputTokenEstimate : 0);
      const responseTokens =
        resp?.responseTokens ?? (failure?.code === 'ai_timeout' ? maxOutputTokens : 0);
      const usdEstimate = this.estimateUsd(cfg, promptTokens, responseTokens);
      const modelUsed = resp?.model ?? model;
      const auditId = await this.writeAudit({
        requestId,
        req,
        cfg,
        provider: adapter.name,
        model: modelUsed,
        enabled: !failure,
        outcome: failure ? failure.code : 'ok',
        attempt,
        promptTokens,
        responseTokens,
        latencyMs,
        usdEstimate,
        promptHash,
        responseHash: resp && !failure ? sha256(stableStringify(resp.output)) : null,
        redactions: redacted.summary,
        extra: {
          schema_hash: schemaHash,
          model_requested: model,
          fallback_from: fallbackFrom,
          http_status: failure?.detail.httpStatus ?? null,
          error_reason: failure?.detail.reason ?? null,
          stop_reason: resp?.stopReason ?? null,
          spend_cap_usd: cap,
          spent_today_usd: round6(spentToday),
          max_output_tokens: maxOutputTokens,
          timeout_ms: cfg.callTimeoutMs,
        },
      });

      if (!failure && resp) {
        return {
          requestId,
          auditId,
          provider: resp.provider,
          model: modelUsed,
          enabled: true,
          output: parsed as T,
          promptTokens,
          responseTokens,
          latencyMs,
          usdEstimate,
          attempts: attempt + 1,
          fallbackUsed: attempt > 0,
          redactionsApplied: redacted.summary,
        };
      }

      lastError = failure;
      const hasNext = attempt < cfg.models.length - 1;
      if (failure && failure.retryable && hasNext) {
        this.logger.warn(
          `[importer.mapping] ${failure.code} on model=${model}; trying configured fallback model=${cfg.models[attempt + 1]}`,
        );
        continue;
      }
      throw failure;
    }

    // Unreachable in practice (loop either returns or throws); keep typed.
    throw lastError ?? new AiGatewayError('ai_unavailable', { reason: 'no-model-attempted' });
  }

  // Sum of `metadata.usd_estimate` over today's (UTC) importer.mapping audit
  // rows. Counting from AiRequestAudit means the cap survives restarts
  // (record D-L0-7.3). Failure to read is treated as "cap reached" — the
  // spend gate must never open because the ledger was unreadable.
  async spentTodayUsd(now: Date = new Date()): Promise<number> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    try {
      const rows = await this.prisma.aiRequestAudit.findMany({
        where: { capability: IMPORTER_MAPPING_CAPABILITY, created_at: { gte: dayStart } },
        select: { metadata: true },
      });
      let total = 0;
      for (const r of rows) {
        const m = r.metadata as { usd_estimate?: unknown } | null;
        const v = m && typeof m === 'object' ? m.usd_estimate : null;
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) total += v;
      }
      return total;
    } catch (err) {
      this.logger.error(
        `[importer.mapping] spend ledger unreadable; treating cap as reached: ${(err as Error).message}`,
      );
      return Number.POSITIVE_INFINITY;
    }
  }

  estimateUsd(
    cfg: ImporterMappingResolvedConfig,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const usd =
      (Math.max(0, inputTokens) / 1_000_000) * cfg.inputUsdPerMTok +
      (Math.max(0, outputTokens) / 1_000_000) * cfg.outputUsdPerMTok;
    return round6(usd);
  }

  // One AiRequestAudit row + one AICallLog row per attempt. Hashes only.
  // Best-effort like the legacy gateway: a ledger write failure is logged,
  // never turned into a different outcome for the caller.
  private async writeAudit(a: AuditArgs): Promise<string> {
    const metadata: Record<string, unknown> = {
      outcome: a.outcome,
      attempt: a.attempt,
      latency_ms: a.latencyMs,
      usd_estimate: a.usdEstimate,
      context_id: a.req.contextId ?? null,
      models_configured: a.cfg?.models.length ?? 0,
      ...sanitizeScalars(a.req.auditMetadata),
      ...(a.extra ?? {}),
    };
    let auditId = '';
    try {
      const row = await this.prisma.aiRequestAudit.create({
        data: {
          request_id: a.attempt > 0 ? `${a.requestId}:${a.attempt}` : a.requestId,
          capability: IMPORTER_MAPPING_CAPABILITY,
          requester_id: a.req.requester.id,
          requester_role: a.req.requester.role,
          subject_user_id: null,
          tenant_coach_id: a.req.tenantCoachId ?? null,
          provider: a.provider,
          model: a.model,
          enabled: a.enabled,
          context_source_count: 0,
          context_source_refs: Prisma.JsonNull,
          redactions_applied: a.redactions ? toJsonValue(a.redactions) : Prisma.JsonNull,
          prompt_token_estimate: a.promptTokens,
          response_token_estimate: a.responseTokens,
          prompt_hash: a.promptHash,
          response_hash: a.responseHash,
          approval_status: 'not_required',
          approval_draft_id: null,
          // Closed outcome code only — never a raw provider message.
          error: a.outcome === 'ok' || a.outcome === 'stub' ? null : a.outcome,
          ip: a.req.ip ?? null,
          user_agent: a.req.userAgent ?? null,
          metadata: toJsonValue(metadata),
        },
      });
      auditId = row.id;
    } catch (err) {
      this.logger.error(
        `[importer.mapping] AiRequestAudit write failed: ${(err as Error).message}`,
      );
    }
    try {
      const role = a.req.requester.role;
      const coachId =
        a.req.tenantCoachId ?? (role === 'coach' || role === 'owner' ? a.req.requester.id : null);
      await this.prisma.aICallLog.create({
        data: {
          model: a.model ?? 'unset',
          tokensIn: a.promptTokens ?? 0,
          tokensOut: a.responseTokens ?? 0,
          costCents: Math.ceil(a.usdEstimate * 100),
          latencyMs: a.latencyMs,
          success: a.outcome === 'ok',
          errorMessage: a.outcome === 'ok' ? null : a.outcome,
          coachId,
          clientId: null,
          capability: IMPORTER_MAPPING_CAPABILITY,
        },
      });
    } catch (err) {
      this.logger.warn(`[importer.mapping] AICallLog write failed: ${(err as Error).message}`);
    }
    return auditId;
  }
}

function clampMaxOutput(configured: number, requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return configured;
  return Math.min(configured, Math.floor(requested));
}

function sanitizeScalars(
  m: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!m) return out;
  for (const [k, v] of Object.entries(m)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

// Structural → Prisma JSON input without a type assertion: a JSON round-trip
// also guarantees the row holds only plain JSON (no class instances, no
// undefined holes).
function toJsonValue(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v));
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
