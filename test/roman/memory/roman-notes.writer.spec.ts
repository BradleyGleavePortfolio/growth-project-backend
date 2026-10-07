// R11-M4: Roman's notes from chats. The REAL AiEgressService over a scope-aware fake consent
// reader, an in-memory Prisma double, a fake background spend and a fake Anthropic client.
import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AiEgressService, AnthropicHandle } from '../../../src/ai-egress/ai-egress.service';
import type { AnthropicMessagesClient } from '../../../src/ai-egress/ai-egress.service';
import type { ClientAiConsentReader } from '../../../src/ai-consent/ai-consent.reader';
import type { RomanBackgroundSpendService } from '../../../src/roman/background/roman-background-spend';
import type { PrismaService } from '../../../src/prisma.service';
import { ROMAN_MODEL_BACKGROUND } from '../../../src/roman/anthropic-client.provider';
import { RomanModule } from '../../../src/roman/roman.module';
import { RomanNotesWriter } from '../../../src/roman/memory/roman-notes.writer';
import { RomanNotesScheduler } from '../../../src/roman/memory/roman-notes.scheduler';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';

const V4 = 'client-v4';
const V5 = 'client-v5';
const OTHER = 'client-other';
const NOW = new Date('2026-10-07T17:00:00Z');
const GRANT_AT = new Date('2026-10-07T12:00:00Z');
const at = (h: number) => new Date(Date.UTC(2026, 9, 7, h));

// V5 holds a live client-ai-v5 grant ('base' + 'memory', granted at GRANT_AT); V4 holds client-ai-v4 ('base' only).
class ScopedReader implements ClientAiConsentReader {
  private ok = (id: string, scope?: string) => id === V5 || (scope !== 'memory' && id === V4);
  async hasClientAiConsent(id: string, scope?: 'base' | 'memory') { return this.ok(id, scope); }
  async clientsWithAiConsent(ids: readonly string[], scope?: 'base' | 'memory') {
    return new Set(ids.filter((id) => this.ok(id, scope)));
  }
  async memoryGrantTimes(ids: readonly string[]) {
    return new Map(ids.filter((id) => id === V5).map((id) => [id, GRANT_AT] as const));
  }
}

type Msg = { id: string; user_id: string; owner: string; role: string; content: string; created_at: Date };
type Note = { id: string; client_id: string; key: string; text: string; kind: string; expires_at: Date | null;
  superseded_at: Date | null; superseded_by_id: string | null; source_message_id: string | null; source_at: Date };
type Where = { client_id: string };
type MsgWhere = { user_id: string; role: string; created_at: { gt: Date }; session: { user_id: string } };
type NewNote = Omit<Note, 'id' | 'superseded_at' | 'superseded_by_id'>;

function makeDb(msgs: Msg[], notes: Note[] = []) {
  const states = new Map<string, Record<string, unknown>>();
  let n = 0;
  let self: unknown = null;
  const db = {
    notes,
    states,
    $queryRaw: jest.fn(async () => {
      const newest = new Map<string, Date>();
      for (const m of msgs) {
        const mark = states.get(m.user_id)?.notes_watermark_at as Date | undefined;
        if (m.role !== 'user' || m.owner !== m.user_id || (mark && m.created_at <= mark)) continue;
        if (!newest.has(m.user_id) || m.created_at > newest.get(m.user_id)!) newest.set(m.user_id, m.created_at);
      }
      return [...newest].map(([client_id, newest_at]) => ({ client_id, newest_at }));
    }),
    romanMemoryState: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => states.get(where.client_id) ?? null),
      upsert: jest.fn(async ({ where, update }: { where: Where; update: Record<string, unknown> }) => {
        states.set(where.client_id, { ...(states.get(where.client_id) ?? {}), ...update });
      }),
    },
    romanMessage: {
      findMany: jest.fn(async ({ where, take }: { where: MsgWhere; take: number }) =>
        msgs
          .filter((m) => m.user_id === where.user_id && m.owner === where.session.user_id)
          .filter((m) => m.role === where.role && m.created_at > where.created_at.gt)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(0, take)),
    },
    romanClientNote: {
      findMany: jest.fn(async ({ where }: { where: Where & { key?: string } }) =>
        notes.filter((x) => x.client_id === where.client_id && x.superseded_at === null &&
          (where.key === undefined || x.key === where.key))),
      create: jest.fn(async ({ data }: { data: NewNote }) => {
        const row: Note = { id: `note-${++n}`, superseded_at: null, superseded_by_id: null, ...data };
        notes.push(row);
        return { id: row.id };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Note> }) => {
        for (const x of notes) if (where.id.in.includes(x.id)) Object.assign(x, data);
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self)),
  };
  self = db;
  return db;
}

const msg = (id: string, user: string, h: number, content: string, role = 'user', owner = user): Msg =>
  ({ id, user_id: user, owner, role, content, created_at: at(h) });

function setup(opts: { msgs: Msg[]; notes?: Note[]; reply?: unknown; admitted?: boolean }) {
  const db = makeDb(opts.msgs, opts.notes);
  const create = jest.fn(async () => ({
    content: [{ type: 'text', text: JSON.stringify(opts.reply ?? { notes: [] }) }],
    usage: { input_tokens: 120, output_tokens: 40 },
  }));
  const handle = AnthropicHandle.bind({
    messages: fakeOf<AnthropicMessagesClient['messages']>({ create, stream: jest.fn() }),
  });
  const egress = new AiEgressService(new ScopedReader());
  const send = jest.spyOn(egress, 'anthropicMessagesCreate');
  const reservation = { requestId: 'r1', capability: 'roman.memory', model: ROMAN_MODEL_BACKGROUND, poolCoachId: null };
  const spend = {
    reserve: jest.fn(async () =>
      opts.admitted === false ? { admitted: false, reason: 'pool_empty' } : { admitted: true, reservation }),
    settle: jest.fn(async () => undefined),
  };
  const writer = new RomanNotesWriter(
    fakeOf<PrismaService>(db), egress, fakeOf<RomanBackgroundSpendService>(spend), handle);
  const sent = () => JSON.parse(String(send.mock.calls[0][3].messages[0].content));
  return { db, create, send, spend, writer, sent };
}

describe('R11-M4 RomanNotesWriter', () => {
  const saved = process.env.FEATURE_ROMAN_MEMORY;
  beforeEach(() => { process.env.FEATURE_ROMAN_MEMORY = 'true'; });
  afterAll(() => {
    if (saved === undefined) delete process.env.FEATURE_ROMAN_MEMORY;
    else process.env.FEATURE_ROMAN_MEMORY = saved;
  });

  const v5Turns = [
    msg('m1', V5, 10, 'Before I agreed: I hate oats.'),
    msg('m2', V5, 13, 'I really dislike oats, and I train before work.'),
    msg('m3', V5, 14, 'Here is your plan.', 'roman'),
    msg('m4', OTHER, 15, 'Someone else entirely.', 'user', V5),
  ];

  it('flag off: no reads, no calls', async () => {
    process.env.FEATURE_ROMAN_MEMORY = 'false';
    const { db, create, writer } = setup({ msgs: v5Turns });
    await writer.runOnce(NOW);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.romanMessage.findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('v4-only client: no turn read, no call, outcome no_consent', async () => {
    const { db, create, spend, writer } = setup({ msgs: [msg('a1', V4, 14, 'I like rice.')] });
    await writer.runOnce(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(spend.reserve).not.toHaveBeenCalled();
    expect(db.romanMessage.findMany).not.toHaveBeenCalled();
    expect(db.states.get(V4)).toMatchObject({ last_outcome: 'no_consent', notes_watermark_at: at(14) });
  });

  it('v5 client: one roman.memory call with scope memory, own post-grant user turns only', async () => {
    const { create, send, spend, writer, sent } = setup({ msgs: v5Turns });
    await writer.runOnce(NOW);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ kind: 'client_data', clientIds: [V5], audience: 'client', scope: 'memory' });
    expect(send.mock.calls[0][2]).toBe('roman.memory');
    expect(spend.reserve).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'roman.memory', payer: { kind: 'client', clientId: V5 },
      model: ROMAN_MODEL_BACKGROUND, maxOutputTokens: 800 }));
    expect(spend.settle).toHaveBeenCalledWith(expect.anything(), 120, 40, { outcome: 'ok' });
    // Turns before the v5 grant, Roman replies and other users are never sent.
    expect(sent().messages).toEqual([{ id: 't1', text: 'I really dislike oats, and I train before work.' }]);
  });

  it('pool refusal: no call, outcome pool_empty, watermark unchanged', async () => {
    const { db, create, writer } = setup({ msgs: v5Turns, admitted: false });
    await writer.runOnce(NOW);
    expect(create).not.toHaveBeenCalled();
    expect(db.states.get(V5)).toEqual({ last_run_at: NOW, last_outcome: 'pool_empty' });
  });

  it('drops invalid items and stores the valid one with its source', async () => {
    const good = { kind: 'diet_dislike', key: 'diet_dislike.oats', text: 'Dislikes oats.', source: 't1' };
    const reply = { notes: [good, { ...good, kind: 'diagnosis', key: 'diagnosis.x' }, { ...good, key: 'goal.oats' },
      { ...good, key: 'diet_dislike.Oats Bad' }, { ...good, key: 'diet_dislike.email', text: 'Mail sam@example.com' },
      { ...good, key: 'diet_dislike.short', text: 'no' }, { ...good, key: 'diet_dislike.src', source: 't9' }, 'nope'] };
    const { db, writer } = setup({ msgs: v5Turns, reply });
    const result = await writer.runOnce(NOW);
    expect(db.notes).toEqual([expect.objectContaining({
      client_id: V5, key: 'diet_dislike.oats', text: 'Dislikes oats.', source_message_id: 'm2',
      source_at: at(13), expires_at: null })]);
    expect(result.dropped).toEqual({ kind: 1, key: 2, contact: 1, text: 1, source: 1, shape: 1 });
    expect(db.states.get(V5)).toMatchObject({ last_outcome: 'ok', notes_watermark_at: at(13) });
  });

  it('same key supersedes the live note; schedule notes expire after 30 days', async () => {
    const old: Note = { id: 'old', client_id: V5, key: 'schedule.train_time', text: 'Trains after work.',
      kind: 'schedule', expires_at: null, superseded_at: null, superseded_by_id: null,
      source_message_id: null, source_at: at(1) };
    const reply = { notes: [{ kind: 'schedule', key: 'schedule.train_time', text: 'Trains before work.', source: 't1' }] };
    const { db, writer, sent } = setup({ msgs: v5Turns, notes: [old], reply });
    await writer.runOnce(NOW);
    expect(sent().kept_notes).toEqual([{ key: 'schedule.train_time', text: 'Trains after work.' }]);
    const fresh = db.notes.find((x) => x.id !== 'old')!;
    expect(old).toMatchObject({ superseded_at: NOW, superseded_by_id: fresh.id });
    expect(fresh).toMatchObject({ text: 'Trains before work.', source_message_id: 'm2',
      expires_at: new Date(at(13).getTime() + 30 * 86_400_000) });
  });

  it('egress.memoryGrantTimes fails closed: a reader without it, or a failing read, gives no grant times', async () => {
    const base = { hasClientAiConsent: async () => true, clientsWithAiConsent: async () => new Set([V5]) };
    expect(await new AiEgressService(base).memoryGrantTimes([V5])).toEqual(new Map());
    const failing = { ...base, memoryGrantTimes: async () => { throw new Error('db down'); } };
    expect(await new AiEgressService(failing).memoryGrantTimes([V5])).toEqual(new Map());
    expect(await new AiEgressService(new ScopedReader()).memoryGrantTimes([V4, V5])).toEqual(new Map([[V5, GRANT_AT]]));
  });

  it('RomanModule provides the writer and its scheduler', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    expect(providers).toEqual(expect.arrayContaining([RomanNotesWriter, RomanNotesScheduler]));
  });
});
