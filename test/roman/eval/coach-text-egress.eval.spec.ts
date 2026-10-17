// test/roman/eval/coach-text-egress.eval.spec.ts
//
// COACH-TEXT-EGRESS (owner "#COACH-TEXT - op 1"): one client turn through the REAL RomanService,
// context builder, coach-method augmenter and read_history tool, over the REAL egress gate (only
// the ledger read is a double). While P1's coach allows AI, the coach's guideline, message, target
// note, exercise cue, coaching style, coach method and session recap reach the model request.
// Without that grant, or when the read fails, none of them does, and P1 still gets an answer from
// their own data. The live ledger states (never asked, "Not now", turned off) are in
// test/rls/coach-text-egress-rls.spec.ts.

import 'reflect-metadata';
import { makeWorld, runTurn, student, withRomanEnabled, type TurnResult } from './harness';
import { COACH_A, LOCAL_TODAY_PT, NOW, P1 } from '../fixtures/roman-personas';

withRomanEnabled();
// The fixtures' NOW (2026-09-30 17:30 PT), so "today" and the next session are fixed.
beforeEach(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
});
afterEach(() => jest.useRealTimers());
const FLAGS = ['FEATURE_ROMAN_TOOLS', 'FEATURE_ROMAN_PLAYBOOK'];
const saved = FLAGS.map((f) => process.env[f]);
beforeEach(() => FLAGS.forEach((f) => (process.env[f] = 'true')));
afterEach(() =>
  FLAGS.forEach((f, i) => {
    if (saved[i] === undefined) delete process.env[f];
    else process.env[f] = saved[i];
  }),
);

type Part = 'client_data' | 'system' | 'history tool';
/** Each coach source, the part of the request that carries it, and its words in the fixtures. */
const SOURCES: ReadonlyArray<readonly [string, Part, string]> = [
  ['guideline', 'client_data', 'Keep dairy out'],
  ['message', 'client_data', 'Great week Maya'],
  ['target note', 'client_data', 'Protein first at breakfast'],
  ['exercise cue', 'client_data', 'Chest tall, knees track toes'],
  ['coaching style', 'client_data', '"coaching_style"'],
  ['coach method', 'system', 'Goblet squat instead of Back squat'],
  ['message', 'history tool', 'Great week Maya'],
  ['session recap', 'history tool', 'Deload next week'],
];
const GATES = ['allowed', 'no grant', 'read error'] as const;
type Gate = (typeof GATES)[number];
const OWN = 'Thanks Alex, knee felt fine';
const REPLY = 'Keep logging your meals this week.';
const SQUATS = { coach_id: COACH_A.id, version: 1, status: 'active', red_lines: [],
  sections: { exercises: { substitutions: [{ for: 'Back squat', use: 'Goblet squat', when: 'knees ache', basis: 'observed', evidence_count: 4 }] } } };

type Block = { type?: string; content?: unknown };
const toolText = (t: TurnResult) =>
  ((t.calls[t.calls.length - 1]?.body.messages ?? []) as Array<{ content: unknown }>)
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]) : []))
    .filter((b) => b.type === 'tool_result')
    .map((b) => String(b.content))
    .join('\n');

async function turn(gate: Gate): Promise<{ reply: string } & Record<Part, string>> {
  const w = makeWorld(undefined, { tools: true, augmenters: true });
  const maya = w.db.raw.users.find((u) => u.id === P1);
  if (!maya) throw new Error('fixture: P1 missing');
  maya.coach = { ...COACH_A, coach_profile: { coaching_touch: 'close', programming_style: null } };
  w.r11.playbooks.push(SQUATS);
  w.db.raw.coachingSessions.push({ id: 'cs-recap', coach_id: COACH_A.id, client_id: P1, title: 'Review',
    status: 'completed', start_at: new Date('2026-09-28T17:00:00Z'), end_at: new Date('2026-09-28T17:45:00Z'),
    client_recap_md: 'Deload next week' });
  if (gate === 'no grant') w.consent.coachesWithout.add(COACH_A.id);
  if (gate === 'read error') {
    w.consent.hasCoachAiConsent = async () => {
      throw new Error('ledger down');
    };
  }
  const input = { kinds: ['message', 'booking'], from: '2026-09-24', to: LOCAL_TODAY_PT };
  const t = await runTurn(w, { persona: 'P1', question: 'How did my week go?' }, {
    script: [{ tool_use: [{ name: 'read_history', input }] }, REPLY],
  });
  return { reply: t.reply, client_data: t.clientData ?? '', system: t.staticSystem ?? '', 'history tool': toolText(t) };
}
const turns = new Map<Gate, ReturnType<typeof turn>>();
const turnOf = (gate: Gate) => turns.get(gate) ?? turns.set(gate, turn(gate)).get(gate)!;

describe("COACH-TEXT: a coach's own words in a client turn follow that coach's AI grant", () => {
  const TABLE = GATES.flatMap((gate) => SOURCES.map(([source, part, words]) => [gate, source, part, words] as const));

  it.each(TABLE)('%s: the coach %s in the %s', async (gate, _s, part, words) => {
    const t = await turnOf(gate);
    expect(t[part].includes(words)).toBe(gate === 'allowed');
  });

  it.each(GATES)('%s: Roman still answers, with the client’s own words', async (gate) => {
    const t = await turnOf(gate);
    expect(t.reply).toBe(REPLY);
    expect(t.client_data).toContain(OWN);
    expect(t['history tool']).toContain(OWN);
  });

  it('a context memo entry built while the coach allowed AI is not reused once they turn it off', async () => {
    const w = makeWorld();
    expect((await w.ctx.getBundle(student(P1), NOW)).rendered).toContain('Keep dairy out');
    expect((await w.ctx.getBundle(student(P1), NOW)).rendered).toContain('Keep dairy out');
    w.consent.coachesWithout.add(COACH_A.id);
    const after = await w.ctx.getBundle(student(P1), NOW);
    expect(after.rendered).not.toContain('Keep dairy out');
    expect(after.rendered).toContain(OWN);
  });
});
