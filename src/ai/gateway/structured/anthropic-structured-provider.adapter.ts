import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_CLIENT_TOKEN } from '../../adapters/anthropic.adapter';
import {
  AiStructuredProviderAdapter,
  AiStructuredProviderRequest,
  AiStructuredProviderResponse,
} from './structured-provider.types';
import { AiGatewayError, toAiGatewayError } from './structured-ai.errors';

// L1-gw — structured adapter for the `anthropic` provider slot.
//
// Differences from `AnthropicProviderAdapter` (the legacy free-text shim):
//   * per-request `model` (no COACH_AI_MODEL pin) — the importer's model is a
//     config change, never a code change (record D-L0-7.4);
//   * structured output is REQUIRED: the caller's JSON schema is sent as the
//     `input_schema` of a single tool and `tool_choice` forces that tool, so the
//     provider constrains the output to the schema. The gateway validates the
//     returned object again locally before anyone reads it;
//   * `maxRetries: 0` and the gateway's AbortSignal/timeout are passed to the
//     SDK so the GATEWAY owns retry/fallback and the hard timeout — nothing is
//     retried or swallowed here;
//   * every failure is rethrown as a typed `AiGatewayError`; there is no stub
//     fallback in this class.
//
// Audit/metering is written by the gateway (AiRequestAudit + AICallLog), not
// here, so a single call produces exactly one row per attempt.
@Injectable()
export class AnthropicStructuredProviderAdapter implements AiStructuredProviderAdapter {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicStructuredProviderAdapter.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(ANTHROPIC_CLIENT_TOKEN) injectedClient?: Anthropic,
  ) {
    if (injectedClient) this.client = injectedClient;
  }

  private getClient(): Anthropic {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      // ImporterMappingConfig refuses before we get here; this is the
      // defence-in-depth path and it is still typed.
      throw new AiGatewayError('ai_unavailable', {
        provider: this.name,
        model: null,
        reason: 'provider-key-missing:anthropic',
      });
    }
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async completeStructured(
    req: AiStructuredProviderRequest,
  ): Promise<AiStructuredProviderResponse> {
    if (!req.responseSchema || req.responseSchema.type !== 'object') {
      throw new AiGatewayError('ai_malformed_output', {
        provider: this.name,
        model: req.model,
        reason: 'response-schema-required',
      });
    }
    const startedAt = Date.now();
    const client = this.getClient();
    let resp: Anthropic.Messages.Message;
    try {
      resp = await client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          temperature: req.temperature,
          system: req.systemPrompt,
          messages: [{ role: 'user', content: req.userContent }],
          tools: [
            {
              name: req.schemaName,
              description:
                'Return the structured result. The input of this tool IS the answer; it must conform exactly to the schema.',
              input_schema: req.responseSchema as Anthropic.Messages.Tool.InputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: req.schemaName, disable_parallel_tool_use: true },
        },
        { signal: req.signal, timeout: req.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      const mapped = toAiGatewayError(err, {
        provider: this.name,
        model: req.model,
        attempt: 0,
        timedOut: req.signal.aborted,
      });
      this.logger.warn(
        `[importer.mapping] provider call failed code=${mapped.code} status=${mapped.detail.httpStatus ?? 'n/a'} model=${req.model}`,
      );
      throw mapped;
    }
    const latencyMs = Date.now() - startedAt;
    const promptTokens = resp.usage?.input_tokens ?? 0;
    const responseTokens = resp.usage?.output_tokens ?? 0;
    const modelUsed = resp.model ?? req.model;
    const stopReason = resp.stop_reason ?? null;

    const toolUse = Array.isArray(resp.content)
      ? resp.content.find(
          (b): b is Anthropic.Messages.ToolUseBlock =>
            !!b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use',
        )
      : undefined;

    if (stopReason === 'max_tokens') {
      // Truncated output can never be trusted as a conforming object
      // (record D-L0-7.3: truncated ⇒ non-conforming). Not retryable.
      throw new AiGatewayError('ai_malformed_output', {
        provider: this.name,
        model: modelUsed,
        reason: 'truncated-at-max-tokens',
      });
    }
    if (stopReason === 'refusal') {
      throw new AiGatewayError('ai_request_rejected', {
        provider: this.name,
        model: modelUsed,
        reason: 'provider-refusal',
      });
    }
    if (
      !toolUse ||
      toolUse.name !== req.schemaName ||
      toolUse.input == null ||
      typeof toolUse.input !== 'object'
    ) {
      throw new AiGatewayError('ai_malformed_output', {
        provider: this.name,
        model: modelUsed,
        reason: 'no-structured-block',
      });
    }

    return {
      provider: this.name,
      model: modelUsed,
      output: toolUse.input,
      enabled: true,
      promptTokens,
      responseTokens,
      latencyMs,
      stopReason,
    };
  }
}
