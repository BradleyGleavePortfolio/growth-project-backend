// test/roman/tools/roman-extra-history-quote.spec.ts
//
// ROMAN-QUOTE-READERS-BE (T4), case 9: read_history's roman_chat events give a proven quoted client turn the
// member's words alone (from 'client', clamped after the split); Roman's own events are unchanged; every unproven
// form stays whole, as today. The real RomanReadToolbox over an in-memory Roman table that honours each read's
// where (chats, owner, surface, deleted, role, interrupted, time, { in }), order, take and select. Neutral words
// only. FEATURE_ROMAN_TOOLS is set in this spec's own env.
import { Logger } from '@nestjs/common';
import { RomanReadToolbox } from '../../../src/roman/tools/roman-read-tools';
import type { RomanTimelineReader } from '../../../src/roman/memory/roman-timeline.reader';
import type { PrismaService } from '../../../src/prisma.service';
import { sanitizePromptInput } from '../../../src/ai/utils/sanitize-prompt-input';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';
import { withRomanQuote } from '../roman-quote-safety.harness';

const NOW = new Date('2026-10-06T19:00:00.000Z'); // 12:00 in Los Angeles
const T = (iso: string) => new Date(iso);
const CLIENT = 'client-a';
const OTHER = 'client-b';
const CHAT = 'chat-oct-1';
const OLDER = 'chat-sep-30';
const OTHER_CHAT = 'chat-other-client';
const COACH_ROOM = 'chat-coach-surface';
const SESSIONS: Record<string, { user_id: string; surface: string; deleted_at: Date | null }> = {
  [CHAT]: { user_id: CLIENT, surface: 'client', deleted_at: null },
  [OLDER]: { user_id: CLIENT, surface: 'client', deleted_at: null },
  [OTHER_CHAT]: { user_id: OTHER, surface: 'client', deleted_at: null },
  [COACH_ROOM]: { user_id: CLIENT, surface: 'coach', deleted_at: null },
};

type Row = { session_id: string; user_id: string; role: string; content: string; copilot: unknown; interrupted: boolean; created_at: Date };
type W = Record<string, unknown>;
function cond(value: unknown, want: unknown): boolean {
  if (want && typeof want === 'object' && !(want instanceof Date)) {
    const o = want as { in?: unknown[]; gte?: Date; lt?: Date };
    if (o.in && !o.in.includes(value)) return false;
    if (o.gte && !((value as Date) >= o.gte)) return false;
    if (o.lt && !((value as Date) < o.lt)) return false;
    return true;
  }
  return value === want;
}
const matches = (r: Row, where: W) =>
  Object.entries(where).every(([k, v]) =>
    k === 'session'
      ? Object.entries(v as W).every(([sk, sv]) => cond((SESSIONS[r.session_id] as W)[sk], sv))
      : cond((r as W)[k], v));

function setup(rows: Row[], opts: { quoteReadThrows?: boolean } = {}) {
  const findMany = jest.fn(async (a: { where: W; orderBy?: { created_at: 'asc' | 'desc' }; take?: number; select?: W }) => {
    if (opts.quoteReadThrows && a.where.role === 'roman') throw new Error(`boom ${rows.map((r) => r.content).join(' ')}`);
    const dir = a.orderBy?.created_at === 'asc' ? 1 : -1;
    const out = rows.filter((r) => matches(r, a.where)).sort((x, y) => dir * (x.created_at.getTime() - y.created_at.getTime()));
    const page = out.slice(0, a.take ?? out.length);
    return a.select ? page.map((r) => Object.fromEntries(Object.keys(a.select!).map((k) => [k, (r as W)[k]]))) : page;
  });
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ deleted_at: null, notification_prefs: { timezone: 'America/Los_Angeles' } })) },
    romanMessage: { findMany },
  };
  const timeline = { read: jest.fn(async () => ({ client_id: CLIENT, events: [], next_cursor: null, truncated: [] })) };
  const box = new RomanReadToolbox(fakeOf<PrismaService>(prisma), fakeOf<RomanTimelineReader>(timeline));
  const run = async () => {
    const r = await box.run({ id: CLIENT, role: 'student' }, 'read_history', { from: '2026-10-01', to: '2026-10-02', kinds: ['roman_chat'] }, { now: NOW });
    return { r, events: (JSON.parse(r.content) as { events: Array<{ from: string; text: string }> }).events };
  };
  const romanReads = () => findMany.mock.calls.filter((c) => c[0].where.role === 'roman');
  return { findMany, run, romanReads };
}

const row = (session_id: string, role: string, content: string, iso: string, extra: Partial<Row> = {}): Row =>
  ({ session_id, user_id: SESSIONS[session_id].user_id, role, content, copilot: null, interrupted: false, created_at: T(iso), ...extra });

const ROMAN_SAYS = 'You train before work, so keep breakfast light and eat a proper lunch after your session.';
const OWN = 'Makes sense, I will try that tomorrow.';
const whole = (t: string) => sanitizePromptInput(t, 300).trim();

describe('ROMAN-QUOTE-READERS-BE case 9: the history tool reads a proven quote as the member\'s words alone', () => {
  const saved = process.env.FEATURE_ROMAN_TOOLS;
  beforeEach(() => { process.env.FEATURE_ROMAN_TOOLS = 'true'; });
  afterAll(() => {
    if (saved === undefined) delete process.env.FEATURE_ROMAN_TOOLS;
    else process.env.FEATURE_ROMAN_TOOLS = saved;
  });

  it('9 (Red): a proven quoted turn\'s event is from client with the member\'s words alone; the quoted reply\'s own event is unchanged', async () => {
    const t = setup([
      row(CHAT, 'roman', ROMAN_SAYS, '2026-10-01T16:00:00Z'),
      row(CHAT, 'user', withRomanQuote(ROMAN_SAYS, OWN), '2026-10-01T16:00:05Z'),
    ]);
    const { r, events } = await t.run();
    expect(r).toMatchObject({ ok: true });
    expect(events.map((e) => [e.from, e.text])).toEqual([['roman', ROMAN_SAYS], ['client', OWN]]);
    expect(t.romanReads()).toHaveLength(1);
    expect(t.romanReads()[0][0].where).toMatchObject({
      session_id: { in: [CHAT] }, user_id: CLIENT, role: 'roman', session: { user_id: CLIENT, surface: 'client', deleted_at: null },
      created_at: { lt: T('2026-10-03T07:00:00Z') },
    });
    expect(t.romanReads()[0][0].where).not.toHaveProperty('interrupted');
  });

  it('9: the member\'s words are clamped after the split', async () => {
    const long = `${'Thanks for that. '.repeat(30)}`.trim();
    const t = setup([
      row(CHAT, 'roman', ROMAN_SAYS, '2026-10-01T16:00:00Z'),
      row(CHAT, 'user', withRomanQuote(ROMAN_SAYS, long), '2026-10-01T16:00:05Z'),
    ]);
    const { events } = await t.run();
    expect(events[1]).toMatchObject({ from: 'client', text: whole(long) });
  });

  it('9: a quoted reply older than the window still proves (the read is any Roman row of that chat before the window\'s end)', async () => {
    const t = setup([
      row(CHAT, 'roman', ROMAN_SAYS, '2026-09-30T05:00:00Z'),
      row(CHAT, 'user', withRomanQuote(ROMAN_SAYS, OWN), '2026-10-01T16:00:05Z'),
    ]);
    const { events } = await t.run();
    expect(events.map((e) => [e.from, e.text])).toEqual([['client', OWN]]);
  });

  it('9: an interrupted reply the room still shows proves; its own event stays out, as today', async () => {
    const t = setup([
      row(CHAT, 'roman', ROMAN_SAYS, '2026-10-01T16:00:00Z', { interrupted: true }),
      row(CHAT, 'user', withRomanQuote(ROMAN_SAYS, OWN), '2026-10-01T16:00:05Z'),
    ]);
    const { events } = await t.run();
    expect(events.map((e) => [e.from, e.text])).toEqual([['client', OWN]]);
  });

  it.each([
    ['the shape with no reply that opens it', [row(CHAT, 'roman', 'Here is your plan for today.', '2026-10-01T16:00:00Z')]],
    ['the excerpt stored as Roman\'s in another chat of this client', [row(OLDER, 'roman', ROMAN_SAYS, '2026-09-30T16:00:00Z')]],
    ['the excerpt in another client\'s chat', [row(OTHER_CHAT, 'roman', ROMAN_SAYS, '2026-10-01T16:00:00Z')]],
    ['the excerpt in this chat id but on another client\'s row', [row(CHAT, 'roman', ROMAN_SAYS, '2026-09-30T16:00:00Z', { user_id: OTHER })]],
    ['the excerpt in a coach-surface chat', [row(COACH_ROOM, 'roman', ROMAN_SAYS, '2026-09-30T16:00:00Z')]],
  ])('9: unproven, whole as today: %s', async (_name, roman) => {
    const turn = withRomanQuote(ROMAN_SAYS, OWN);
    const t = setup([...roman, row(CHAT, 'user', turn, '2026-10-01T16:00:05Z')]);
    const { events } = await t.run();
    expect(events.filter((e) => e.from === 'client').map((e) => e.text)).toEqual([whole(turn)]);
  });

  it('9: no shape: no extra read', async () => {
    const t = setup([row(CHAT, 'roman', ROMAN_SAYS, '2026-10-01T16:00:00Z'), row(CHAT, 'user', OWN, '2026-10-01T16:00:05Z')]);
    const { events } = await t.run();
    expect(events.map((e) => e.text)).toEqual([ROMAN_SAYS, OWN]);
    expect(t.romanReads()).toHaveLength(0);
    expect(t.findMany).toHaveBeenCalledTimes(1);
  });

  it('9: Roman\'s own reply in the shape is never split', async () => {
    const shaped = withRomanQuote(ROMAN_SAYS, 'And one more thing.');
    const t = setup([row(CHAT, 'roman', ROMAN_SAYS, '2026-10-01T15:00:00Z'), row(CHAT, 'roman', shaped, '2026-10-01T16:00:00Z')]);
    const { events } = await t.run();
    expect(events.map((e) => e.text)).toEqual([ROMAN_SAYS, whole(shaped)]);
    expect(t.romanReads()).toHaveLength(0);
  });

  it('9: a failed read leaves the text whole, the tool still answers, and the log holds a code and no text', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const turn = withRomanQuote(ROMAN_SAYS, OWN);
      const t = setup([row(CHAT, 'roman', ROMAN_SAYS, '2026-10-01T16:00:00Z'), row(CHAT, 'user', turn, '2026-10-01T16:00:05Z')],
        { quoteReadThrows: true });
      const { r, events } = await t.run();
      expect(r).toMatchObject({ ok: true });
      expect(events.map((e) => e.text)).toEqual([ROMAN_SAYS, whole(turn)]);
      const logged = warn.mock.calls.map((c) => String(c[0]));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^roman\.history_quote_failed: [A-Za-z]+$/);
    } finally {
      warn.mockRestore();
    }
  });
});
