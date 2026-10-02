/**
 * R2b fix round (A-626-1) — SDK-internal retries must not resend a client's
 * data after they withdraw box 2.
 *
 * These tests use the REAL installed SDKs with an in-memory transport (no
 * network, no real key). The first HTTP request withdraws the client's grant
 * and fails with a retryable error (500 / 429 / connection error). Before the
 * fix the SDK retried inside one gate call and re-sent the payload with the
 * grant already withdrawn. Now SDK auto-retry is forced off on every request
 * and the gate owns retries, re-reading the grant before each one, so the
 * second request is never sent and the caller gets ai_consent_required.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import {
  AI_EGRESS_MAX_RETRIES,
  AiEgressService,
  AnthropicHandle,
  PerplexityHandle,
  isRetryableProviderError,
} from '../../src/ai-egress/ai-egress.service';
import { clientDataSubject, noClientDataSubject } from '../../src/ai-egress/ai-egress.types';
import {
  createAnthropicClient,
  createPerplexityClient,
} from '../../src/ai-egress/provider-clients';
import { egressWithGrants } from './ai-egress.fakes';

const CLIENT = 'client-a';
const SUBJECT = clientDataSubject(CLIENT, 'client');
const PAYLOAD = 'SYNTHETIC_CLIENT_DATA';
const PARAMS = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: PAYLOAD }],
};

const MESSAGE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function sseBody(): string {
  const events = [
    { type: 'message_start', message: { ...MESSAGE, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

type Failure = '500' | '429' | 'connection';

function failure(kind: Failure): Response {
  if (kind === 'connection') throw new TypeError('fetch failed');
  const status = kind === '500' ? 500 : 429;
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'transient' } }),
    {
      status,
      headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
    },
  );
}

/**
 * In-memory transport. `onFirst` runs on the first request (used to withdraw
 * consent) and the first request fails with `first`; later requests succeed.
 */
function transport(opts: {
  first: Failure;
  onFirst?: () => void;
  streaming?: boolean;
  perplexity?: boolean;
}) {
  const bodies: string[] = [];
  const fetchImpl = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    if (bodies.length === 1) {
      opts.onFirst?.();
      return failure(opts.first);
    }
    if (opts.perplexity) {
      return new Response(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'sonar',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (opts.streaming) {
      return new Response(sseBody(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(MESSAGE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { bodies, fetchImpl: fetchImpl as typeof fetch };
}

function noSleep(egress: AiEgressService): AiEgressService {
  egress['sleep'] = async () => undefined;
  return egress;
}

describe('A-626-1 — withdrawal during a transient failure stops the retry', () => {
  describe.each<Failure>(['500', '429', 'connection'])('first request fails with %s', (first) => {
    it('create: one request, then refused before any resend', async () => {
      const { egress, reader } = egressWithGrants([CLIENT]);
      noSleep(egress);
      const t = transport({ first, onFirst: () => reader.revoke(CLIENT) });
      const handle = createAnthropicClient('test-key-not-a-secret', { fetch: t.fetchImpl });

      await expect(
        egress.anthropicMessagesCreate(handle, SUBJECT, 'roman.chat', PARAMS),
      ).rejects.toBeInstanceOf(AiConsentRequiredException);
      expect(t.bodies).toHaveLength(1);
      expect(reader.calls.length).toBe(2); // read before attempt 1 and before the retry
    });

    it('stream: one request, then refused before any resend', async () => {
      const { egress, reader } = egressWithGrants([CLIENT]);
      noSleep(egress);
      const t = transport({ first, streaming: true, onFirst: () => reader.revoke(CLIENT) });
      const handle = createAnthropicClient('test-key-not-a-secret', { fetch: t.fetchImpl });

      await expect(
        egress.anthropicMessagesStream(handle, SUBJECT, 'roman.chat', PARAMS),
      ).rejects.toBeInstanceOf(AiConsentRequiredException);
      expect(t.bodies).toHaveLength(1);
      expect(reader.calls.length).toBe(2);
    });
  });

  it('an injected client built WITH SDK retries still makes one request per consent read', async () => {
    const { egress, reader } = egressWithGrants([CLIENT]);
    noSleep(egress);
    const t = transport({ first: '500', onFirst: () => reader.revoke(CLIENT) });
    const retrying = new Anthropic({
      apiKey: 'test-key-not-a-secret',
      maxRetries: 5,
      fetch: t.fetchImpl,
    });
    await expect(
      egress.anthropicMessagesCreate(
        AnthropicHandle.bind(retrying),
        SUBJECT,
        'roman.chat',
        PARAMS,
        {
          maxRetries: 5,
        },
      ),
    ).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(t.bodies).toHaveLength(1);
  });

  it('grant still live: the gate retries, re-reading the grant before each attempt', async () => {
    const { egress, reader } = egressWithGrants([CLIENT]);
    noSleep(egress);
    const t = transport({ first: '500' });
    const handle = createAnthropicClient('test-key-not-a-secret', { fetch: t.fetchImpl });
    const msg = await egress.anthropicMessagesCreate(handle, SUBJECT, 'roman.chat', PARAMS);
    expect(msg.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(t.bodies).toHaveLength(2);
    expect(reader.calls.length).toBe(2);
  });

  it('grant still live, stream: retried before the first token, then streams normally', async () => {
    const { egress } = egressWithGrants([CLIENT]);
    noSleep(egress);
    const t = transport({ first: '429', streaming: true });
    const handle = createAnthropicClient('test-key-not-a-secret', { fetch: t.fetchImpl });
    const stream = await egress.anthropicMessagesStream(handle, SUBJECT, 'roman.chat', PARAMS);
    let text = '';
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta')
        text += ev.delta.text;
    }
    expect(text).toBe('ok');
    expect(t.bodies).toHaveLength(2);
  });

  it('gives up after AI_EGRESS_MAX_RETRIES retries and surfaces the provider error', async () => {
    const { egress, reader } = egressWithGrants([CLIENT]);
    noSleep(egress);
    const bodies: string[] = [];
    const always500 = (async () => {
      bodies.push('x');
      return failure('500');
    }) as typeof fetch;
    const handle = createAnthropicClient('test-key-not-a-secret', { fetch: always500 });
    const err = await egress
      .anthropicMessagesCreate(handle, SUBJECT, 'roman.chat', PARAMS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.InternalServerError);
    expect(bodies).toHaveLength(1 + AI_EGRESS_MAX_RETRIES);
    expect(reader.calls.length).toBe(1 + AI_EGRESS_MAX_RETRIES);
  });

  it('a caller that owns its retry loop gets exactly one request ({ retries: 0 })', async () => {
    const { egress } = egressWithGrants([CLIENT]);
    noSleep(egress);
    const t = transport({ first: '500' });
    const handle = createAnthropicClient('test-key-not-a-secret', { fetch: t.fetchImpl });
    await expect(
      egress.anthropicMessagesCreate(handle, SUBJECT, 'coach_ai.insight', PARAMS, undefined, {
        retries: 0,
      }),
    ).rejects.toBeInstanceOf(Anthropic.InternalServerError);
    expect(t.bodies).toHaveLength(1);
  });

  it('a non-transient error (400) is not retried', async () => {
    const { egress } = egressWithGrants([CLIENT]);
    noSleep(egress);
    const bodies: string[] = [];
    const bad = (async () => {
      bodies.push('x');
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;
    const handle = createAnthropicClient('test-key-not-a-secret', { fetch: bad });
    await expect(
      egress.anthropicMessagesCreate(handle, SUBJECT, 'roman.chat', PARAMS),
    ).rejects.toBeInstanceOf(Anthropic.BadRequestError);
    expect(bodies).toHaveLength(1);
  });

  it('Perplexity (no-client-data exemption): SDK retries are off too; the gate retries once', async () => {
    const { egress } = egressWithGrants([]);
    noSleep(egress);
    const t = transport({ first: '500', perplexity: true });
    const handle = createPerplexityClient('test-key-not-a-secret', { fetch: t.fetchImpl });
    const out = await egress.perplexityChatCreate(
      handle,
      noClientDataSubject('fixed_template'),
      'first_win',
      {
        model: 'sonar',
        messages: [{ role: 'user', content: 'fixed' }],
      },
    );
    expect(out.choices[0].message.content).toBe('ok');
    expect(t.bodies).toHaveLength(2);
  });

  it('an injected Perplexity client built with SDK retries still sends once per attempt', async () => {
    const { egress } = egressWithGrants([]);
    noSleep(egress);
    const bodies: string[] = [];
    const always500 = (async () => {
      bodies.push('x');
      return failure('500');
    }) as typeof fetch;
    const retrying = new OpenAI({
      apiKey: 'test-key-not-a-secret',
      baseURL: 'http://127.0.0.1:9',
      maxRetries: 5,
      fetch: always500,
    });
    await expect(
      egress.perplexityChatCreate(
        PerplexityHandle.bind(retrying),
        noClientDataSubject('fixed_template'),
        'first_win',
        {
          model: 'sonar',
          messages: [{ role: 'user', content: 'fixed' }],
        },
      ),
    ).rejects.toBeInstanceOf(OpenAI.InternalServerError);
    expect(bodies).toHaveLength(1 + AI_EGRESS_MAX_RETRIES);
  });
});

describe('isRetryableProviderError', () => {
  it('follows the SDK rule: connection, 408, 409, 429, 5xx; honours x-should-retry; never a refusal', () => {
    expect(isRetryableProviderError({ status: 500 })).toBe(true);
    expect(isRetryableProviderError({ status: 529 })).toBe(true);
    expect(isRetryableProviderError({ status: 429 })).toBe(true);
    expect(isRetryableProviderError({ status: 408 })).toBe(true);
    expect(isRetryableProviderError({ status: 409 })).toBe(true);
    expect(isRetryableProviderError({ status: 400 })).toBe(false);
    expect(isRetryableProviderError({ status: 401 })).toBe(false);
    expect(isRetryableProviderError(new Error('boom'))).toBe(false);
    expect(isRetryableProviderError(new Anthropic.APIConnectionError({ message: 'down' }))).toBe(
      true,
    );
    expect(isRetryableProviderError(new OpenAI.APIConnectionError({ message: 'down' }))).toBe(true);
    expect(isRetryableProviderError(new Anthropic.APIUserAbortError())).toBe(false);
    expect(
      isRetryableProviderError({
        status: 500,
        headers: new Headers({ 'x-should-retry': 'false' }),
      }),
    ).toBe(false);
    expect(
      isRetryableProviderError({ status: 400, headers: new Headers({ 'x-should-retry': 'true' }) }),
    ).toBe(true);
    expect(isRetryableProviderError(new AiConsentRequiredException('client'))).toBe(false);
  });
});
