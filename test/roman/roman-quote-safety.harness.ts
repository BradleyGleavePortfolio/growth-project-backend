// test/roman/roman-quote-safety.harness.ts
//
// ROMAN-QUOTE-SAFETY-BE: the shared harness of roman-quote-safety.spec.ts (the real router) and
// roman-quote-safety.mocked.spec.ts (made-up crisis tokens). The real controller and the real RomanService over
// an in-memory Roman table that honours each read's where, order, take and select, so a missing scope or filter
// in the quote read shows. Only the gates that are not under test (consent, daily cap, turn count) are stubbed.
// No network, no DB.

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { CoachAlertsService } from '../../src/coach/coach-alerts.service';
import { RomanService } from '../../src/roman/roman.service';
import { RomanController } from '../../src/roman/roman.controller';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

// ─── the phone's wire form, copied (a server test cannot import the phone's code) ───────────────────────────────
// growth-project-mobile#950 at cd791b8c4532bfd017ecdd3980534b658f7b3365:
//   src/components/roman/romanReply.ts:14 (ROMAN_QUOTE_MAX), :22-26 (romanQuoteExcerpt), :32-39 (withRomanQuote);
//   ROMAN_MESSAGE_MAX_LENGTH is the 8,000 send cap (src/api/romanApi.ts, SendMessageDto @MaxLength(8000));
//   src/components/roman/romanQuoteSplit.ts:5 (QUOTED, the shape the server's roman-quote.ts copies).
export const ROMAN_QUOTE_MAX = 200;
export const ROMAN_MESSAGE_MAX_LENGTH = 8000;
export function romanQuoteExcerpt(content: string, max: number = ROMAN_QUOTE_MAX): string {
  const line = content.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
export function withRomanQuote(quoted: string, text: string): string {
  const body = text.trim();
  if (body === '') return text;
  const room = ROMAN_MESSAGE_MAX_LENGTH - body.length - 4; // "> " + "\n\n"
  const excerpt = romanQuoteExcerpt(quoted, Math.min(ROMAN_QUOTE_MAX, room));
  if (room < 1 || excerpt === '') return body;
  return `> ${excerpt}\n\n${body}`;
}

// ─── the world: two members, their chats, Roman's stored replies ─────────────────────────────────────────────────
export const MEMBER = 'member-1';
export const OTHER_MEMBER = 'member-2';
export const COACH = 'coach-1';
export const CHAT = 'sess_member_client';
export const OLDER_CHAT = 'sess_member_client_older';
export const OTHER_MEMBER_CHAT = 'sess_other_member_client';
export const COACH_ROOM = 'sess_coach_room';
export const MEMBER_CALLER = { id: MEMBER, role: 'student' };
export const COACH_CALLER = { id: COACH, role: 'coach' };

/** Neutral words only: a Roman reply with nothing on any list, and an ordinary answer. */
export const NEUTRAL_REPLY = 'Here is your plan for today: three sets of squats, then a short walk after dinner.';
export const NEUTRAL_BODY = 'Thanks, that makes sense.';
export const MODEL_SAYS = 'Glad it helps.';

interface Row {
  id: string;
  session_id: string;
  user_id: string;
  role: 'user' | 'roman';
  content: string;
  copilot: unknown;
  interrupted: boolean;
  created_at: Date;
  [k: string]: unknown;
}

const SESSIONS: Record<string, { user_id: string; surface: 'client' | 'coach' }> = {
  [CHAT]: { user_id: MEMBER, surface: 'client' },
  [OLDER_CHAT]: { user_id: MEMBER, surface: 'client' },
  [OTHER_MEMBER_CHAT]: { user_id: OTHER_MEMBER, surface: 'client' },
  [COACH_ROOM]: { user_id: COACH, surface: 'coach' },
};

function sessionRow(id: string) {
  const s = SESSIONS[id];
  return {
    id,
    user_id: s.user_id,
    surface: s.surface,
    day_key: '2026-11-09',
    message_count: 1,
    started_at: new Date(),
    last_activity_at: new Date(),
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };
}

type Where = Record<string, unknown> | undefined;
function matches(r: Row, where: Where): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'session') {
      if (SESSIONS[r.session_id]?.surface !== (v as { surface?: string }).surface) return false;
      continue;
    }
    if (r[k] !== v) return false;
  }
  return true;
}

export function world() {
  const rows: Row[] = [];
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 9, 12) + ++seq * 1000);
  const query = (args: { where?: Where; orderBy?: { created_at?: 'asc' | 'desc' }; take?: number; select?: Record<string, boolean> } = {}) => {
    let out = rows.filter((r) => matches(r, args.where));
    if (args.orderBy?.created_at) {
      const dir = args.orderBy.created_at === 'desc' ? -1 : 1;
      out = [...out].sort((a, b) => dir * (a.created_at.getTime() - b.created_at.getTime()));
    }
    if (typeof args.take === 'number') out = out.slice(0, args.take);
    const pick = args.select;
    return pick ? out.map((r) => Object.fromEntries(Object.keys(pick).map((k) => [k, r[k]]))) : out.map((r) => ({ ...r }));
  };
  const romanMessage = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `msg_${seq + 1}`, copilot: null, interrupted: false, ...data, created_at: stamp() } as Row;
      rows.push(row);
      return { ...row };
    }),
    findMany: jest.fn(async (args: Parameters<typeof query>[0]) => query(args)),
    findFirst: jest.fn(async (args: Parameters<typeof query>[0]) => query({ ...args, take: 1 })[0] ?? null),
    count: jest.fn(async () => 0),
  };
  const romanSession = {
    findFirst: jest.fn(async ({ where }: { where: { id?: unknown; user_id?: string } }) =>
      typeof where.id === 'string' && SESSIONS[where.id]?.user_id === where.user_id ? sessionRow(where.id) : null,
    ),
    updateMany: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => ({
      count: SESSIONS[where.id]?.user_id === where.user_id ? 1 : 0,
    })),
  };
  const aiRequestAudit = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ledger_1', ...data })),
    aggregate: jest.fn(async () => ({ _sum: { prompt_token_estimate: 0, response_token_estimate: 0 } })),
    update: jest.fn(async () => ({})),
  };
  const $executeRaw = jest.fn(async () => 1);
  const tx = { romanMessage, romanSession, aiRequestAudit, $executeRaw };
  const prisma = {
    ...tx,
    user: { findUnique: jest.fn(async () => ({ coach_id: COACH })) },
    coachSubscription: { findUnique: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };

  /** Store one turn as it was written (a Roman reply, or an earlier turn of the member). */
  const store = (session_id: string, role: 'user' | 'roman', content: string, copilot: unknown = null) =>
    rows.push({
      id: `seed_${seq + 1}`,
      session_id,
      user_id: SESSIONS[session_id].user_id,
      role,
      content,
      copilot,
      interrupted: false,
      created_at: stamp(),
    });

  const modelCalls: Array<{ system: string; messages: Array<{ role: string; content: string }> }> = [];
  const anthropic = {
    messages: {
      stream: jest.fn((body: { system: string; messages: Array<{ role: string; content: string }> }) => {
        modelCalls.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: MODEL_SAYS } };
            yield { type: 'message_delta', usage: { output_tokens: 4 } };
          },
        };
      }),
    },
  };
  const alerts = { createAlert: jest.fn(async (_input: Record<string, unknown>) => ({})) };
  const audit = { write: jest.fn(async (_input: Record<string, unknown>) => undefined) };
  const svc = new RomanService(
    fakeOf<PrismaService>(prisma),
    grantAllEgress(),
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
    null,
    fakeOf<AuditService>(audit),
    null,
    null,
    null,
    fakeOf<CoachAlertsService>(alerts),
  );
  // Gates that are not under test (each has its own suite).
  jest.spyOn(svc, 'assertMayUseAi').mockResolvedValue(undefined);
  jest.spyOn(svc, 'assertDailyCapacity').mockResolvedValue(undefined as never);
  jest.spyOn(svc, 'assertWithinRateLimit').mockResolvedValue(null);
  const preCheck = jest.spyOn(svc, 'isSafetyShortCircuit');
  const warn = jest.spyOn(Reflect.get(svc, 'logger') as { warn: (m: string) => void }, 'warn');
  const ctl = new RomanController(svc, fakeOf<PrismaService>(prisma), null);

  const reqOf = (headers: Record<string, string> = {}) => ({
    user: { id: MEMBER, role: 'student', coach_id: COACH },
    headers,
    on: () => undefined,
    off: () => undefined,
  });

  /** POST /roman/sessions/:id/messages as the member's phone sends it; the SSE frames that came back. */
  const send = async (content: string, opts: { key?: string; session?: string } = {}) => {
    const frames: string[] = [];
    const res = { writeHead: jest.fn(), setHeader: jest.fn(), write: (s: string) => frames.push(s), end: jest.fn() };
    const req = reqOf(opts.key ? { 'idempotency-key': opts.key } : {});
    await (ctl.sendMessage as (...a: unknown[]) => Promise<void>).call(ctl, req, res, opts.session ?? CHAT, { content });
    const done = frames
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)) as { type: string; text?: string })
      .find((f) => f.type === 'done');
    return { frames, done };
  };

  /** GET /roman/sessions/:id/messages as the room reads it (no Copilot header). */
  const list = async (session = CHAT) =>
    (await ctl.listMessages(reqOf() as never, session, {})) as { messages: Array<{ role: string; content: string }> };

  /** The Roman-row reads the quote proof made (role 'roman' in the where). */
  const romanReads = () =>
    romanMessage.findMany.mock.calls.filter((c) => (c[0]?.where as { role?: string } | undefined)?.role === 'roman');

  return { rows, store, svc, ctl, send, list, modelCalls, alerts, preCheck, warn, romanMessage, romanReads, key: randomUUID };
}
