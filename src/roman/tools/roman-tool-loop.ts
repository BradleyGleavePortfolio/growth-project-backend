/**
 * Roman v1.1 R11-T2B: the budgeted tool loop of one grounded client turn
 * (FEATURE_ROMAN_TOOLS on and a toolbox provided). Server-side only: the
 * client still gets one delta and one done frame.
 *
 * At most `max_rounds` calls offer the tools. Every tool_use block runs for
 * the session caller (never an id from the model), at most
 * `max_calls_per_turn` per turn (over the limit: an is_error result), each
 * within `tool_timeout_ms`, each result clamped to `max_result_chars`. After
 * `max_rounds` tool rounds or `turn_wall_ms`, one final call that may not use
 * a tool (tool_choice none; the definitions stay because the history holds
 * tool_use blocks). Usage is summed; a call that failed after dispatch (not a
 * consent refusal or a provider HTTP error) counts its bound, the safe side.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { isAiEgressRefusal } from '../../ai-egress/ai-consent-required.exception';
import type { PostCheckContext, PostCheckMacroFacts } from '../guardrails/roman-post-check';
import { ROMAN_MAX_OUTPUT_TOKENS } from '../roman.constants';
import {
  ROMAN_TOOL_LIMITS,
  type RomanToolbox,
  type RomanToolCaller,
  type RomanToolName,
} from './roman-tool.types';
import { emptyGrams, ROMAN_TOOL_GRAM_KEYS, toolFactsOf } from './roman-tool-facts';
import type { RomanToolGramLists } from './roman-tool-facts';

const CLOSED_TOOL_NAMES: readonly RomanToolName[] = [
  'read_history',
  'exercise_history',
  'food_day',
  'personal_baselines',
];

/** What one provider call adds to the request (the rest is the turn's own body). */
export interface RomanToolLoopCall {
  readonly tools: Anthropic.Tool[];
  readonly tool_choice?: { readonly type: 'none' };
}

export type RomanToolLoopSend = (
  call: RomanToolLoopCall,
  messages: Anthropic.MessageParam[],
  signal?: AbortSignal,
) => Promise<Anthropic.Message>;

export interface RomanToolLoopDeps {
  readonly toolbox: RomanToolbox;
  readonly caller: RomanToolCaller;
  readonly send: RomanToolLoopSend;
  /** Input-token bound of one call (payload bound + every tool result). */
  readonly roundInputBound: number;
  readonly clock?: () => number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('roman_tool_timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Same rule as roman.service: the provider answered with an HTTP error (nothing generated). */
function isProviderHttpError(err: unknown): boolean {
  const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
}

/** The assistant content sent back as given (text, thinking and tool_use blocks). */
function asParams(content: readonly Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
  return content.flatMap((b): Anthropic.ContentBlockParam[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    if (b.type === 'thinking') {
      return [{ type: 'thinking', thinking: b.thinking, signature: b.signature }];
    }
    if (b.type === 'redacted_thinking') return [{ type: 'redacted_thinking', data: b.data }];
    if (b.type === 'tool_use') {
      return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
    }
    return [];
  });
}

const textOf = (m: Anthropic.Message): string =>
  m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

export class RomanToolLoop {
  input = 0;
  output = 0;
  rounds = 0;
  calls = 0;
  errors = 0;
  private unknownUsage = false;
  private readonly names = new Set<RomanToolName>();
  readonly facts = {
    intake_past_kcal: [] as number[],
    burned_past_kcal: [] as number[],
    intake_past_g: emptyGrams(),
    average_past_g: emptyGrams(),
  };
  private readonly clock: () => number;

  constructor(private readonly deps: RomanToolLoopDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** Run the loop over the turn's messages; returns the final reply text. */
  async run(base: readonly Anthropic.MessageParam[], signal?: AbortSignal): Promise<string> {
    const L = ROMAN_TOOL_LIMITS;
    const started = this.clock();
    const tools: Anthropic.Tool[] = this.deps.toolbox.definitions().map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: {
        type: 'object',
        properties: d.input_schema.properties,
        ...(d.input_schema.required ? { required: [...d.input_schema.required] } : {}),
      },
    }));
    const messages: Anthropic.MessageParam[] = [...base];
    for (;;) {
      if (signal?.aborted) throw new Error('roman_tool_loop_aborted');
      const last = this.rounds >= L.max_rounds || this.clock() - started >= L.turn_wall_ms;
      const call: RomanToolLoopCall = last ? { tools, tool_choice: { type: 'none' } } : { tools };
      const res = await this.call(call, messages, signal);
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (last || res.stop_reason !== 'tool_use' || uses.length === 0) return textOf(res);
      this.rounds += 1;
      const now = new Date(this.clock());
      const results = await Promise.all(uses.map((u) => this.runTool(u, now)));
      messages.push({ role: 'assistant', content: asParams(res.content) });
      messages.push({ role: 'user', content: results });
    }
  }

  /** Summed usage for the ledger and the pool debit. */
  settled(): { input: number; output: number; kind: 'none_sent' | 'final' | 'partial' } {
    const spent = this.input + this.output > 0;
    const kind = this.unknownUsage ? 'partial' : spent ? 'final' : 'none_sent';
    return { input: this.input, output: this.output, kind };
  }

  /** Content-free ledger fields (closed tool names only). */
  ledger(): Record<string, boolean | number | string[]> {
    return {
      tools: true,
      tool_rounds: this.rounds,
      tool_calls: this.calls,
      tool_names: CLOSED_TOOL_NAMES.filter((n) => this.names.has(n)),
      tool_errors: this.errors,
    };
  }

  private async call(
    extra: RomanToolLoopCall,
    messages: Anthropic.MessageParam[],
    signal?: AbortSignal,
  ): Promise<Anthropic.Message> {
    try {
      const res = await this.deps.send(extra, messages, signal);
      this.input += res.usage?.input_tokens ?? 0;
      this.output += res.usage?.output_tokens ?? 0;
      return res;
    } catch (err) {
      if (!isAiEgressRefusal(err) && !isProviderHttpError(err)) {
        this.input += this.deps.roundInputBound;
        this.output += ROMAN_MAX_OUTPUT_TOKENS;
        this.unknownUsage = true;
      }
      throw err;
    }
  }

  private async runTool(
    u: Anthropic.ToolUseBlock,
    now: Date,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const L = ROMAN_TOOL_LIMITS;
    this.calls += 1;
    const known = CLOSED_TOOL_NAMES.find((n) => n === u.name);
    if (known) this.names.add(known);
    const fail = (content: string): Anthropic.ToolResultBlockParam => {
      this.errors += 1;
      return { type: 'tool_result', tool_use_id: u.id, content, is_error: true };
    };
    if (this.calls > L.max_calls_per_turn) {
      return fail('Tool call limit for this turn reached. Answer with what you already have.');
    }
    try {
      const r = await withTimeout(
        this.deps.toolbox.run(this.deps.caller, u.name, u.input, { now }),
        L.tool_timeout_ms,
      );
      const content = r.content.slice(0, L.max_result_chars);
      if (!r.ok) return fail(content || 'This data is unavailable right now.');
      for (const f of toolFactsOf(u.name, { ...r, content })) {
        this.facts.intake_past_kcal.push(...(f.intake_past_kcal ?? []));
        this.facts.burned_past_kcal.push(...(f.burned_past_kcal ?? []));
        for (const k of ROMAN_TOOL_GRAM_KEYS) {
          this.facts.intake_past_g[k].push(...(f.intake_past_g?.[k] ?? []));
          this.facts.average_past_g[k].push(...(f.average_past_g?.[k] ?? []));
        }
      }
      return { type: 'tool_result', tool_use_id: u.id, content };
    } catch {
      return fail('This data is unavailable right now.');
    }
  }
}

const joinGrams = (a: PostCheckMacroFacts | undefined, b: RomanToolGramLists): PostCheckMacroFacts => ({
  protein_g: [...(a?.protein_g ?? []), ...b.protein_g],
  carbs_g: [...(a?.carbs_g ?? []), ...b.carbs_g],
  fat_g: [...(a?.fat_g ?? []), ...b.fat_g],
});

/** Past-day kcal and gram numbers a tool returned may be quoted (post-check facts). */
export function withToolFacts(ctx: PostCheckContext, loop: RomanToolLoop | null): PostCheckContext {
  if (!loop) return ctx;
  const { intake_past_kcal, burned_past_kcal, intake_past_g, average_past_g } = loop.facts;
  const grams = [intake_past_g, average_past_g].some((g) => ROMAN_TOOL_GRAM_KEYS.some((k) => g[k].length));
  if (intake_past_kcal.length === 0 && burned_past_kcal.length === 0 && !grams) return ctx;
  const f = ctx.kcal_facts ?? {};
  return {
    ...ctx,
    kcal_facts: {
      ...f,
      intake_past_days: [...(f.intake_past_days ?? []), ...intake_past_kcal],
      burned_past: [...(f.burned_past ?? []), ...burned_past_kcal],
    },
    macro_past: joinGrams(ctx.macro_past, intake_past_g),
    macro_average: joinGrams(ctx.macro_average, average_past_g),
  };
}
