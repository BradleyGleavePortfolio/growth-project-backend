import 'reflect-metadata';
import { makeWorld, student, clientSession, withRomanEnabled } from './eval/harness';
import { P1 } from './fixtures/roman-personas';
import type { CopilotFacts } from '../../src/copilot/copilot-turn';
import { localDateOf } from '../../src/roman/context/roman-client-context.service';

// COPILOT-BE2: a Path Copilot turn is the ordinary Roman turn plus the numbered facts, the citation check and the
// suggestion line; without the app's opt-in the turn is byte-for-byte today's.
withRomanEnabled();

const A1 = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;
const TZ = 'America/Los_Angeles';

function world() {
  const w = makeWorld();
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
  const copilot = { facts: jest.fn(async () => facts), saveSuggestion: jest.fn(async (id: string) => ({ id, status: 'suggested' })) };
  (w.roman as unknown as { copilot: unknown }).copilot = copilot;
  return { w, copilot, to: localDateOf(TZ)(new Date(at.getTime() + DAY)) };
}

async function turn(w: ReturnType<typeof makeWorld>, opts: { copilot?: boolean }) {
  const chunks: Array<Record<string, unknown>> = [];
  const userMessage = 'Thursday is busy this week. Can I do Lower body B on Friday?';
  for await (const c of w.roman.streamAssistantTurn(student(P1), clientSession(P1), { userMessage, userMessageId: 'q-1', ...opts })) chunks.push(c as Record<string, unknown>);
  const done = chunks.find((c) => c.type === 'done') as Record<string, unknown> & { text: string; messageId: string };
  return { done, persisted: w.db.raw.romanMessages.find((m) => m.id === done.messageId) as Record<string, unknown> };
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
    expect(done.text).not.toMatch(/suggestion|\[5\]/);
    expect(done.text).toContain('[1]');
    const [id, clientId, sessionId, s] = copilot.saveSuggestion.mock.calls[0] as unknown as [string, string, string, { change: Record<string, unknown> }];
    expect([clientId, sessionId]).toEqual([P1, `sess_${P1}`]);
    expect(s.change).toMatchObject({ kind: 'move_session', assignment_id: A1, workout: 'Lower body B' });
    expect(done.copilot).toEqual({ sources: [expect.objectContaining({ n: 1, kind: 'workout_log' })], suggestion: { id, status: 'suggested' } });
    expect(persisted.content).toBe(done.text);
    expect(persisted.copilot).toEqual({ question_id: 'q-1', sources: [expect.objectContaining({ n: 1 })], suggestion_id: id });
  });

  it('a reply with no suggestion line stores its cited facts and offers nothing', async () => {
    const { w, copilot } = world();
    w.model.enqueue('You did 7 of your 8 sessions. [1]');
    const { done, persisted } = await turn(w, { copilot: true });
    expect(copilot.saveSuggestion).not.toHaveBeenCalled();
    expect(done.copilot).toEqual({ sources: [expect.objectContaining({ n: 1 })], suggestion: null });
    expect(persisted.copilot).toEqual({ question_id: 'q-1', sources: [expect.objectContaining({ n: 1 })], suggestion_id: null });
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
