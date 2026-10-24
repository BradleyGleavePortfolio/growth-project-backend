/**
 * PHOTO-CHECK-BE: the moderation send (AiEgressService.openAiModerationCreate
 * over createOpenAiModerationClient), through the real OpenAI SDK on an
 * in-memory transport. One request, no retry, a hard timeout, the host and
 * account pinned, no consent read, and a forged handle never sends.
 */
import { AiEgressPolicyException } from '../../src/ai-egress/ai-consent-required.exception';
import { OpenAiModerationHandle } from '../../src/ai-egress/ai-egress.service';
import { createOpenAiModerationClient } from '../../src/ai-egress/provider-clients';
import { egressWithGrants } from './ai-egress.fakes';

const PARAMS = {
  model: 'omni-moderation-latest',
  input: [
    { type: 'text' as const, text: 'after the long run' },
    { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,/9j/4A==' } },
  ],
};
const ANSWER = { id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged: false, categories: {}, category_scores: {} }] };

function transport(reply: (n: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = async (url: unknown, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return reply(calls.length);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_ORG_ID;
  delete process.env.OPENAI_PROJECT_ID;
});

describe('AiEgressService.openAiModerationCreate (PHOTO-CHECK-BE)', () => {
  it('sends ONE POST to api.openai.com/v1/moderations with the key, and returns the answer', async () => {
    const { egress, reader } = egressWithGrants();
    const t = transport(() => json(200, ANSWER));
    const out = await egress.openAiModerationCreate(createOpenAiModerationClient('k-test', { fetch: t.fetchImpl }), PARAMS, 5_000);
    expect(out.results[0].flagged).toBe(false);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/moderations', method: 'POST', body: PARAMS });
    expect(t.calls[0].headers.get('authorization')).toBe('Bearer k-test');
    // A safety screen, not AI help with the member's data: no consent read at all.
    expect(reader.calls).toEqual([]);
  });

  it('keeps the host and account pinned whatever the OPENAI_* env says', async () => {
    process.env.OPENAI_BASE_URL = 'https://elsewhere.example/v1';
    process.env.OPENAI_ORG_ID = 'org-other';
    process.env.OPENAI_PROJECT_ID = 'proj-other';
    const t = transport(() => json(200, ANSWER));
    await egressWithGrants().egress.openAiModerationCreate(createOpenAiModerationClient('k', { fetch: t.fetchImpl }), PARAMS, 5_000);
    expect(t.calls[0].url).toBe('https://api.openai.com/v1/moderations');
    expect(t.calls[0].headers.has('openai-organization')).toBe(false);
    expect(t.calls[0].headers.has('openai-project')).toBe(false);
  });

  it.each([429, 500, 503])('throws on a %i after exactly one request (no SDK retry)', async (status) => {
    const t = transport(() => json(status, { error: { message: 'busy' } }));
    const handle = createOpenAiModerationClient('k', { fetch: t.fetchImpl });
    await expect(egressWithGrants().egress.openAiModerationCreate(handle, PARAMS, 5_000)).rejects.toThrow();
    expect(t.calls).toHaveLength(1);
  });

  it('gives up at the timeout when OpenAI never answers', async () => {
    let calls = 0;
    const never = async (_url: unknown, init: RequestInit = {}): Promise<Response> => {
      calls += 1;
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
      );
    };
    const started = Date.now();
    await expect(
      egressWithGrants().egress.openAiModerationCreate(createOpenAiModerationClient('k', { fetch: never as typeof fetch }), PARAMS, 50),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });

  // FR-1152 (Sol B2): the headers arrive in time, then the body never ends.
  const stalledBody = (status: number) =>
    new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"id":"modr-1",')) }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  it.each([200, 500])('gives up at the deadline when a %i answer body stalls after its headers', async (status) => {
    const t = transport(() => stalledBody(status));
    const started = Date.now();
    await expect(
      egressWithGrants().egress.openAiModerationCreate(createOpenAiModerationClient('k', { fetch: t.fetchImpl }), PARAMS, 50),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.calls).toHaveLength(1); // still never a retry
  });

  it('the deadline aborts the request it gave up on', async () => {
    let signal: AbortSignal | undefined;
    const t = transport(() => stalledBody(200));
    const spy = async (url: unknown, init: RequestInit = {}): Promise<Response> => {
      signal = init.signal ?? undefined;
      return t.fetchImpl(String(url), init);
    };
    await expect(
      egressWithGrants().egress.openAiModerationCreate(createOpenAiModerationClient('k', { fetch: spy as typeof fetch }), PARAMS, 50),
    ).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });

  it('refuses a forged handle and sends nothing', async () => {
    const forged = Object.create(OpenAiModerationHandle.prototype) as OpenAiModerationHandle;
    await expect(egressWithGrants().egress.openAiModerationCreate(forged, PARAMS, 5_000)).rejects.toBeInstanceOf(
      AiEgressPolicyException,
    );
  });
});
