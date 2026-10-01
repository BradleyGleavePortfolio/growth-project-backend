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
 *   3. fails closed: no grant, an older copy, ledger flag off, a ledger read
 *      error, an unexpected throw, a client subject with no ids, or client
 *      data aimed at a processor other than Anthropic all refuse the send;
 *   4. only then calls the provider SDK.
 *
 * The SDK clients are built only in ./provider-clients.ts. A static guard
 * (test/ai-egress/ai-egress-guard.spec.ts) fails CI if any other file under
 * src/ imports an AI SDK value, builds a client, calls a provider method or
 * names a provider host.
 *
 * Logging: surface label, processor, client COUNT and the refusal kind only.
 * Never client ids, prompt text or exception messages.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AI_CONSENT_BATCH_MAX } from '../ai-consent/ai-consent.constants';
import { CLIENT_AI_CONSENT_READER, ClientAiConsentReader } from '../ai-consent/ai-consent.reader';
import {
  AiConsentRequiredException,
  AiEgressPolicyException,
} from './ai-consent-required.exception';
import {
  AiDataSubject,
  AiEgressSurface,
  AiProcessor,
  CONSENTED_AI_PROCESSOR,
  NO_CLIENT_DATA_REASONS,
} from './ai-egress.types';

export type AnthropicStream = ReturnType<Anthropic['messages']['stream']>;

/** The part of an Anthropic client the gate uses (real client or a test fake). */
export interface AnthropicMessagesClient {
  messages: Pick<Anthropic['messages'], 'create' | 'stream'>;
}

/** The part of an OpenAI-compatible (Perplexity) client the gate uses. */
export interface PerplexityChatClient {
  chat: { completions: Pick<OpenAI['chat']['completions'], 'create'> };
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
    const granted = await this.consentedClients(ids);
    const missing = ids.filter((id) => !granted.has(id)).length;
    if (missing > 0) {
      this.logger.log(
        `ai_egress.refused surface=${surface} reason=no_live_grant clients=${ids.length} missing=${missing}`,
      );
      throw new AiConsentRequiredException(subject.audience);
    }
  }

  /**
   * The subset of `clientIds` holding a live box-2 grant right now. For call
   * sites that build one prompt from several clients (coach brief, community
   * triage): drop everyone else BEFORE the prompt is built, then send with
   * the kept ids so the grant is re-read at send time. Fails closed: any
   * error yields an empty set. Never cached.
   */
  async consentedClients(clientIds: readonly string[]): Promise<ReadonlySet<string>> {
    const unique = [...new Set(clientIds.filter((id) => typeof id === 'string' && id.length > 0))];
    const out = new Set<string>();
    try {
      for (let i = 0; i < unique.length; i += AI_CONSENT_BATCH_MAX) {
        const chunk = unique.slice(i, i + AI_CONSENT_BATCH_MAX);
        if (chunk.length === 1) {
          if ((await this.consent.hasClientAiConsent(chunk[0])) === true) out.add(chunk[0]);
          continue;
        }
        const granted = await this.consent.clientsWithAiConsent(chunk);
        for (const id of chunk) if (granted.has(id)) out.add(id);
      }
    } catch {
      this.logger.warn('ai_egress.consent_read_failed (treated as no grant)');
      return new Set();
    }
    return out;
  }

  /** Anthropic Messages API, request/response. */
  async anthropicMessagesCreate(
    client: AnthropicMessagesClient,
    subject: AiDataSubject,
    surface: AiEgressSurface,
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: Anthropic.RequestOptions,
  ): Promise<Anthropic.Message> {
    await this.assertMaySend(subject, 'anthropic', surface);
    return client.messages.create(params, options);
  }

  /** Anthropic Messages API, streaming (Roman). */
  async anthropicMessagesStream(
    client: AnthropicMessagesClient,
    subject: AiDataSubject,
    surface: AiEgressSurface,
    params: Anthropic.MessageStreamParams,
    options?: Anthropic.RequestOptions,
  ): Promise<AnthropicStream> {
    await this.assertMaySend(subject, 'anthropic', surface);
    return client.messages.stream(params, options);
  }

  /**
   * Perplexity (OpenAI-compatible chat completions). Not covered by the
   * box-2 copy: a client-data subject is always refused.
   */
  async perplexityChatCreate(
    client: PerplexityChatClient,
    subject: AiDataSubject,
    surface: AiEgressSurface,
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    await this.assertMaySend(subject, 'perplexity', surface);
    return client.chat.completions.create(params);
  }
}
