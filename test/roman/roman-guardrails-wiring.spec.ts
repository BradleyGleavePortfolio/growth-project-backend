// test/roman/roman-guardrails-wiring.spec.ts
//
// R4 — prompt assembly and the live-turn wiring of the guardrails: router
// short-circuit, buffered emit, post-check, audit (split from
// roman-guardrails.spec.ts with the #651 stacked split). No network, no DB.

import 'reflect-metadata';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import { RomanService } from '../../src/roman/roman.service';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { buildRomanSystemPrompt, ROMAN_VOICE_CONTRACT } from '../../src/roman/roman.prompts';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import {
  PROMPT_VERSION,
  ROMAN_GUARDRAIL_CONTRACT,
  ROMAN_CONTRACT_ANCHORS,
} from '../../src/roman/guardrails/roman-guardrail.contract';
import {
  classifySafety,
  routerHintFor,
  ROMAN_ROUTER_HINTS,
  ROMAN_PHYSICIAN_LINE_INJURY,
  ROMAN_PHYSICIAN_LINE_MEDICAL,
  ROMAN_SAFETY_ROUTER_MODEL_ID,
  ROMAN_SAFETY_TEMPLATES,
  type SafetyClass,
} from '../../src/roman/guardrails/safety-router';
import {
  postCheckRomanReply,
  ROMAN_POST_CHECK_TEMPLATES,
  type PostCheckContext,
} from '../../src/roman/guardrails/roman-post-check';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  process.env[FLAG] = 'true';
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

// ─── layer 2: prompt assembly ────────────────────────────────────────────────

describe('R4 prompt assembly', () => {
  const voice = { quipsInSession: 0, exclamationUsed: false, lastTurnHadQuip: false };

  it('the client system prompt carries the voice contract, every contract anchor and PROMPT_VERSION; client_data is NOT in the static block', () => {
    const sys = buildRomanSystemPrompt({ surface: 'client', voice });
    expect(sys).toContain(ROMAN_VOICE_CONTRACT);
    expect(sys).toContain(ROMAN_GUARDRAIL_CONTRACT);
    for (const a of ROMAN_CONTRACT_ANCHORS) expect(sys).toContain(a);
    expect(sys).toContain(PROMPT_VERSION);
    expect(sys).not.toContain('<client_data');
  });

  it('the static block is byte-identical across users and sessions with the same voice state (cache-safe, PII-free)', () => {
    const a = buildRomanSystemPrompt({ surface: 'client', voice });
    const b = buildRomanSystemPrompt({ surface: 'client', voice });
    expect(a).toBe(b);
    expect(a).not.toMatch(/Maya|user-|@example\.com/);
  });

  it('the coach surface gets the voice contract but not the client reply contract', () => {
    const sys = buildRomanSystemPrompt({ surface: 'coach', voice });
    expect(sys).toContain(ROMAN_VOICE_CONTRACT);
    expect(sys).not.toContain(ROMAN_GUARDRAIL_CONTRACT);
  });

  it('a router hint lands in SESSION STATE and only when provided', () => {
    const plain = buildRomanSystemPrompt({ surface: 'client', voice });
    const hinted = buildRomanSystemPrompt({
      surface: 'client',
      voice,
      routerHint: ROMAN_ROUTER_HINTS.injury_pain,
    });
    expect(plain).not.toContain('ROUTER HINT');
    expect(hinted).toContain('ROUTER HINT (injury_pain)');
    expect(hinted.indexOf('# SESSION STATE')).toBeLessThan(hinted.indexOf('ROUTER HINT'));
  });

  it('the contract is static text with no template holes', () => {
    expect(ROMAN_GUARDRAIL_CONTRACT).not.toMatch(/\$\{|\{\{|<client_data/);
  });
});

// ─── wiring: G17 / G18 zero model calls, buffered emit, audit ────────────────

function makeDb(userMessage: string) {
  const messages: Array<Record<string, unknown>> = [];
  let seq = 0;
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `msg_${++seq}`, created_at: new Date(), ...data };
      messages.push(row);
      return row;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = messages.find((m) => m.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    ),
    findMany: jest.fn(async () => [...messages].reverse()),
    findFirst: jest.fn(async () => ({ content: userMessage })),
    count: jest.fn(async () => 0),
  };
  const romanSession = {
    update: jest.fn(async () => ({})),
    // appendMessage bumps the live session with updateMany (main's contract).
    updateMany: jest.fn(async () => ({ count: 1 })),
    findFirst: jest.fn(async () => null),
  };
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ledger_1', ...data })),
    aggregate: jest.fn(async () => ({ _sum: { prompt_token_estimate: 0, response_token_estimate: 0 } })),
    update: jest.fn(async () => ({})),
  };
  const prisma = {
    romanMessage,
    romanSession,
    aiRequestAudit,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ romanMessage, romanSession }),
    ),
  };
  return { prisma, messages };
}
function makeAnthropic(deltas: string[]) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    messages: {
      stream: jest.fn((body: Record<string, unknown>) => {
        calls.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
            for (const d of deltas)
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: d } };
            yield { type: 'message_delta', usage: { output_tokens: 6 } };
          },
        };
      }),
    },
  };
}
const SESSION = {
  id: 'sess_1',
  user_id: 'user-A',
  surface: 'client' as const,
  day_key: '2026-10-01',
  message_count: 1,
  started_at: new Date(),
  last_activity_at: new Date(),
  quips_in_session: 0,
  exclamation_used: true,
  subject_context_json: null,
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};
const CALLER = { id: 'user-A', role: 'student' };
async function drain(gen: AsyncGenerator<unknown>) {
  const out: Array<{ type: string; text?: string; messageId?: string; interrupted?: boolean }> = [];
  for await (const c of gen) out.push(c as { type: string; text?: string });
  return out;
}

function romanWith(prisma: object, anthropic: object, audit?: object) {
  return new RomanService(
    fakeOf<PrismaService>(prisma),
    grantAllEgress(),
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
    null,
    audit ? fakeOf<AuditService>(audit) : null,
  );
}

describe('R4 wiring — router short-circuit, buffered emit, post-check, audit', () => {
  it('G17 emergency: fixed 911 reply, ZERO model calls, audit row, turn persisted with model_id safety-router', async () => {
    const { prisma, messages } = makeDb('I have chest pain right now');
    const anthropic = makeAnthropic(['never']);
    const audit = { write: jest.fn(async (_input: Record<string, unknown>) => undefined) };
    const svc = romanWith(prisma, anthropic, audit);
    const chunks = await drain(svc.streamAssistantTurn(CALLER, SESSION, {}));

    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(chunks.map((c) => c.type)).toEqual(['delta', 'done']);
    expect(chunks[0].text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
    expect(chunks[1].text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
    expect(chunks[1].interrupted).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'roman',
      content: ROMAN_SAFETY_TEMPLATES.emergency,
      model_id: ROMAN_SAFETY_ROUTER_MODEL_ID,
    });
    expect(audit.write).toHaveBeenCalledTimes(1);
    const row = audit.write.mock.calls[0][0];
    expect(row).toMatchObject({
      action: 'roman.safety_emergency',
      actorId: 'user-A',
      targetType: 'RomanSession',
      targetId: 'sess_1',
    });
    expect(JSON.stringify(row)).not.toContain('chest pain'); // never the message text
  });

  it('G18 self-harm: fixed 988 reply, ZERO model calls, audit row', async () => {
    const { prisma } = makeDb("I don't want to live anymore");
    const anthropic = makeAnthropic(['never']);
    const audit = { write: jest.fn(async (_input: Record<string, unknown>) => undefined) };
    const svc = romanWith(prisma, anthropic, audit);
    const chunks = await drain(svc.streamAssistantTurn(CALLER, SESSION, {}));
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
    expect(chunks[0].text).toContain('988');
    expect(audit.write.mock.calls[0][0]).toMatchObject({ action: 'roman.safety_self_harm' });
  });

  it('the explicit userMessage option is preferred over the DB lookup', async () => {
    const { prisma } = makeDb('what is my protein target');
    const anthropic = makeAnthropic(['x']);
    const svc = romanWith(prisma, anthropic);
    await drain(svc.streamAssistantTurn(CALLER, SESSION, { userMessage: 'I want to kill myself' }));
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });

  it('normal turn: the model stream is buffered into ONE delta + done (no unvalidated token reaches the client)', async () => {
    const { prisma } = makeDb('what is my protein target');
    const anthropic = makeAnthropic(['You ', 'have ', '53 g left.']);
    const svc = romanWith(prisma, anthropic);
    const chunks = await drain(svc.streamAssistantTurn(CALLER, SESSION, {}));
    expect(chunks.map((c) => c.type)).toEqual(['delta', 'done']);
    expect(chunks[0].text).toBe('You have 53 g left.');
    expect(chunks[1].messageId).toBeTruthy();
    expect(anthropic.calls[0].system as string).toContain(PROMPT_VERSION);
    expect(anthropic.calls[0].system as string).not.toContain('ROUTER HINT');
  });

  it('injury_pain turn: the router hint reaches the system prompt and the mandatory referral is enforced on the reply and in the DB', async () => {
    const { prisma, messages } = makeDb('my knee hurts when I squat');
    const anthropic = makeAnthropic(['Ease off squats for now and message your coach.']);
    const svc = romanWith(prisma, anthropic);
    const chunks = await drain(svc.streamAssistantTurn(CALLER, SESSION, {}));
    expect(anthropic.calls[0].system as string).toContain('ROUTER HINT (injury_pain)');
    expect(chunks[0].text!.endsWith(ROMAN_POST_CHECK_TEMPLATES.referral_injury)).toBe(true);
    const roman = messages.find((m) => m.role === 'roman')!;
    expect(roman.content).toBe(chunks[0].text);
    // main's appendMessage writes the post-checked text once (create); the
    // turn is never patched after the fact.
    expect(messages.filter((m) => m.role === 'roman')).toHaveLength(1);
    expect(prisma.romanMessage.update).not.toHaveBeenCalled();
  });

  it('a bad model reply is rewritten before any byte is emitted; the persisted turn equals what the client saw', async () => {
    const { prisma, messages } = makeDb('how do I lose faster');
    const anthropic = makeAnthropic(['Drop to 1,000 kcal a day and add SARMs!']);
    const svc = romanWith(prisma, anthropic);
    const chunks = await drain(svc.streamAssistantTurn(CALLER, SESSION, {}));
    expect(chunks[0].text).not.toContain('1,000');
    expect(chunks[0].text).not.toMatch(/SARMs/i);
    expect(chunks[0].text).toContain('1,500 kcal'); // no R3 context on this branch → fallback floor
    expect(messages.find((m) => m.role === 'roman')!.content).toBe(chunks[0].text);
    expect(chunks.every((c) => c.type !== 'delta' || !c.text!.includes('SARMs'))).toBe(true);
  });
});

