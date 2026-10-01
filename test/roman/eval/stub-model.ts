// test/roman/eval/stub-model.ts
//
// Deterministic fake Anthropic streaming client for the CI harness (plan
// §7.3). It returns a canned reply per turn, counts calls and records every
// request body so tests can assert on the system prompt. It never judges
// model quality — the live runner does that.

import type Anthropic from '@anthropic-ai/sdk';

export interface StubCall {
  body: Record<string, unknown>;
  /** Static system block (string) or the first text block. */
  staticSystem: string;
  /** The `<client_data>` block when the system is an array, else null. */
  clientData: string | null;
}

export interface StubModel {
  client: Anthropic;
  calls: StubCall[];
  /** Queue the reply for the NEXT model call (FIFO). Falls back to `defaultReply`. */
  enqueue(reply: string | string[]): void;
  reset(): void;
}

export function makeStubModel(defaultReply = 'You have 670 kcal left today.'): StubModel {
  const calls: StubCall[] = [];
  const queue: Array<string | string[]> = [];
  const stream = jest.fn((body: Record<string, unknown>) => {
    const system = body.system;
    let staticSystem = '';
    let clientData: string | null = null;
    if (typeof system === 'string') staticSystem = system;
    else if (Array.isArray(system)) {
      const blocks = system as Array<{ type: string; text: string }>;
      staticSystem = blocks[0]?.text ?? '';
      clientData = blocks[1]?.text ?? null;
    }
    calls.push({ body, staticSystem, clientData });
    const next = queue.shift() ?? defaultReply;
    const deltas = Array.isArray(next) ? next : [next];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { usage: { input_tokens: 42 } } };
        for (const d of deltas)
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: d } };
        yield { type: 'message_delta', usage: { output_tokens: 12 } };
      },
    };
  });
  const clientDouble = { messages: { stream } };
  return {
    // @ts-expect-error partial structural mock of the Anthropic SDK client — only messages.stream is stubbed.
    client: clientDouble,
    calls,
    enqueue: (r) => void queue.push(r),
    reset: () => {
      calls.length = 0;
      queue.length = 0;
    },
  };
}
