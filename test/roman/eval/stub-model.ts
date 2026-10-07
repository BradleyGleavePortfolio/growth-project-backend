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

/** R11-T3: one scripted `messages.create` answer: final text, or tool_use blocks. */
export type StubStep = string | { tool_use: Array<{ name: string; input: unknown }> };

export interface StubModel {
  client: Anthropic;
  calls: StubCall[];
  /** Queue the reply for the NEXT model call (FIFO). Falls back to `defaultReply`. */
  enqueue(reply: string | string[]): void;
  /** R11-T3: queue `messages.create` answers (tools turns), FIFO; then `defaultReply`. */
  script(...steps: StubStep[]): void;
  reset(): void;
}

export function makeStubModel(defaultReply = 'You have 670 kcal left today.'): StubModel {
  const calls: StubCall[] = [];
  const queue: Array<string | string[]> = [];
  const steps: StubStep[] = [];
  const record = (body: Record<string, unknown>) => {
    const system = body.system;
    let staticSystem = '';
    let clientData: string | null = null;
    if (typeof system === 'string') {
      // OR-113-2: one system string; the <client_data> block is cut out so a
      // spec can read the static contract and the client data separately.
      const m = system.match(/<client_data[\s\S]*?<\/client_data>/);
      clientData = m ? m[0] : null;
      staticSystem = m ? system.replace(m[0], '') : system;
    }
    else if (Array.isArray(system)) {
      const blocks = system as Array<{ type: string; text: string }>;
      staticSystem = blocks[0]?.text ?? '';
      clientData = blocks[1]?.text ?? null;
    }
    calls.push({ body, staticSystem, clientData });
  };
  const stream = jest.fn((body: Record<string, unknown>) => {
    record(body);
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
  const create = jest.fn(async (body: Record<string, unknown>) => {
    record(structuredClone(body)); // the tool loop appends to `messages` after the call
    const step = steps.shift() ?? defaultReply;
    const n = calls.length;
    const content =
      typeof step === 'string'
        ? [{ type: 'text', text: step }]
        : step.tool_use.map((u, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, ...u }));
    const stop_reason = typeof step === 'string' ? 'end_turn' : 'tool_use';
    const usage = { input_tokens: 42, output_tokens: 12 };
    return { id: `msg_${n}`, type: 'message', role: 'assistant', content, stop_reason, usage };
  });
  const clientDouble = { messages: { stream, create } };
  return {
    // @ts-expect-error partial structural mock of the Anthropic SDK client — only messages.stream and messages.create are stubbed.
    client: clientDouble,
    calls,
    enqueue: (r) => void queue.push(r),
    script: (...s) => void steps.push(...s),
    reset: () => {
      calls.length = 0;
      queue.length = 0;
      steps.length = 0;
    },
  };
}
