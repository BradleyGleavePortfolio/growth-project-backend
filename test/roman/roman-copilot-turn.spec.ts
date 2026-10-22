import 'reflect-metadata';
import { makeWorld, student, clientSession, withRomanEnabled } from './eval/harness';
import { P1 } from './fixtures/roman-personas';
import type { CopilotFacts, CopilotTurnService } from '../../src/copilot/copilot-turn';
import type { PathChange } from '../../src/ai/gateway/materialisers/client-path-change.materialiser';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { PrismaService } from '../../src/prisma.service';
import { RomanController } from '../../src/roman/roman.controller';
import type { RomanService, RomanStreamChunk } from '../../src/roman/roman.service';
import { localDateOf } from '../../src/roman/context/roman-client-context.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

// COPILOT-BE2: a Path Copilot turn is the ordinary Roman turn plus the numbered facts, the citation check and the
// suggestion line; without the app's opt-in the turn is byte-for-byte today's.
withRomanEnabled();

const A1 = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;
const TZ = 'America/Los_Angeles';

function world() {
  const at = new Date(Date.now() + DAY);
  const facts: CopilotFacts = {
    sources: [
      { n: 1, kind: 'workout_log', id: null, date: '2026-10-21', label: '7 of 8 sessions done', detail: 'Last 14 days' },
      { n: 2, kind: 'plan', id: null, date: '2026-10-19', label: 'Target 2,150 kcal from Mon 19 Oct', detail: null },
    ],
    sessions: [{ assignment_id: A1, workout: 'Lower body B', at }],
    target: null,
    floor: 1500,
    tz: TZ,
  };
  const copilot = {
    facts: jest.fn(async () => facts),
    saveSuggestion: jest.fn(async (id: string, _client: string, _session: string, _s: { change: PathChange; reason: string }) => ({ id, status: 'suggested' })),
  };
  const w = makeWorld(undefined, { copilot: fakeOf<CopilotTurnService>(copilot) });
  return { w, copilot, to: localDateOf(TZ)(new Date(at.getTime() + DAY)) };
}

async function turn(w: ReturnType<typeof makeWorld>, opts: { copilot?: boolean }) {
  const chunks: RomanStreamChunk[] = [];
  const userMessage = 'Thursday is busy this week. Can I do Lower body B on Friday?';
  for await (const c of w.roman.streamAssistantTurn(student(P1), clientSession(P1), { userMessage, userMessageId: 'q-1', ...opts })) chunks.push(c);
  const done = chunks.find((c) => c.type === 'done');
  return { done, persisted: w.db.raw.romanMessages.find((m) => m.id === done?.messageId) };
}

describe('Roman turn with Path Copilot', () => {
  it('the prompt carries the facts; the reply keeps real citations; the suggestion becomes the client’s unsent row', async () => {
    const { w, copilot, to } = world();
    w.model.enqueue(
      `Friday works for Lower body B. [1] Your coach decides plan changes, so I have written it up. [5]\n` +
        `<suggestion>{"kind":"move_session","session":"S1","to":"${to}","reason":"Thursday is busy; Friday is free.","sources":[1]}</suggestion>`,
    );
    const { done, persisted } = await turn(w, { copilot: true });
    expect(JSON.stringify(w.model.calls[0].body.system)).toContain('# PATH COPILOT');
    expect(JSON.stringify(w.model.calls[0].body.system)).toContain('[1] Workout log: 7 of 8 sessions done');
    expect(done?.text).not.toMatch(/suggestion|\[5\]/);
    expect(done?.text).toContain('[1]');
    const [id, clientId, sessionId, s] = copilot.saveSuggestion.mock.calls[0];
    expect([clientId, sessionId]).toEqual([P1, `sess_${P1}`]);
    expect(s.change).toMatchObject({ kind: 'move_session', assignment_id: A1, workout: 'Lower body B' });
    expect(done?.copilot).toEqual({ sources: [expect.objectContaining({ n: 1, kind: 'workout_log' })], suggestion: { id, status: 'suggested' } });
    expect(persisted?.content).toBe(done?.text);
    expect(persisted?.copilot).toEqual({ question_id: 'q-1', sources: [expect.objectContaining({ n: 1 })], suggestion_id: id });
  });

  it('a reply with no suggestion line stores its cited facts and offers nothing; later turns read it without [n]', async () => {
    const { w, copilot } = world();
    w.model.enqueue('You did 7 of your 8 sessions. [1]');
    const { done, persisted } = await turn(w, { copilot: true });
    expect(copilot.saveSuggestion).not.toHaveBeenCalled();
    expect(done?.copilot).toEqual({ sources: [expect.objectContaining({ n: 1 })], suggestion: null });
    expect(persisted?.copilot).toEqual({ question_id: 'q-1', sources: [expect.objectContaining({ n: 1 })], suggestion_id: null });
    // The history Roman reads for the next turn: that turn's [1] is a different fact, or none.
    const history = await w.roman.buildContextTurns(`sess_${P1}`);
    expect(history).toContainEqual({ role: 'assistant', content: 'You did 7 of your 8 sessions.' });
    expect(JSON.stringify(history)).not.toContain('[1]');
  });

  it('without the opt-in the turn reads no facts and has no copilot field', async () => {
    const { w, copilot } = world();
    w.model.enqueue('Friday works for Lower body B.');
    const { done, persisted } = await turn(w, {});
    expect(copilot.facts).not.toHaveBeenCalled();
    expect(JSON.stringify(w.model.calls[0].body.system)).not.toContain('PATH COPILOT');
    expect(done).not.toHaveProperty('copilot');
    expect(persisted).not.toHaveProperty('copilot');
  });
});

describe('GET /roman/sessions/:id/messages with a Copilot reply', () => {
  const saved = process.env.FEATURE_CLIENT_PATH_COPILOT;
  beforeEach(() => { process.env.FEATURE_CLIENT_PATH_COPILOT = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env.FEATURE_CLIENT_PATH_COPILOT; else process.env.FEATURE_CLIENT_PATH_COPILOT = saved; });

  const at = new Date('2026-10-21T17:00:00Z');
  const question = { id: 'm-0', role: 'user', content: 'Is [1] my target?', interrupted: false, created_at: at, copilot: null };
  const reply = { id: 'm-1', role: 'roman', content: 'Friday works. [1] Your coach decides. [2]', interrupted: false, created_at: at, copilot: { question_id: 'm-0', sources: [], suggestion_id: null } };
  function list(user: { coach_id: string | null }, headers: Record<string, string>) {
    const views = jest.fn(async () => new Map([['m-1', { sources: [], suggestion: null }]]));
    const roman = fakeOf<RomanService>({ listMessages: async () => ({ messages: [question, reply], nextCursor: null }) });
    const prisma = fakeOf<PrismaService>({ coachSubscription: { findUnique: async () => null } });
    const ctrl = new RomanController(roman, prisma, fakeOf<CopilotTurnService>({ views }));
    const req = fakeOf<AuthedRequest>({ user: { id: P1, role: 'student', ...user }, headers });
    return { views, out: ctrl.listMessages(req, `sess_${P1}`, {}) };
  }

  it('an app without the Copilot header reads the reply without its [n] markers; other turns are untouched', async () => {
    const { views, out } = list({ coach_id: 'coach-k' }, {});
    const { messages } = await out;
    expect(views).not.toHaveBeenCalled();
    expect(messages.map((m) => m.content)).toEqual(['Is [1] my target?', 'Friday works. Your coach decides.']);
    expect(messages[1]).not.toHaveProperty('copilot');
  });

  it('the Copilot screen keeps the markers and reads the facts; a coachless client never does', async () => {
    const asked = await list({ coach_id: 'coach-k' }, { 'x-roman-copilot': '1' }).out;
    expect(asked.messages[1]).toMatchObject({ content: 'Friday works. [1] Your coach decides. [2]', copilot: { sources: [], suggestion: null } });
    const coachless = list({ coach_id: null }, { 'x-roman-copilot': '1' });
    const { messages } = await coachless.out;
    expect(coachless.views).not.toHaveBeenCalled();
    expect(messages[1]).toMatchObject({ content: 'Friday works. Your coach decides.' });
    expect(messages[1]).not.toHaveProperty('copilot');
  });
});
