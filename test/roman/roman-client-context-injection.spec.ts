// test/roman/roman-client-context-injection.spec.ts
//
// R3 — injection of the RomanClientContext into live Roman turns (split from
// roman-client-context.spec.ts with the #651 stacked split)
// (PLAN_roman_intelligence §2.3–§2.6, §7.3 layer 1). In-memory personas from
// ./fixtures/roman-personas.ts; no network, no DB.

import 'reflect-metadata';
import {
  RomanClientContextService,
  localClock,
  ageYears,
  addDays,
  ROMAN_CONTEXT_MAX_QUERIES,
} from '../../src/roman/context/roman-client-context.service';
import {
  renderClientContext,
  ROMAN_CONTEXT_HARD_CAP_TOKENS,
  ROMAN_CLEARANCE_RECOMMENDED_INSTRUCTION,
  ROMAN_CLIENT_DATA_NOTICE,
} from '../../src/roman/context/roman-client-context.renderer';
import {
  romanContextInvalidate,
  _resetRomanContextListeners,
} from '../../src/roman/context/roman-context-invalidation';
import { RomanContextController } from '../../src/roman/context/roman-context.controller';
import { RomanService } from '../../src/roman/roman.service';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import type { RomanClientContext } from '../../src/roman/context/roman-client-context.types';
import type { AuthedRequest } from '../../src/auth/auth-request';
import {
  makePersonaDb,
  FakeSafetyIntakeSource,
  CANARIES,
  INTAKE_CANARIES,
  NOW,
  LOCAL_TODAY_PT,
  P1,
  P2,
  P3,
  P4,
} from './fixtures/roman-personas';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
  _resetRomanContextListeners();
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

function asAuthedRequestDouble<T extends object>(mock: T): AuthedRequest {
  // @ts-expect-error partial structural mock of an authenticated request.
  return mock;
}

function setup() {
  const db = makePersonaDb();
  const intake = new FakeSafetyIntakeSource();
  const svc = new RomanClientContextService(db.prisma, intake);
  return { db, intake, svc };
}
const student = (id: string) => ({ id, role: 'student' });

// ─── injection into RomanService ─────────────────────────────────────────────

function makeAnthropic(reply = 'You have 670 kcal left.') {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    messages: {
      stream: jest.fn((body: Record<string, unknown>) => {
        calls.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: reply },
            };
            yield { type: 'message_delta', usage: { output_tokens: 6 } };
          },
        };
      }),
    },
  };
}
const session = (surface: 'client' | 'coach', user_id: string) => ({
  id: 'sess_1',
  user_id,
  surface,
  day_key: LOCAL_TODAY_PT,
  message_count: 0,
  started_at: NOW,
  last_activity_at: NOW,
  quips_in_session: 0,
  exclamation_used: false,
  subject_context_json: null,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
});
async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('R3 injection — client_data block, provenance in the spend ledger, coach JWT', () => {
  // A full turn builds its grounding with the real clock; pin Date to the
  // fixtures' NOW (timers and microtasks stay real) so "today" is 09-30 PT.
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
  });
  afterEach(() => jest.useRealTimers());
  function roman(db: ReturnType<typeof setup>['db'], anthropic: ReturnType<typeof makeAnthropic>, ctx: RomanClientContextService | null) {
    return new RomanService(fakeOf(db.prisma), grantAllEgress(), AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)), ctx);
  }

  it('student on the client surface: one <client_data> block, content stays clean, context hash in the content-free ledger', async () => {
    const { db, svc } = setup();
    const anthropic = makeAnthropic();
    await drain(roman(db, anthropic, svc).streamAssistantTurn(student(P1), session('client', P1), { userMessage: 'How much is left today?' }));

    expect(anthropic.calls).toHaveLength(1);
    const system = anthropic.calls[0].system as string;
    expect(typeof system).toBe('string');
    expect(system.match(/<client_data as_of=/g)).toHaveLength(1);
    expect(system).toContain('"first_name":"Maya"');
    for (const c of CANARIES) expect(system).not.toContain(c);

    const romanTurn = db.raw.romanMessages.find((m) => m.role === 'roman');
    expect(romanTurn?.content).toBe('You have 670 kcal left.');
    expect(String(romanTurn?.content)).not.toContain('client_data');
    const ledger = db.raw.aiRequestAudits[0];
    expect(ledger.metadata).toMatchObject({ state: 'settled', context_version: 'ctx-v3' });
    const hash = (ledger.metadata as Record<string, unknown>).context_hash;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain('Maya');
  });

  it('a coach JWT on the client surface gets NO client data; the coach surface gets none either', async () => {
    const { db, svc } = setup();
    const anthropic = makeAnthropic();
    const r = roman(db, anthropic, svc);
    await drain(r.streamAssistantTurn({ id: 'coach-A', role: 'coach' }, session('client', 'coach-A'), { userMessage: 'hi' }));
    await drain(r.streamAssistantTurn({ id: 'coach-A', role: 'coach' }, session('coach', 'coach-A'), { userMessage: 'hi' }));
    for (const call of anthropic.calls) {
      expect(call.system as string).not.toContain('<client_data');
      expect(call.system as string).not.toContain('Maya');
    }
    expect(db.calls).not.toContain('loggedFoodEntry.findMany');
  });

  it('without the context service wired the client turn says the data is unavailable and still answers', async () => {
    const { db } = setup();
    const anthropic = makeAnthropic('Tell me what you would like to work on today.');
    const chunks = await drain(roman(db, anthropic, null).streamAssistantTurn(student(P1), session('client', P1), { userMessage: 'hi' }));
    expect(anthropic.calls[0].system as string).toContain('CLIENT DATA UNAVAILABLE');
    expect(chunks.some((c) => (c as { type: string }).type === 'done')).toBe(true);
  });

  it('a builder failure degrades to an honest ungrounded turn, never a blank reply', async () => {
    const { db, svc } = setup();
    jest.spyOn(svc, 'getBundle').mockRejectedValueOnce(new Error('db down'));
    const anthropic = makeAnthropic('Tell me what you would like to work on today.');
    const chunks = await drain(roman(db, anthropic, svc).streamAssistantTurn(student(P1), session('client', P1), { userMessage: 'hi' }));
    expect(anthropic.calls[0].system as string).toContain('CLIENT DATA UNAVAILABLE');
    expect(
      chunks.some(
        (c) =>
          (c as { type: string; text?: string }).type === 'done' &&
          ((c as { text?: string }).text ?? '').length > 0,
      ),
    ).toBe(true);
  });
});

