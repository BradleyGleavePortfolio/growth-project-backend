import { Inject, Injectable, Logger } from '@nestjs/common';
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
  StructuredValidation,
  isObjectSchema,
} from './structured-provider.types';
import {
  AiGatewayError,
  AiGatewayErrorCode,
  AiProviderUsage,
  toAiGatewayError,
} from './structured-ai.errors';
import {
  SPEND_LEDGER,
  SpendLedger,
  SpendReservation,
  errorClass,
  zeroChargeFields,
} from './spend-ledger';
import { addMicros, microsToCentsCeil, microsToUsd, tokenCostMicros } from './money';

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
//      model or spend cap unset in production, unparseable limits or prices,
//      spend ledger unreachable ⇒ `AiGatewayError('ai_unavailable')`. The stub
//      adapter runs only when NODE_ENV=test or AI_GATEWAY_DEV_ALLOW_OFFLINE_PROVIDER
//      is set outside production, and then returns `enabled:false, output:null`.
//   2. Provider errors are typed and never swallowed: timeout, 429, 5xx, other
//      4xx, malformed / truncated / ambiguous / non-conforming output all
//      surface as `AiGatewayError` with a closed `code`.
//   3. Ordered model list from config. The next model is tried ONLY on
//      retryable codes (ai_timeout / ai_rate_limited / ai_provider_error) and
//      only when a fallback is explicitly configured; each model at most once.
//      The kill switch is re-read before EVERY attempt, polled while a call is
//      in flight (aborting it), and checked again before output is accepted.
//   4. Hard per-request timeout (AbortSignal + race), max input tokens
//      (conservative estimate; over-limit requests are refused before any
//      spend), max output tokens (config cap; request may only lower it),
//      temperature 0, and a global daily spend cap enforced by
//      RESERVE-BEFORE-CALL in PostgreSQL through the `SpendLedger` port (see
//      spend-ledger.ts): the reservation row IS the AiRequestAudit row for the
//      attempt, charged at the conservative maximum until settled. Money is
//      integer micro-USD (money.ts). Settlement (r3, R592-c7A-02/03,
//      R592-c7B-01): whenever the provider RETURNED a response — accepted,
//      truncated, refused, wrong tool-call count, malformed — the ACTUAL
//      usage is charged; a provider HTTP 4xx (request rejected before any
//      generation, proven unbilled) settles to 0; every other failure after
//      the request was sent (timeout, abort, transport error, 5xx) keeps the
//      full reservation because usage is unknown. A settlement above the
//      reservation is re-checked under the day lock and recorded.
//      Reservation failure ⇒ no call. Hashes only, never prompt or response
//      content; caller metadata is allow-listed and nested so it can never
//      overwrite a charge field.
//   5. Structured JSON output against the caller's JSON schema is mandatory:
//      the adapter demands exactly one tool call matching the schema and the
//      gateway runs the caller's `validate`; a failure returns the
//      content-free validator errors plus the raw object on the error
//      (`AiGatewayError.validation`) so the caller can make its one repair
//      call. Nothing from `validation` is logged or persisted here.
//
// Requester: must be a real `User` (the coach or owner acting). There is no
// system requester path — `AiRequestAudit.requester_id` is a foreign key, and a
// reservation insert that fails on it refuses the call.
//
// Coach-AI budget: `importer.mapping` is NOT charged to the coach's Coach-AI
// credits (`COACH_AI_METERED_CAPABILITIES` unchanged). It is bounded by the
// global daily cap here (owner D3 placeholder $20/day; measurement duty in
// the record). Interim posture: this ledger is authoritative until the
// durable `ScoutLearnSpendLedger` (record D-L0-7.3, slice L2b) replaces it by
// binding a different `SPEND_LEDGER` provider.

export interface ImporterMappingRequest<T> {
  // A real User (coach / owner). Role must be one of the allowed roles.
  requester: { id: string; role: string };
  tenantCoachId?: string | null;
  // Trusted, already permission-scoped instructions. Not redacted (same
  // posture as the legacy gateway's systemPrompt).
  systemPrompt: string;
  // Untrusted structural digest. Redacted before it reaches an adapter.
  userContent: string;
  // Readonly, caller-typed; must have `type: 'object'` at runtime.
  responseSchema: JsonSchemaObject;
  // [A-Za-z0-9_]{1,64}; used as the provider tool name.
  schemaName: string;
  // Local validator for the provider's object. Returns ok/errors; never throws.
  validate: (raw: unknown) => StructuredValidation<T>;
  // May only LOWER the configured SCOUT_LEARN_MAX_OUTPUT_TOKENS.
  maxOutputTokens?: number;
  // Allow-listed, content-free audit keys (see AUDIT_METADATA_ALLOW_LIST).
  // Stored nested under `metadata.caller`; any other key rejects the request.
  auditMetadata?: ImporterMappingAuditMetadata;
  // Opaque id linking the row to the caller's unit of work (e.g. a run id).
  contextId?: string | null;
}

export interface ImporterMappingAuditMetadata {
  promptTemplateVersion?: string;
  contractHash?: string;
  schemaVersion?: string;
  round?: number;
  callKind?: 'decode' | 'repair' | 'explore';
}

export const AUDIT_METADATA_ALLOW_LIST: ReadonlyArray<keyof ImporterMappingAuditMetadata> = [
  'promptTemplateVersion',
  'contractHash',
  'schemaVersion',
  'round',
  'callKind',
];

export const REQUESTER_ROLES: ReadonlySet<string> = new Set(['coach', 'owner', 'sub_coach']);

export interface ImporterMappingResult<T> {
  requestId: string;
  // Audit id of the successful attempt's row ('' on the stub path when the
  // audit write failed — the stub path spends nothing).
  auditId: string;
  provider: string;
  model: string;
  // False only on the permitted stub path; then `output` is null.
  enabled: boolean;
  output: T | null;
  promptTokens: number;
  responseTokens: number;
  latencyMs: number;
  // Charge recorded in the ledger for the successful attempt: integer µUSD
  // (authoritative) and its USD rendering (display).
  chargeMicros: number;
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
  outcome: AttemptOutcome;
  promptTokens: number | null;
  responseTokens: number | null;
  latencyMs: number;
  promptHash: string | null;
  redactions: RedactionSummary | null;
  extra?: Record<string, unknown>;
}

const SCHEMA_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HASH_RE = /^[A-Fa-f0-9]{8,128}$/;
// Conservative tokenizer bound for JSON-dense text: ~2.5 chars/token, then a
// safety factor, plus a fixed allowance for what the provider adds to the
// billed input that is not in our bytes (tool-use system prompt and message
// framing; a few hundred tokens — R592-c7B-C03). Actual usage is reconciled
// at settle time and an overage is re-checked under the day lock.
const CHARS_PER_TOKEN = 2.5;
const INPUT_SAFETY_FACTOR = 1.25;
export const INPUT_OVERHEAD_TOKENS = 1_024;
// Kill-switch poll while a provider call is in flight.
const KILL_SWITCH_POLL_MS = 500;

@Injectable()
export class ImporterMappingGatewayService {
  private readonly logger = new Logger(ImporterMappingGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ImporterMappingConfig,
    private readonly redaction: AiRedactionService,
    private readonly providers: AiStructuredProviderRegistry,
    @Inject(SPEND_LEDGER) private readonly ledger: SpendLedger,
  ) {}

  async invokeStructured<T>(req: ImporterMappingRequest<T>): Promise<ImporterMappingResult<T>> {
    // Programming errors in the caller (not provider outcomes) throw plain Errors.
    if (!req.requester || !ID_RE.test(req.requester.id ?? '')) {
      throw new Error(
        'ImporterMappingGatewayService.invokeStructured: requester.id must be a real User id',
      );
    }
    if (!REQUESTER_ROLES.has(req.requester.role)) {
      throw new Error('ImporterMappingGatewayService.invokeStructured: requester.role not allowed');
    }
    if (req.tenantCoachId != null && !ID_RE.test(req.tenantCoachId)) {
      throw new Error('ImporterMappingGatewayService.invokeStructured: tenantCoachId invalid');
    }
    if (req.contextId != null && !ID_RE.test(req.contextId)) {
      throw new Error('ImporterMappingGatewayService.invokeStructured: contextId invalid');
    }
    const callerMeta = sanitizeAuditMetadata(req.auditMetadata);
    if (!isObjectSchema(req.responseSchema)) {
      throw new AiGatewayError('ai_malformed_output', { reason: 'response-schema-required' });
    }
    if (!SCHEMA_NAME_RE.test(req.schemaName ?? '')) {
      throw new AiGatewayError('ai_malformed_output', { reason: 'schema-name-invalid' });
    }
    if (typeof req.validate !== 'function') {
      throw new AiGatewayError('ai_malformed_output', { reason: 'validate-required' });
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
      await this.writeRefusalAudit({
        requestId,
        req,
        cfg,
        provider: cfg.provider,
        model: cfg.models[0] ?? null,
        outcome: err.code,
        promptTokens: null,
        responseTokens: null,
        latencyMs: 0,
        promptHash: null,
        redactions: null,
        extra: { resolved_reason: cfg.refusalReason, caller: callerMeta },
      });
      throw err;
    }

    // ── 2. Redact untrusted input before any adapter sees it ────────────────
    const redacted = this.redaction.redact(req.userContent ?? '');
    const promptHash = sha256(req.systemPrompt + '\n' + redacted.text);
    const schemaJson = stableStringify(req.responseSchema);
    const schemaHash = sha256(schemaJson);
    // Conservative input estimate over EVERYTHING sent: system prompt, digest
    // and the schema (it is part of the request as the tool definition).
    const inputTokenEstimate = estimateInputTokens(req.systemPrompt, redacted.text, schemaJson);
    const maxOutputTokens = clampMaxOutput(cfg.maxOutputTokens, req.maxOutputTokens);
    const baseExtra = {
      schema_hash: schemaHash,
      caller: callerMeta,
      input_token_estimate: inputTokenEstimate,
      max_input_tokens: cfg.maxInputTokens,
      max_output_tokens: maxOutputTokens,
      timeout_ms: cfg.callTimeoutMs,
    };

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
      const auditId = await this.writeRefusalAudit({
        requestId,
        req,
        cfg,
        provider: resp.provider,
        model: resp.model,
        outcome: 'stub',
        promptTokens: resp.promptTokens,
        responseTokens: resp.responseTokens,
        latencyMs: resp.latencyMs,
        promptHash,
        redactions: redacted.summary,
        extra: { ...baseExtra, resolved_reason: 'stub-permitted' },
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
        chargeMicros: 0,
        usdEstimate: 0,
        attempts: 0,
        fallbackUsed: false,
        redactionsApplied: redacted.summary,
      };
    }

    // ── 4. Pre-flight refusals that spend nothing ───────────────────────────
    let adapter: AiStructuredProviderAdapter;
    try {
      adapter = this.providers.resolveRealOrThrow(cfg.provider);
    } catch (e) {
      const err = AiGatewayError.is(e)
        ? e
        : toAiGatewayError(e, { provider: cfg.provider, model: null, attempt: 0 });
      await this.writeRefusalAudit({
        requestId,
        req,
        cfg,
        provider: cfg.provider,
        model: cfg.models[0] ?? null,
        outcome: err.code,
        promptTokens: null,
        responseTokens: null,
        latencyMs: 0,
        promptHash,
        redactions: redacted.summary,
        extra: { ...baseExtra, resolved_reason: err.detail.reason ?? null },
      });
      throw err;
    }
    if (inputTokenEstimate > cfg.maxInputTokens) {
      const err = new AiGatewayError('ai_request_rejected', {
        provider: adapter.name,
        model: cfg.models[0] ?? null,
        reason: 'input-too-large',
      });
      await this.writeRefusalAudit({
        requestId,
        req,
        cfg,
        provider: adapter.name,
        model: cfg.models[0] ?? null,
        outcome: err.code,
        promptTokens: inputTokenEstimate,
        responseTokens: null,
        latencyMs: 0,
        promptHash,
        redactions: redacted.summary,
        extra: { ...baseExtra, resolved_reason: 'input-too-large' },
      });
      throw err;
    }

    const capMicros = cfg.dailySpendCapMicros as number; // non-null when cfg.ok && !stub
    let lastError: AiGatewayError | null = null;

    // ── 5. Real provider, ordered models, fallback only on retryable codes ──
    for (let attempt = 0; attempt < cfg.models.length; attempt++) {
      const model = cfg.models[attempt];
      const fallbackFrom = attempt > 0 ? cfg.models[attempt - 1] : null;

      // 5a. Kill switch re-read before EVERY attempt, including fallbacks.
      if (!this.config.killSwitchOn()) {
        const err = new AiGatewayError('ai_unavailable', {
          provider: adapter.name,
          model,
          attempt,
          reason: 'kill-switch-off',
        });
        await this.writeRefusalAudit({
          // Attempt-scoped id (R592-c7B-C05): attempt 0's reservation row
          // already holds `requestId` (request_id is unique).
          requestId: attempt > 0 ? `${requestId}:${attempt}` : requestId,
          req,
          cfg,
          provider: adapter.name,
          model,
          outcome: err.code,
          promptTokens: null,
          responseTokens: null,
          latencyMs: 0,
          promptHash,
          redactions: redacted.summary,
          extra: {
            ...baseExtra,
            resolved_reason: 'kill-switch-off',
            attempt,
            fallback_from: fallbackFrom,
          },
        });
        throw err;
      }

      // 5b. Reserve the conservative maximum in the ledger BEFORE the call.
      //     The ledger derives the accounting day from the database clock
      //     inside its transaction (R592-c7A-04).
      const reserveMicros = this.estimateMicros(cfg, inputTokenEstimate, maxOutputTokens);
      let reservation: SpendReservation;
      try {
        reservation = await this.ledger.reserve({
          capability: IMPORTER_MAPPING_CAPABILITY,
          capMicros,
          maxMicros: reserveMicros,
          audit: {
            requestId: attempt > 0 ? `${requestId}:${attempt}` : requestId,
            requesterId: req.requester.id,
            requesterRole: req.requester.role,
            tenantCoachId: req.tenantCoachId ?? null,
            provider: adapter.name,
            model,
            promptHash,
            redactions: toJsonValue(redacted.summary),
            metadata: {
              ...baseExtra,
              attempt,
              context_id: req.contextId ?? null,
              model_requested: model,
              fallback_from: fallbackFrom,
              models_configured: cfg.models.length,
            },
          },
        });
      } catch (e) {
        const err = AiGatewayError.is(e)
          ? e
          : new AiGatewayError('ai_unavailable', {
              provider: adapter.name,
              model,
              attempt,
              reason: 'ledger-unavailable',
            });
        this.logger.warn(
          `[importer.mapping] refused before call: code=${err.code} reason=${err.detail.reason ?? 'n/a'} reserve_micros=${reserveMicros} cap_micros=${capMicros}`,
        );
        throw err;
      }

      // 5c. The call: hard timeout (AbortSignal + race) and a live kill-switch
      //     poll that aborts an in-flight request.
      const controller = new AbortController();
      const startedAt = Date.now();
      let timer: NodeJS.Timeout | null = null;
      let poll: NodeJS.Timeout | null = null;
      let timedOut = false;
      let killed = false;
      let resp: AiStructuredProviderResponse | null = null;
      let failure: AiGatewayError | null = null;
      try {
        const guardP = new Promise<never>((_, reject) => {
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
          poll = setInterval(() => {
            if (!this.config.killSwitchOn()) {
              killed = true;
              controller.abort();
              reject(
                new AiGatewayError('ai_unavailable', {
                  provider: adapter.name,
                  model,
                  attempt,
                  reason: 'kill-switch-off',
                }),
              );
            }
          }, KILL_SWITCH_POLL_MS);
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
          guardP,
        ]);
      } catch (e) {
        failure = AiGatewayError.is(e)
          ? e
          : toAiGatewayError(e, { provider: adapter.name, model, attempt, timedOut });
        if (killed) {
          failure = new AiGatewayError('ai_unavailable', {
            provider: adapter.name,
            model,
            attempt,
            reason: 'kill-switch-off',
          });
        } else if (timedOut && failure.code !== 'ai_timeout') {
          failure = new AiGatewayError('ai_timeout', {
            provider: adapter.name,
            model,
            attempt,
            reason: 'request-timeout',
          });
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
      }
      const latencyMs = Date.now() - startedAt;

      // 5d. Kill switch checked again before output is accepted.
      if (!failure && !this.config.killSwitchOn()) {
        failure = new AiGatewayError('ai_unavailable', {
          provider: adapter.name,
          model,
          attempt,
          reason: 'kill-switch-off',
        });
      }

      // 5e. Validate a returned object against the caller's validator.
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
        } else if (
          resp.output == null ||
          typeof resp.output !== 'object' ||
          Array.isArray(resp.output)
        ) {
          failure = new AiGatewayError('ai_malformed_output', {
            provider: resp.provider,
            model: resp.model,
            attempt,
            reason: 'output-not-object',
          });
        } else {
          let verdict: StructuredValidation<T>;
          try {
            verdict = req.validate(resp.output);
          } catch {
            verdict = { ok: false, errors: [{ path: '$', detail: 'validator threw' }] };
          }
          if (verdict.ok) parsed = verdict.value;
          else {
            failure = new AiGatewayError(
              'ai_malformed_output',
              {
                provider: resp.provider,
                model: resp.model,
                attempt,
                reason: 'schema-validation-failed',
              },
              undefined,
              { errors: verdict.errors, rawOutput: resp.output },
            );
          }
        }
      }

      // 5f. Settle the reservation (r3, R592-c7A-02/03, R592-c7B-01).
      //     Provider returned (resp, or usage carried on the adapter's
      //     rejection) ⇒ ACTUAL usage. Provider HTTP 4xx ⇒ the request was
      //     rejected before generation (proven unbilled) ⇒ 0. Anything else
      //     after the request was sent (timeout, kill-switch abort, transport
      //     error, 5xx, unknown) ⇒ usage unknown ⇒ the reservation stands.
      const usage: AiProviderUsage | null = resp
        ? {
            promptTokens: resp.promptTokens,
            responseTokens: resp.responseTokens,
            model: resp.model,
            stopReason: resp.stopReason ?? null,
          }
        : (failure?.usage ?? null);
      const status = failure?.detail.httpStatus ?? null;
      const providerRejected =
        !usage && !timedOut && !killed && status != null && status >= 400 && status < 500;
      let usageBasis: 'provider' | 'provider-rejected-4xx' | 'unknown-kept-reservation';
      let promptTokens: number;
      let responseTokens: number;
      let chargedMicros: number;
      if (usage) {
        usageBasis = 'provider';
        promptTokens = usage.promptTokens;
        responseTokens = usage.responseTokens;
        chargedMicros = this.estimateMicros(cfg, promptTokens, responseTokens);
      } else if (providerRejected) {
        usageBasis = 'provider-rejected-4xx';
        promptTokens = 0;
        responseTokens = 0;
        chargedMicros = 0;
      } else {
        usageBasis = 'unknown-kept-reservation';
        promptTokens = inputTokenEstimate;
        responseTokens = maxOutputTokens;
        chargedMicros = reservation.reservedMicros;
      }
      const modelUsed = usage?.model || model;
      const stopReason = usage?.stopReason ?? null;
      const outcome: AttemptOutcome = failure ? failure.code : 'ok';
      const settled = await this.ledger.settle(reservation, {
        chargedMicros,
        outcome,
        enabled: !failure,
        model: modelUsed,
        promptTokens,
        responseTokens,
        responseHash: resp && !failure ? sha256(stableStringify(resp.output)) : null,
        errorCode: failure ? failure.code : null,
        metadata: {
          ...baseExtra,
          attempt,
          context_id: req.contextId ?? null,
          model_requested: model,
          fallback_from: fallbackFrom,
          models_configured: cfg.models.length,
          latency_ms: latencyMs,
          http_status: status,
          error_reason: failure?.detail.reason ?? null,
          stop_reason: stopReason,
          usage_basis: usageBasis,
          validation_error_count: failure?.validation?.errors.length ?? null,
        },
      });
      // A settle failure leaves the row at its reservation: report that.
      const recordedMicros = settled.ok ? chargedMicros : reservation.reservedMicros;
      await this.writeCallLog(
        req,
        modelUsed,
        promptTokens,
        responseTokens,
        recordedMicros,
        latencyMs,
        outcome,
      );

      if (!failure && resp) {
        return {
          requestId,
          auditId: reservation.auditId,
          provider: resp.provider,
          model: modelUsed,
          enabled: true,
          output: parsed as T,
          promptTokens,
          responseTokens,
          latencyMs,
          usdEstimate: microsToUsd(recordedMicros),
          chargeMicros: recordedMicros,
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

  // Integer µUSD, each side rounded UP (money.ts): never 0 for a positive
  // token count at a positive price.
  estimateMicros(
    cfg: ImporterMappingResolvedConfig,
    inputTokens: number,
    outputTokens: number,
  ): number {
    return addMicros(
      tokenCostMicros(nonNegInt(inputTokens), cfg.inputPriceMicrosPerMTok),
      tokenCostMicros(nonNegInt(outputTokens), cfg.outputPriceMicrosPerMTok),
    );
  }

  // Zero-charge audit row for refusals and the stub path (NOT a reservation;
  // paid attempts are written through the ledger). Best effort: a refusal is
  // already the closed outcome, so a write failure cannot open anything.
  private async writeRefusalAudit(a: AuditArgs): Promise<string> {
    const metadata: Record<string, unknown> = {
      ...(a.extra ?? {}),
      ...zeroChargeFields(),
      outcome: a.outcome,
      latency_ms: a.latencyMs,
      context_id: a.req.contextId ?? null,
      models_configured: a.cfg?.models.length ?? 0,
    };
    let auditId = '';
    try {
      const row = await this.prisma.aiRequestAudit.create({
        data: {
          request_id: a.requestId,
          capability: IMPORTER_MAPPING_CAPABILITY,
          requester_id: a.req.requester.id,
          requester_role: a.req.requester.role,
          subject_user_id: null,
          tenant_coach_id: a.req.tenantCoachId ?? null,
          provider: a.provider,
          model: a.model,
          enabled: false,
          context_source_count: 0,
          context_source_refs: Prisma.JsonNull,
          redactions_applied: a.redactions ? toJsonValue(a.redactions) : Prisma.JsonNull,
          prompt_token_estimate: a.promptTokens,
          response_token_estimate: a.responseTokens,
          prompt_hash: a.promptHash,
          response_hash: null,
          approval_status: 'not_required',
          approval_draft_id: null,
          // Closed outcome code only — never a raw provider message.
          error: a.outcome === 'ok' || a.outcome === 'stub' ? null : a.outcome,
          ip: null,
          user_agent: null,
          metadata: toJsonValue(metadata),
        },
        select: { id: true },
      });
      auditId = row.id;
    } catch (err) {
      // Fixed class only — never the driver message.
      this.logger.error(`[importer.mapping] refusal audit write failed (${errorClass(err)})`);
    }
    return auditId;
  }

  private async writeCallLog(
    req: ImporterMappingRequest<unknown>,
    model: string,
    tokensIn: number,
    tokensOut: number,
    chargeMicros: number,
    latencyMs: number,
    outcome: AttemptOutcome,
  ): Promise<void> {
    try {
      const role = req.requester.role;
      const coachId =
        req.tenantCoachId ?? (role === 'coach' || role === 'owner' ? req.requester.id : null);
      await this.prisma.aICallLog.create({
        data: {
          model,
          tokensIn,
          tokensOut,
          costCents: microsToCentsCeil(chargeMicros),
          latencyMs,
          success: outcome === 'ok',
          errorMessage: outcome === 'ok' ? null : outcome,
          coachId,
          clientId: null,
          capability: IMPORTER_MAPPING_CAPABILITY,
        },
      });
    } catch (err) {
      this.logger.warn(`[importer.mapping] AICallLog write failed (${errorClass(err)})`);
    }
  }
}

// Conservative token bound over everything that is sent to the provider.
export function estimateInputTokens(...parts: string[]): number {
  let chars = 0;
  for (const p of parts) chars += Buffer.byteLength(p ?? '', 'utf8');
  return Math.ceil((chars / CHARS_PER_TOKEN) * INPUT_SAFETY_FACTOR) + INPUT_OVERHEAD_TOKENS;
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

// A request may only LOWER the configured cap. A supplied value that is not
// a positive finite number is a caller bug and is refused (R592-c7A-07), not
// silently replaced by the configured maximum.
function clampMaxOutput(configured: number, requested: number | undefined): number {
  if (requested == null) return configured;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) {
    throw new Error('ImporterMappingGatewayService.invokeStructured: maxOutputTokens invalid');
  }
  return Math.min(configured, Math.floor(requested));
}

// Allow-list (R592-A-A3): only known, content-free keys with tightly typed
// values; anything else is a caller bug and rejects the request. The result is
// nested under `metadata.caller`, so no caller key can shadow a charge field.
export function sanitizeAuditMetadata(
  m: ImporterMappingAuditMetadata | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m == null) return out;
  if (typeof m !== 'object' || Array.isArray(m)) throw new Error('auditMetadata must be an object');
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined) continue;
    switch (k) {
      case 'promptTemplateVersion':
      case 'schemaVersion':
        if (typeof v !== 'string' || !VERSION_RE.test(v))
          throw new Error(`auditMetadata.${k} invalid`);
        out[k] = v;
        break;
      case 'contractHash':
        if (typeof v !== 'string' || !HASH_RE.test(v))
          throw new Error(`auditMetadata.${k} invalid`);
        out[k] = v.toLowerCase();
        break;
      case 'round':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 99)
          throw new Error(`auditMetadata.${k} invalid`);
        out[k] = v;
        break;
      case 'callKind':
        if (v !== 'decode' && v !== 'repair' && v !== 'explore')
          throw new Error(`auditMetadata.${k} invalid`);
        out[k] = v;
        break;
      default:
        throw new Error('auditMetadata key not allowed');
    }
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
