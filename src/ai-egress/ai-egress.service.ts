/**
 * R2b — the single AI egress point (D2 consent contract, box 2; WA RCW 19.373).
 *
 * Every request the server sends to an external AI provider goes through one
 * of the three send methods below. Each send:
 *
 *   1. takes the call site's declared data subject (ai-egress.types.ts);
 *   2. for client data, reads every listed client's box-2 grant LIVE from the
 *      R2a ledger (CLIENT_AI_CONSENT_READER) immediately before the request.
 *      Nothing is cached here, so a withdrawal stops the very next request,
 *      including retries and JSON repair passes (each one calls send again);
 *      A subject with scope 'memory' (Roman v1.1) needs a live client-ai-v5
 *      grant for every listed client; a v4 grant covers 'base' only;
 *   3. fails closed: no grant, an older copy, ledger flag off, a ledger read
 *      error, an unexpected throw, a client subject with no ids, or client
 *      data aimed at a processor other than Anthropic all refuse the send;
 *   4. only then makes ONE provider request. SDK auto-retry is forced off on
 *      every request (`maxRetries: 0`, whatever the client or options say).
 *      Transient failures are retried HERE, and every retry re-reads the
 *      grant first, so a withdrawal also stops the next retry (A-626-1).
 *
 * Capability boundary (C-626-1): call sites never hold an SDK client. They
 * hold an opaque AnthropicHandle / PerplexityHandle, and the client behind a
 * handle is reachable only from this module (module-private WeakMaps), so
 * the only way to talk to a provider is through the send methods below.
 * SDK clients are built only in ./provider-clients.ts; ESLint
 * (no-restricted-imports, eslint.config.js) and the static guard
 * (test/ai-egress/ai-egress-guard.spec.ts) fail CI if any other file under
 * src/ imports an AI SDK value, builds a client, calls a provider method or
 * names a provider host.
 *
 * Logging: surface label, processor, client COUNT and the refusal kind only.
 * Never client ids, prompt text or exception messages.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import AnthropicSdk from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import OpenAISdk from 'openai';
import type OpenAI from 'openai';
import { AI_CONSENT_BATCH_MAX } from '../ai-consent/ai-consent.constants';
import { CLIENT_AI_CONSENT_READER, ClientAiConsentReader } from '../ai-consent/ai-consent.reader';
import {
  AiConsentRequiredException,
  AiEgressPolicyException,
  isAiEgressRefusal,
} from './ai-consent-required.exception';
import {
  AiConsentScope,
  AiDataSubject,
  AiEgressSurface,
  AiProcessor,
  CONSENTED_AI_PROCESSOR,
  NO_CLIENT_DATA_REASONS,
} from './ai-egress.types';

export type AnthropicStream = ReturnType<Anthropic['messages']['stream']>;

/**
 * B-ROMANIQ-125: Claude Sonnet 5.5's lowest thinking setting, "no up-front
 * thinking" (platform.claude.com/docs/en/models/sonnet-5-5/migration-guide:
 * "To turn off up-front thinking on Claude Sonnet 5.5, send thinking:
 * {type: between_tools}"; `disabled` returns a 400 there). The installed SDK's
 * ThinkingConfigParam (enabled | disabled | adaptive) predates it; the SDK
 * sends the request body as given, so the gate accepts the wider union and
 * hands the SDK its own param type at the one call below.
 */
export interface AnthropicThinkingBetweenTools {
  type: 'between_tools';
}
export type AnthropicThinkingParam = Anthropic.ThinkingConfigParam | AnthropicThinkingBetweenTools;
export type AnthropicCreateParams = Omit<Anthropic.MessageCreateParamsNonStreaming, 'thinking'> & {
  thinking?: AnthropicThinkingParam;
};
export type AnthropicStreamParams = Omit<Anthropic.MessageStreamParams, 'thinking'> & {
  thinking?: AnthropicThinkingParam;
};

/** The part of an Anthropic client the gate uses (real client or a test fake). */
export interface AnthropicMessagesClient {
  messages: Pick<Anthropic['messages'], 'create' | 'stream'>;
}

/** The part of an OpenAI-compatible (Perplexity) client the gate uses. */
export interface PerplexityChatClient {
  chat: { completions: Pick<OpenAI['chat']['completions'], 'create'> };
}

// Module-private: the only path from a handle back to its client.
const anthropicClients = new WeakMap<AnthropicHandle, AnthropicMessagesClient>();
const perplexityClients = new WeakMap<PerplexityHandle, PerplexityChatClient>();

/**
 * Opaque capability to send to Anthropic. Has no properties and no methods:
 * holding one does not let a call site reach the SDK. Only AiEgressService
 * can send with it (after the consent check). `bind` is for the factory in
 * ./provider-clients.ts and for test doubles; binding never unwraps.
 */
export class AnthropicHandle {
  declare private readonly nominal: 'anthropic';
  private constructor() {}
  static bind(client: AnthropicMessagesClient): AnthropicHandle {
    const handle = new AnthropicHandle();
    anthropicClients.set(handle, client);
    Object.freeze(handle);
    return handle;
  }
}

/** Opaque capability to send to Perplexity (no-client-data exemptions only). */
export class PerplexityHandle {
  declare private readonly nominal: 'perplexity';
  private constructor() {}
  static bind(client: PerplexityChatClient): PerplexityHandle {
    const handle = new PerplexityHandle();
    perplexityClients.set(handle, client);
    Object.freeze(handle);
    return handle;
  }
}

/** Retries the gate makes after the first attempt (the old SDK default). */
export const AI_EGRESS_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRY_AFTER_CAP_MS = 60_000;

/** Per-send options owned by the gate (never forwarded to the SDK). */
export interface AiEgressSendOptions {
  /**
   * Transient-failure retries for this send (default AI_EGRESS_MAX_RETRIES).
   * A caller that owns its own retry loop through this gate passes 0.
   */
  retries?: number;
}

const CONNECTION_ERROR_CLASSES = [
  AnthropicSdk.APIConnectionError,
  OpenAISdk.APIConnectionError,
].filter((c): c is NonNullable<typeof c> => typeof c === 'function');

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  return typeof err.status === 'number' ? err.status : undefined;
}

function headerOf(err: unknown, name: string): string | null {
  if (typeof err !== 'object' || err === null || !('headers' in err)) return null;
  const headers = err.headers;
  if (typeof headers !== 'object' || headers === null || !('get' in headers)) return null;
  const get = headers.get;
  if (typeof get !== 'function') return null;
  const value: unknown = get.call(headers, name);
  return typeof value === 'string' ? value : null;
}

/**
 * The SDK's own retry rule, applied by the gate instead: connection errors
 * and timeouts, 408, 409, 429 and 5xx, unless the provider says
 * `x-should-retry: false`. A caller abort is never retried.
 */
export function isRetryableProviderError(err: unknown): boolean {
  if (isAiEgressRefusal(err)) return false;
  const hint = headerOf(err, 'x-should-retry');
  if (hint === 'false') return false;
  if (hint === 'true') return true;
  if (CONNECTION_ERROR_CLASSES.some((c) => err instanceof c)) return true;
  const status = statusOf(err);
  if (status === undefined) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(err: unknown, retry: number): number {
  const msHeader = headerOf(err, 'retry-after-ms');
  if (msHeader !== null) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0 && ms <= RETRY_AFTER_CAP_MS) return ms;
  }
  const after = headerOf(err, 'retry-after');
  if (after !== null) {
    const seconds = Number(after);
    const fromHeader = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
    if (Number.isFinite(fromHeader) && fromHeader >= 0 && fromHeader <= RETRY_AFTER_CAP_MS)
      return fromHeader;
  }
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** retry, RETRY_MAX_DELAY_MS);
  return backoff * (1 - Math.random() * 0.25);
}

@Injectable()
export class AiEgressService {
  private readonly logger = new Logger(AiEgressService.name);

  constructor(@Inject(CLIENT_AI_CONSENT_READER) private readonly consent: ClientAiConsentReader) {}

  /**
   * Throws unless `subject` may be sent to `processor` right now.
   * Public so call sites can refuse BEFORE doing work (claiming an idempotency
   * row, persisting a chat turn); the send methods call it again regardless.
   */
  async assertMaySend(
    subject: AiDataSubject,
    processor: AiProcessor,
    surface: AiEgressSurface,
  ): Promise<void> {
    if (subject.kind === 'no_client_data') {
      if (!(NO_CLIENT_DATA_REASONS as readonly string[]).includes(subject.reason)) {
        this.logger.error(`ai_egress.blocked surface=${surface} reason=unknown_exemption`);
        throw new AiEgressPolicyException();
      }
      return;
    }
    const ids = subject.clientIds.filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      this.logger.error(`ai_egress.blocked surface=${surface} reason=client_subject_without_ids`);
      throw new AiEgressPolicyException();
    }
    if (processor !== CONSENTED_AI_PROCESSOR) {
      this.logger.error(
        `ai_egress.blocked surface=${surface} processor=${processor} reason=processor_not_consented`,
      );
      throw new AiEgressPolicyException();
    }
    const scope = subject.scope === 'memory' ? 'memory' : 'base';
    const granted = await this.consentedClients(ids, scope);
    const missing = ids.filter((id) => !granted.has(id)).length;
    if (missing > 0) {
      this.logger.log(
        `ai_egress.refused surface=${surface} reason=no_live_grant scope=${scope} clients=${ids.length} missing=${missing}`,
      );
      throw new AiConsentRequiredException(subject.audience);
    }
  }

  /**
   * The subset of `clientIds` holding a live box-2 grant right now. For call
   * sites that build one prompt from several clients (coach brief, community
   * triage): drop everyone else BEFORE the prompt is built, then send with
   * the kept ids so the grant is re-read at send time. Fails closed: any
   * error yields an empty set. Never cached. `scope` 'memory' keeps only
   * live client-ai-v5 holders (Roman v1.1); the default 'base' is unchanged.
   */
  async consentedClients(
    clientIds: readonly string[],
    scope: AiConsentScope = 'base',
  ): Promise<ReadonlySet<string>> {
    const unique = [...new Set(clientIds.filter((id) => typeof id === 'string' && id.length > 0))];
    const out = new Set<string>();
    try {
      for (let i = 0; i < unique.length; i += AI_CONSENT_BATCH_MAX) {
        const chunk = unique.slice(i, i + AI_CONSENT_BATCH_MAX);
        if (chunk.length === 1) {
          if ((await this.consent.hasClientAiConsent(chunk[0], scope)) === true) out.add(chunk[0]);
          continue;
        }
        const granted = await this.consent.clientsWithAiConsent(chunk, scope);
        for (const id of chunk) if (granted.has(id)) out.add(id);
      }
    } catch {
      this.logger.warn('ai_egress.consent_read_failed (treated as no grant)');
      return new Set();
    }
    return out;
  }

  /**
   * R11-M4: when each of `clientIds` recorded the live client-ai-v5 ('memory') grant they hold now
   * (others absent). Fails closed: an error, or a reader without this read, gives an empty map.
   */
  async memoryGrantTimes(clientIds: readonly string[]): Promise<ReadonlyMap<string, Date>> {
    const unique = [...new Set(clientIds.filter((id) => typeof id === 'string' && id.length > 0))];
    const out = new Map<string, Date>();
    try {
      for (let i = 0; i < unique.length; i += AI_CONSENT_BATCH_MAX) {
        const got = await this.consent.memoryGrantTimes?.(unique.slice(i, i + AI_CONSENT_BATCH_MAX));
        for (const [id, at] of got ?? []) out.set(id, at);
      }
    } catch {
      this.logger.warn('ai_egress.consent_read_failed (treated as no grant)');
      return new Map();
    }
    return out;
  }

  /**
   * One gated send with gate-owned retries: the grant is re-read before EVERY
   * attempt, and `attempt` must make exactly one provider request (SDK
   * retries off). Refusals and non-transient errors are thrown unchanged.
   */
  private async sendGated<T>(
    subject: AiDataSubject,
    processor: AiProcessor,
    surface: AiEgressSurface,
    send: AiEgressSendOptions | undefined,
    signal: AbortSignal | null | undefined,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const retries = Math.max(
      0,
      Math.min(send?.retries ?? AI_EGRESS_MAX_RETRIES, AI_EGRESS_MAX_RETRIES),
    );
    for (let retry = 0; ; retry++) {
      await this.assertMaySend(subject, processor, surface);
      try {
        return await attempt();
      } catch (err) {
        if (retry >= retries || signal?.aborted || !isRetryableProviderError(err)) throw err;
        this.logger.warn(
          `ai_egress.retry surface=${surface} processor=${processor} status=${statusOf(err) ?? 'none'} next_attempt=${retry + 2}`,
        );
        await this.sleep(retryDelayMs(err, retry));
      }
    }
  }

  /** Overridable in tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private anthropicClientOf(
    handle: AnthropicHandle,
    surface: AiEgressSurface,
  ): AnthropicMessagesClient {
    const client = handle instanceof AnthropicHandle ? anthropicClients.get(handle) : undefined;
    if (!client) {
      this.logger.error(`ai_egress.blocked surface=${surface} reason=unbound_handle`);
      throw new AiEgressPolicyException();
    }
    return client;
  }

  /** Anthropic Messages API, request/response. */
  async anthropicMessagesCreate(
    handle: AnthropicHandle,
    subject: AiDataSubject,
    surface: AiEgressSurface,
    params: AnthropicCreateParams,
    options?: Anthropic.RequestOptions,
    send?: AiEgressSendOptions,
  ): Promise<Anthropic.Message> {
    const client = this.anthropicClientOf(handle, surface);
    const body = params as Anthropic.MessageCreateParamsNonStreaming;
    return this.sendGated(subject, 'anthropic', surface, send, options?.signal, () =>
      client.messages.create(body, { ...options, maxRetries: 0 }),
    );
  }

  /**
   * Anthropic Messages API, streaming (Roman). Resolves once the provider
   * has accepted the request (HTTP response received), so a transient
   * failure before any token is retried here, behind a fresh consent read.
   * Nothing is retried once streaming has started.
   */
  async anthropicMessagesStream(
    handle: AnthropicHandle,
    subject: AiDataSubject,
    surface: AiEgressSurface,
    params: AnthropicStreamParams,
    options?: Anthropic.RequestOptions,
    send?: AiEgressSendOptions,
  ): Promise<AnthropicStream> {
    const client = this.anthropicClientOf(handle, surface);
    const body = params as Anthropic.MessageStreamParams;
    return this.sendGated(subject, 'anthropic', surface, send, options?.signal, async () => {
      const stream = client.messages.stream(body, { ...options, maxRetries: 0 });
      if (typeof stream.withResponse === 'function') await stream.withResponse();
      return stream;
    });
  }

  /**
   * Perplexity (OpenAI-compatible chat completions). Not covered by the
   * box-2 copy: a client-data subject is always refused.
   */
  async perplexityChatCreate(
    handle: PerplexityHandle,
    subject: AiDataSubject,
    surface: AiEgressSurface,
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    send?: AiEgressSendOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const client = handle instanceof PerplexityHandle ? perplexityClients.get(handle) : undefined;
    if (!client) {
      this.logger.error(`ai_egress.blocked surface=${surface} reason=unbound_handle`);
      throw new AiEgressPolicyException();
    }
    return this.sendGated(subject, 'perplexity', surface, send, undefined, () =>
      client.chat.completions.create(params, { maxRetries: 0 }),
    );
  }
}
