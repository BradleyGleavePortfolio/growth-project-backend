// Coach AI v1 — AnthropicAdapter tests.
//
// Mocks the SDK module so we never make real network calls. Covers:
//   1. happy-path complete() returns text + token usage + cost cents.
//   2. 429-then-success: retries with backoff.
//   3. malformed-JSON repair flow in completeStructured.
//   4. third-retry-failure bubbles up to caller.

const messagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  const ctor = jest.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  }));
  return { __esModule: true, default: ctor };
});

import { ConfigService } from '@nestjs/config';
import { AnthropicAdapter, ANTHROPIC_CLIENT_TOKEN } from '../../src/ai/adapters/anthropic.adapter';

// Cut the retry-backoff delay so the 429 test stays under the jest timeout.
jest.useFakeTimers({ advanceTimers: true });

function buildAdapter() {
  const config = { get: jest.fn().mockReturnValue('test-key') } as unknown as ConfigService;
  const aiCalls: any[] = [];
  const prisma = {
    aICallLog: {
      create: jest.fn(async ({ data }: any) => {
        aiCalls.push(data);
        return data;
      }),
    },
  } as any;
  const adapter = new AnthropicAdapter(config, prisma);
  return { adapter, prisma, aiCalls };
}

describe('AnthropicAdapter.complete', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
  });

  it('returns text + tokens + cost on success and writes AICallLog', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'hello world' }],
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-4-6',
    });
    const { adapter, aiCalls } = buildAdapter();
    const result = await adapter.complete(
      { system: 'system', user: 'user' },
      { capability: 'workout_program', coachId: 'c1', clientId: 'u1' },
    );
    expect(result.text).toBe('hello world');
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(50);
    expect(result.modelUsed).toBe('claude-sonnet-4-6');
    // cost: 100/1e6 * 3 + 50/1e6 * 15 = 0.0003 + 0.00075 = 0.00105$ => 0 cents (rounded)
    // confirm log row was written
    expect(aiCalls.length).toBe(1);
    expect(aiCalls[0]).toMatchObject({
      success: true,
      tokensIn: 100,
      tokensOut: 50,
      capability: 'workout_program',
      coachId: 'c1',
      clientId: 'u1',
    });
  });

  it('retries on 429 then succeeds', async () => {
    const err429: any = new Error('rate limited');
    err429.status = 429;
    messagesCreate
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'after retry' }],
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
      });
    const { adapter } = buildAdapter();
    const result = await adapter.complete({ system: 's', user: 'u' }, { capability: 'meal_plan' });
    expect(result.text).toBe('after retry');
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('bubbles after 3 retries on persistent 503', async () => {
    const err: any = new Error('overloaded');
    err.status = 503;
    messagesCreate.mockRejectedValue(err);
    const { adapter, aiCalls } = buildAdapter();
    await expect(
      adapter.complete({ system: 's', user: 'u' }, { capability: 'insight' }),
    ).rejects.toThrow('overloaded');
    // 4 attempts (initial + 3 retries)
    expect(messagesCreate).toHaveBeenCalledTimes(4);
    // failure log row recorded
    expect(aiCalls[aiCalls.length - 1].success).toBe(false);
  });
});

describe('AnthropicAdapter.completeStructured', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
  });

  it('parses valid JSON on the first try', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok": true, "count": 3}' }],
      usage: { input_tokens: 10, output_tokens: 8 },
      model: 'claude-sonnet-4-6',
    });
    const { adapter } = buildAdapter();
    const validator = (raw: unknown) => raw as { ok: boolean; count: number };
    const result = await adapter.completeStructured(
      { system: 's', user: 'u' },
      validator,
      { capability: 'workout_program' },
    );
    expect(result.data).toEqual({ ok: true, count: 3 });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it('repairs malformed JSON on a second pass', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        // First reply: invalid JSON
        content: [{ type: 'text', text: 'not json at all' }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok": true}' }],
        usage: { input_tokens: 12, output_tokens: 6 },
        model: 'claude-sonnet-4-6',
      });
    const { adapter } = buildAdapter();
    const validator = (raw: unknown) => raw as { ok: boolean };
    const result = await adapter.completeStructured(
      { system: 's', user: 'u' },
      validator,
      { capability: 'workout_program' },
    );
    expect(result.data).toEqual({ ok: true });
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });

  it('cost computation: 1M input + 1M output ≈ $18.00 = 1800 cents', () => {
    expect(AnthropicAdapter.computeCostCents(1_000_000, 1_000_000)).toBe(1800);
    expect(AnthropicAdapter.computeCostCents(0, 0)).toBe(0);
  });
});

describe('AnthropicAdapter constructor', () => {
  it('uses an injected client when provided', async () => {
    const customCreate = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'via-injected' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
    });
    const fakeClient = { messages: { create: customCreate } } as any;
    const config = { get: jest.fn().mockReturnValue('test-key') } as unknown as ConfigService;
    const prisma = { aICallLog: { create: jest.fn() } } as any;
    const adapter = new AnthropicAdapter(config, prisma, fakeClient);
    const result = await adapter.complete({ system: 's', user: 'u' }, { capability: 'meal_plan' });
    expect(result.text).toBe('via-injected');
    expect(customCreate).toHaveBeenCalledTimes(1);
  });
});

// Defensive: silence Jest "unused" complaint about ANTHROPIC_CLIENT_TOKEN import.
void ANTHROPIC_CLIENT_TOKEN;
