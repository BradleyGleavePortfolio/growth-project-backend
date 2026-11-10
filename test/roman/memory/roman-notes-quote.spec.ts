// test/roman/memory/roman-notes-quote.spec.ts
//
// ROMAN-QUOTE-READERS-BE (T4), case 7: the notes writer gives the model a proven quoted turn's member words alone,
// split on the raw text before sanitising and the clamp; every unproven form stays whole, as today. The REAL
// AiEgressService over a fake consent reader, an in-memory Roman table that honours each read's where (chats, owner,
// surface, deleted, role, time, { in }), order, take and select, a fake spend and a fake Anthropic client. Neutral
// words only. FEATURE_ROMAN_MEMORY is set in this spec's own env, as roman-notes.writer.spec.ts:118-121 does.
import 'reflect-metadata';
import { AiEgressService, AnthropicHandle } from '../../../src/ai-egress/ai-egress.service';
import type { AnthropicMessagesClient } from '../../../src/ai-egress/ai-egress.service';
import type { ClientAiConsentReader } from '../../../src/ai-consent/ai-consent.reader';
import type { RomanBackgroundSpendService } from '../../../src/roman/background/roman-background-spend';
import type { PrismaService } from '../../../src/prisma.service';
import { ROMAN_MODEL_BACKGROUND } from '../../../src/roman/anthropic-client.provider';
import { RomanNotesWriter } from '../../../src/roman/memory/roman-notes.writer';
import { sanitizePromptInput } from '../../../src/ai/utils/sanitize-prompt-input';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';
import { withRomanQuote } from '../roman-quote-safety.harness';

const CLIENT = 'client-v5';
const OTHER = 'client-other';
const NOW = new Date('2026-10-07T17:00:00Z');
const GRANT_AT = new Date('2026-10-07T12:00:00Z');
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 7, h, m));

const CHAT = 'chat-today';
const OLDER = 'chat-yesterday';
const OTHER_CHAT = 'chat-other-client';
const COACH_ROOM = 'chat-coach-surface';
const SESSIONS: Record<string, { user_id: string; surface: string; deleted_at: Date | null }> = {
  [CHAT]: { user_id: CLIENT, surface: 'client', deleted_at: null },
  [OLDER]: { user_id: CLIENT, surface: 'client', deleted_at: null },
  [OTHER_CHAT]: { user_id: OTHER, surface: 'client', deleted_at: null },
  [COACH_ROOM]: { user_id: CLIENT, surface: 'coach', deleted_at: null },
};

class Reader implements ClientAiConsentReader {
  async hasClientAiConsent(id: string) { return id === CLIENT; }
  async clientsWithAiConsent(ids: readonly string[]) { return new Set(ids.filter((id) => id === CLIENT)); }
  async memoryGrantTimes(ids: readonly string[]) {
    return new Map(ids.filter((id) => id === CLIENT).map((id) => [id, GRANT_AT] as const));
  }
}

type Row = { id: string; session_id: string; user_id: string; role: string; content: string; copilot: unknown; created_at: Date };
type W = Record<string, unknown>;

function cond(value: unknown, want: unknown): boolean {
  if (want && typeof want === 'object' && !(want instanceof Date)) {
    const o = want as { in?: unknown[]; gt?: Date; lt?: Date };
    if (o.in && !o.in.includes(value)) return false;
    if (o.gt && !((value as Date) > o.gt)) return false;
    if (o.lt && !((value as Date) < o.lt)) return false;
    return true;
  }
  return value === want;
}
function matches(r: Row, where: W): boolean {
  return Object.entries(where).every(([k, v]) =>
    k === 'session'
      ? Object.entries(v as W).every(([sk, sv]) => cond((SESSIONS[r.session_id] as W)[sk], sv))
      : cond((r as W)[k], v));
}

function setup(rows: Row[], reply: unknown = { notes: [] }, opts: { quoteReadThrows?: boolean } = {}) {
  const notes: Array<Record<string, unknown>> = [];
  const db = {
    $queryRaw: jest.fn(async () => [{ client_id: CLIENT, newest_at: at(16) }]),
    romanMemoryState: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => undefined) },
    romanMessage: {
      findMany: jest.fn(async (a: { where: W; orderBy?: { created_at: 'asc' | 'desc' }; take?: number; select?: W }) => {
        if (opts.quoteReadThrows && a.where.role === 'roman') {
          throw new Error(`boom ${rows.map((r) => r.content).join(' ')}`);
        }
        const dir = a.orderBy?.created_at === 'asc' ? 1 : -1;
        const out = rows.filter((r) => matches(r, a.where)).sort((x, y) => dir * (x.created_at.getTime() - y.created_at.getTime()));
        const page = out.slice(0, a.take ?? out.length);
        return a.select ? page.map((r) => Object.fromEntries(Object.keys(a.select!).map((k) => [k, (r as W)[k]]))) : page;
      }),
    },
    romanClientNote: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        notes.push(data);
        return { id: `note-${notes.length}` };
      }),
      updateMany: jest.fn(async () => undefined),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const create = jest.fn(async () => ({
    content: [{ type: 'text', text: JSON.stringify(reply) }],
    usage: { input_tokens: 120, output_tokens: 40 },
  }));
  const handle = AnthropicHandle.bind({ messages: fakeOf<AnthropicMessagesClient['messages']>({ create, stream: jest.fn() }) });
  const egress = new AiEgressService(new Reader());
  const send = jest.spyOn(egress, 'anthropicMessagesCreate');
  const reservation = { requestId: 'r1', capability: 'roman.memory', model: ROMAN_MODEL_BACKGROUND, poolCoachId: null };
  const spend = { reserve: jest.fn(async () => ({ admitted: true, reservation })), settle: jest.fn(async () => undefined) };
  const writer = new RomanNotesWriter(fakeOf<PrismaService>(db), egress, fakeOf<RomanBackgroundSpendService>(spend), handle);
  const warn = jest.spyOn(Reflect.get(writer, 'logger') as { warn: (m: string) => void }, 'warn');
  const sent = () => (JSON.parse(String(send.mock.calls[0][3].messages[0].content)) as { messages: Array<{ id: string; text: string }> }).messages;
  const romanReads = () => db.romanMessage.findMany.mock.calls.filter((c) => c[0].where.role === 'roman');
  return { db, notes, writer, sent, warn, romanReads, create };
}

const row = (id: string, session_id: string, role: string, content: string, h: number, m = 0): Row =>
  ({ id, session_id, user_id: SESSIONS[session_id].user_id, role, content, copilot: null, created_at: at(h, m) });

/** Roman's sentence: never a fact the client stated. */
const ROMAN_SAYS = 'You train before work, so keep breakfast light and eat a proper lunch after your session.';
const OWN = 'I also really dislike oats.';
const own = (t: string) => sanitizePromptInput(t, 1000).slice(0, 1000).trim();

describe('ROMAN-QUOTE-READERS-BE case 7: the notes writer reads a proven quote as the member\'s words alone', () => {
  const saved = process.env.FEATURE_ROMAN_MEMORY;
  beforeEach(() => { process.env.FEATURE_ROMAN_MEMORY = 'true'; });
  afterAll(() => {
    if (saved === undefined) delete process.env.FEATURE_ROMAN_MEMORY;
    else process.env.FEATURE_ROMAN_MEMORY = saved;
  });

  it('7 (Red): a proven quoted turn reaches the model as the member\'s words alone; the note\'s source is that turn', async () => {
    const t = setup(
      [row('r1', CHAT, 'roman', ROMAN_SAYS, 13), row('u1', CHAT, 'user', withRomanQuote(ROMAN_SAYS, OWN), 14)],
      { notes: [{ kind: 'diet_dislike', key: 'diet_dislike.oats', text: 'Dislikes oats.', source: 't1' }] },
    );
    await t.writer.runOnce(NOW);
    expect(t.sent()).toEqual([{ id: 't1', text: OWN }]);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatchObject({ client_id: CLIENT, key: 'diet_dislike.oats', source_message_id: 'u1' });
    // One Roman read for the run, scoped to that client's own live client-surface chats.
    expect(t.romanReads()).toHaveLength(1);
    expect(t.romanReads()[0][0].where).toMatchObject({
      session_id: { in: [CHAT] }, user_id: CLIENT, role: 'roman', session: { user_id: CLIENT, surface: 'client', deleted_at: null },
    });
  });

  it('7: a proven turn among plain ones: only it is split; the order and ids stay', async () => {
    const t = setup([
      row('u0', CHAT, 'user', 'I train before work most days.', 12),
      row('r1', CHAT, 'roman', ROMAN_SAYS, 13),
      row('u1', CHAT, 'user', withRomanQuote(ROMAN_SAYS, OWN), 14),
      row('u2', CHAT, 'user', 'And I have a bike at home.', 15),
    ]);
    await t.writer.runOnce(NOW);
    expect(t.sent()).toEqual([
      { id: 't1', text: 'I train before work most days.' },
      { id: 't2', text: OWN },
      { id: 't3', text: 'And I have a bike at home.' },
    ]);
  });

  it.each([
    ['the shape with no reply that opens it', [row('r1', CHAT, 'roman', 'Here is your plan for today.', 13)]],
    ['the excerpt stored as Roman\'s in another chat of this client', [row('r1', OLDER, 'roman', ROMAN_SAYS, 9)]],
    ['the excerpt in another client\'s chat', [row('r1', OTHER_CHAT, 'roman', ROMAN_SAYS, 13)]],
    ['the excerpt in a coach-surface chat', [row('r1', COACH_ROOM, 'roman', ROMAN_SAYS, 13)]],
  ])('7: unproven, whole as today: %s', async (_name, roman) => {
    const turn = withRomanQuote(ROMAN_SAYS, OWN);
    const t = setup([...roman, row('u1', CHAT, 'user', turn, 14)]);
    await t.writer.runOnce(NOW);
    expect(t.sent()).toEqual([{ id: 't1', text: own(turn) }]);
  });

  it('7: no shape in any turn: no extra read', async () => {
    const t = setup([row('r1', CHAT, 'roman', ROMAN_SAYS, 13), row('u1', CHAT, 'user', OWN, 14)]);
    await t.writer.runOnce(NOW);
    expect(t.sent()).toEqual([{ id: 't1', text: OWN }]);
    expect(t.romanReads()).toHaveLength(0);
    expect(t.db.romanMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('7: the Roman read throws: whole texts, the run goes on, the log holds a code and no text', async () => {
    const turn = withRomanQuote(ROMAN_SAYS, OWN);
    const t = setup(
      [row('r1', CHAT, 'roman', ROMAN_SAYS, 13), row('u1', CHAT, 'user', turn, 14)],
      { notes: [{ kind: 'diet_dislike', key: 'diet_dislike.oats', text: 'Dislikes oats.', source: 't1' }] },
      { quoteReadThrows: true },
    );
    const result = await t.writer.runOnce(NOW);
    expect(t.sent()).toEqual([{ id: 't1', text: own(turn) }]);
    expect(t.notes).toHaveLength(1);
    expect(result.outcomes).toEqual({ ok: 1 });
    const logged = t.warn.mock.calls.map((c) => String(c[0]));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^roman\.notes_quote_failed: [A-Za-z]+$/);
    for (const line of logged) for (const words of [ROMAN_SAYS, OWN, 'boom']) expect(line).not.toContain(words);
  });
});
