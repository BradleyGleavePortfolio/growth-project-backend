// test/roman/r11-tool-loop-deadline.spec.ts
//
// R11-FIX U1: a tools turn ends before the app gives up (mobile romanApi.ts
// aborts the request after 60 s). The loop runs on fake timers and a fake
// clock; the provider and the toolbox are stubs. No network, no DB.

import type Anthropic from '@anthropic-ai/sdk';
import { RomanToolLoop, type RomanToolLoopSend } from '../../src/roman/tools/roman-tool-loop';
import { ROMAN_TOOL_LIMITS, type RomanToolbox } from '../../src/roman/tools/roman-tool.types';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const APP_ABORT_MS = 60_000;
const L = ROMAN_TOOL_LIMITS;
const use = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'food_day',
  input: { date: '2026-09-29' },
});
const msg = (content: unknown[], stop_reason: string) =>
  fakeOf<Anthropic.Message>({
    content,
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
const toolTurn = msg([use('t')], 'tool_use');
const answer = msg([{ type: 'text', text: 'Steady week.' }], 'end_turn');

/** A tool that never answers (always cut at its timeout). */
const hangingToolbox: RomanToolbox = {
  definitions: () => [
    { name: 'food_day', description: 'd', input_schema: { type: 'object', properties: {} } },
  ],
  run: () => new Promise(() => undefined),
};

/** Call i answers after delays[i] ms (null: never; only the abort ends it). */
function provider(delays: Array<number | null>, replies: Anthropic.Message[]) {
  const choices: unknown[] = [];
  const send: RomanToolLoopSend = (call, _messages, signal) => {
    const i = choices.length;
    choices.push(call.tool_choice);
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      const d = delays[i];
      if (d !== null) setTimeout(() => resolve(replies[i]), d);
    });
  };
  return { send, choices };
}

async function runLoop(send: RomanToolLoopSend) {
  const loop = new RomanToolLoop({
    toolbox: hangingToolbox,
    caller: { id: 'p1', role: 'student' },
    send,
    roundInputBound: 1000,
  });
  const started = Date.now();
  let endedAt = Infinity;
  let outcome: { text?: string; error?: string } = {};
  const p = loop.run([{ role: 'user', content: 'How was my week?' }]).then(
    (text) => ((endedAt = Date.now()), (outcome = { text })),
    (e: Error) => ((endedAt = Date.now()), (outcome = { error: e.message })),
  );
  await jest.advanceTimersByTimeAsync(APP_ABORT_MS + 30_000);
  void p;
  return { loop, outcome, elapsed: endedAt - started };
}

beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') }));
afterEach(() => jest.useRealTimers());

describe('R11-FIX U1 tools turn deadline', () => {
  it('worst case that still answers: 3 rounds up to the wall, a slow last round, a slow final call', async () => {
    expect([L.turn_wall_ms, L.turn_deadline_ms]).toEqual([15_000, 50_000]);
    // Round 1 answers at 5 s, round 2 at 11.99 s (+3 s tools each), round 3
    // starts at 14.99 s (< wall) and answers at 29.99 s, tools to 32.99 s; the
    // final call answers at 49.98 s: 10 s before the app's 60 s abort.
    const { send, choices } = provider(
      [5_000, 3_990, 15_000, 16_990],
      [toolTurn, toolTurn, toolTurn, answer],
    );
    const r = await runLoop(send);
    expect(r.outcome).toEqual({ text: 'Steady week.' });
    expect(choices).toEqual([undefined, undefined, undefined, { type: 'none' }]);
    expect(r.elapsed).toBe(49_980);
    expect(APP_ABORT_MS - r.elapsed).toBeGreaterThanOrEqual(10_000);
  });

  it('a provider that never answers, or a slow last round: the loop ends at the deadline', async () => {
    const never = await runLoop(provider([null], [toolTurn]).send);
    // Round 2 starts at 14.99 s and answers at 48.99 s; its tools are cut at
    // 50 s and the final call is never sent.
    const slow = provider([11_990, 34_000, null], [toolTurn, toolTurn, answer]);
    const late = await runLoop(slow.send);
    for (const r of [never, late]) {
      expect(r.outcome).toEqual({ error: 'roman_tool_turn_deadline' });
      expect(r.elapsed).toBe(L.turn_deadline_ms);
    }
    expect(never.loop.settled().kind).toBe('partial');
    expect(slow.choices).toHaveLength(2);
  });

  it('no new tool round after the 15 s wall', async () => {
    const { send, choices } = provider([15_000, 1_000], [toolTurn, answer]);
    expect((await runLoop(send)).outcome).toEqual({ text: 'Steady week.' });
    expect(choices).toEqual([undefined, { type: 'none' }]);
  });
});
