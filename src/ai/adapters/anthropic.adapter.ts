import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma.service';
import {
  AiEgressService,
  AnthropicHandle,
  isRetryableProviderError,
} from '../../ai-egress/ai-egress.service';
import { isAiEgressRefusal } from '../../ai-egress/ai-consent-required.exception';
import type { AiDataSubject, AiEgressSurface } from '../../ai-egress/ai-egress.types';
import { createAnthropicClient } from '../../ai-egress/provider-clients';
import {
  COACH_AI_EFFORT,
  COACH_AI_MODEL,
  COACH_AI_THINKING,
  INPUT_USD_PER_MTOK,
  OUTPUT_USD_PER_MTOK,
  CoachAICapability,
} from '../coach/coach-ai.constants';

// Optional DI token so tests can inject a fake Anthropic client. Production
// boot leaves it unset and the adapter lazily constructs a real client from
// ANTHROPIC_API_KEY.
export const ANTHROPIC_CLIENT_TOKEN = 'ANTHROPIC_CLIENT';

export interface AnthropicCompleteInput {
  system: string;
  user: string;
}

export interface AnthropicCompleteOptions {
  // R2b — REQUIRED. Whose data is in the prompt. Client data needs every
  // listed client's live box-2 grant; checked before EVERY attempt (first
  // call, retries, the JSON repair pass).
  dataSubject: AiDataSubject;
  // R2b — call-site label for egress logs (no user data).
  surface: AiEgressSurface;
  maxTokens?: number;
  // Logging metadata. Persisted to AICallLog. None of these end up in the
  // request body to Anthropic.
  capability?: CoachAICapability | string;
  coachId?: string | null;
  clientId?: string | null;
}

export interface AnthropicCompleteResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  modelUsed: string;
  latencyMs: number;
}

export interface AnthropicStructuredResult<T> {
  data: T;
  tokensIn: number;
  tokensOut: number;
  modelUsed: string;
  latencyMs: number;
}

// Lightweight runtime validator type. Each prompt exposes a function that
// throws on shape violation. We deliberately avoid a hard dependency on
// `zod` so the adapter stays usable from any module.
export type RuntimeValidator<T> = (raw: unknown) => T;

const RETRY_DELAYS_MS = [250, 1000, 4000];

@Injectable()
export class AnthropicAdapter {
  private readonly logger = new Logger(AnthropicAdapter.name);
  private client: AnthropicHandle | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly egress: AiEgressService,
    @Optional() @Inject(ANTHROPIC_CLIENT_TOKEN) injectedClient?: AnthropicHandle,
  ) {
    if (injectedClient) this.client = injectedClient;
  }

  // Lazy client construction. Throws if no key is configured — callers
  // should check CoachAIModuleState before invoking the adapter.
  private getClient(): AnthropicHandle {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    this.client = createAnthropicClient(apiKey);
    return this.client;
  }

  // Free-text completion. The system prompt and user message are the two
  // inputs the rest of the engine reasons about. Token counts come back
  // from the SDK `usage` block; cost is computed locally from the
  // published Sonnet pricing.
  async complete(
    prompt: AnthropicCompleteInput,
    opts: AnthropicCompleteOptions,
  ): Promise<AnthropicCompleteResult> {
    const maxTokens = opts.maxTokens ?? 1024;
    const startedAt = Date.now();

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        const client = this.getClient();
        // R2b — the consent gate runs inside the egress call, per attempt.
        // This loop owns retries for this path ({ retries: 0 }), and each
        // attempt re-enters the gate, so a withdrawal stops the next one.
        const resp = await this.egress.anthropicMessagesCreate(
          client,
          opts.dataSubject,
          opts.surface,
          {
            model: COACH_AI_MODEL,
            max_tokens: maxTokens,
            // B-ROMANIQ-125: no temperature (a non-default value is a 400 on
            // Sonnet 5.5); thinking and effort pinned in coach-ai.constants.
            thinking: COACH_AI_THINKING,
            output_config: { effort: COACH_AI_EFFORT },
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
          },
          undefined,
          { retries: 0 },
        );
        const latencyMs = Date.now() - startedAt;
        const text = extractText(resp);
        const tokensIn = resp.usage?.input_tokens ?? 0;
        const tokensOut = resp.usage?.output_tokens ?? 0;
        const modelUsed = resp.model ?? COACH_AI_MODEL;
        await this.writeCallLog({
          model: modelUsed,
          tokensIn,
          tokensOut,
          latencyMs,
          success: true,
          opts,
        });
        return { text, tokensIn, tokensOut, modelUsed, latencyMs };
      } catch (err) {
        // R2b — a consent / egress refusal sent nothing: no retry, no call
        // log row, surface it unchanged so the caller can show the reason.
        if (isAiEgressRefusal(err)) throw err;
        lastErr = err;
        const status = pickStatus(err);
        // R2b — the gate's transient-error rule (connection errors, 408,
        // 409, 429, 5xx), since SDK auto-retry is off on every request.
        const isRetryable = isRetryableProviderError(err);
        if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) break;
        const delay = RETRY_DELAYS_MS[attempt];
        this.logger.warn(
          `[anthropic] retryable error status=${status} attempt=${attempt + 1} delay=${delay}ms`,
        );
        await sleep(delay);
      }
    }
    const latencyMs = Date.now() - startedAt;
    await this.writeCallLog({
      model: COACH_AI_MODEL,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs,
      success: false,
      errorMessage: errorMessageOf(lastErr),
      opts,
    });
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // JSON-shaped completion. Strategy: instruct the model in the system
  // prompt to return ONLY valid JSON conforming to the schema, then
  // JSON.parse + runtime-validate. On parse/validation failure we issue
  // ONE repair prompt asking for "valid JSON only matching the schema"
  // before bubbling the error.
  async completeStructured<T>(
    prompt: AnthropicCompleteInput,
    validator: RuntimeValidator<T>,
    opts: AnthropicCompleteOptions,
  ): Promise<AnthropicStructuredResult<T>> {
    const enforced: AnthropicCompleteInput = {
      system:
        prompt.system +
        '\n\nIMPORTANT: respond with VALID JSON only. No prose before or after the JSON. No markdown code fences. The JSON must conform exactly to the schema described above.',
      user: prompt.user,
    };

    const first = await this.complete(enforced, opts);
    try {
      const parsed = safeJsonParse(first.text);
      const validated = validator(parsed);
      return {
        data: validated,
        tokensIn: first.tokensIn,
        tokensOut: first.tokensOut,
        modelUsed: first.modelUsed,
        latencyMs: first.latencyMs,
      };
    } catch (err) {
      this.logger.warn(
        `[anthropic] structured parse failed; attempting one repair: ${errorMessageOf(err)}`,
      );
    }

    // Repair pass. Hand the model its own bad output and ask for valid
    // JSON only. Cost is tracked; tokens accumulate.
    const repair = await this.complete(
      {
        system:
          enforced.system +
          '\n\nYour previous output was invalid JSON. Return ONLY valid JSON matching the schema. No prose, no fences.',
        user:
          prompt.user +
          '\n\n---\nYour previous output was:\n' +
          first.text.slice(0, 4000) +
          '\n---\nReturn ONLY valid JSON matching the schema above.',
      },
      opts,
    );
    const parsed = safeJsonParse(repair.text);
    const validated = validator(parsed);
    return {
      data: validated,
      tokensIn: first.tokensIn + repair.tokensIn,
      tokensOut: first.tokensOut + repair.tokensOut,
      modelUsed: repair.modelUsed,
      latencyMs: first.latencyMs + repair.latencyMs,
    };
  }

  // Compute cost in integer cents from token counts. Public so the boot
  // probe and tests can reuse the math without re-importing constants.
  static computeCostCents(tokensIn: number, tokensOut: number): number {
    const dollars =
      (tokensIn / 1_000_000) * INPUT_USD_PER_MTOK +
      (tokensOut / 1_000_000) * OUTPUT_USD_PER_MTOK;
    return Math.round(dollars * 100);
  }

  private async writeCallLog(args: {
    model: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    success: boolean;
    errorMessage?: string;
    opts: AnthropicCompleteOptions;
  }): Promise<void> {
    try {
      await this.prisma.aICallLog.create({
        data: {
          model: args.model,
          tokensIn: args.tokensIn,
          tokensOut: args.tokensOut,
          costCents: AnthropicAdapter.computeCostCents(args.tokensIn, args.tokensOut),
          latencyMs: args.latencyMs,
          success: args.success,
          errorMessage: args.errorMessage ?? null,
          coachId: args.opts.coachId ?? null,
          clientId: args.opts.clientId ?? null,
          capability: String(args.opts.capability ?? 'unknown'),
        },
      });
    } catch (err) {
      // Never let logging failures break the request path.
      this.logger.warn(`[anthropic] AICallLog write failed: ${errorMessageOf(err)}`);
    }
  }
}

function extractText(resp: { content: Array<unknown> }): string {
  if (!Array.isArray(resp.content)) return '';
  const parts: string[] = [];
  for (const block of resp.content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: string }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n').trim();
}

function pickStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
    return e.status ?? e.statusCode ?? e.response?.status ?? null;
  }
  return null;
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(text: string): unknown {
  // Tolerate a stray ```json ... ``` fence. The system prompt forbids
  // fences but models occasionally ignore that instruction.
  const trimmed = text.trim();
  const stripped = stripCodeFence(trimmed);
  return JSON.parse(stripped);
}

function stripCodeFence(s: string): string {
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    const closing = s.lastIndexOf('```');
    if (firstNewline > 0 && closing > firstNewline) {
      return s.slice(firstNewline + 1, closing).trim();
    }
  }
  return s;
}
