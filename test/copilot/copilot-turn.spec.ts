import { Prisma } from '@prisma/client';
import {
  CopilotTurnService,
  copilotChange,
  copilotSection,
  splitCopilotReply,
  type CopilotFacts,
} from '../../src/copilot/copilot-turn';
import { CopilotService } from '../../src/copilot/copilot.service';
import { ConsentScope } from '../../src/consent/consent.service';

// COPILOT-BE2: the numbered facts, the prompt section, the suggestion line and the client's own reads.
const NOW = new Date('2026-10-21T17:00:00Z'); // Wed 21 Oct, 10:00 in Los Angeles
const T1 = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const ALL = new Set([ConsentScope.FITNESS_BODY_METRICS, ConsentScope.FITNESS_FOOD_MACROS, ConsentScope.FITNESS_WORKOUTS]);

const ctx = {
  identity: { timezone: 'America/Los_Angeles', local_date: '2026-10-21' },
  coach: { coach_first_name: 'Alex' },
  weight_trend: { points: [{ date: '2026-10-04', weight_lbs: 157.9 }, { date: '2026-10-18', weight_lbs: 157.4 }] },
  last_7_days: { days_logged: 6, avg_kcal_on_logged_days: 2260 },
  plan: { adherence_14d: { completed: 7, scheduled: 8 } },
  macro_method: { floor_kcal: 1500 },
} as never;

function build(opts: { coach?: string | null; granted?: Set<string> } = {}) {
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ coach_id: opts.coach === undefined ? 'coach-k' : opts.coach, weight_unit: 'kg' })) },
    macroTarget: {
      findMany: jest.fn(async () => [
        { id: T1, coach_id: 'coach-k', calories_kcal: 2150, effective_from: new Date('2026-10-19T07:00:00Z') },
        { id: 'old', coach_id: 'coach-k', calories_kcal: 2300, effective_from: new Date('2026-09-28T07:00:00Z') },
      ]),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(async () => [{ id: A1, scheduled_for: new Date('2026-10-22T16:00:00Z'), snapshot: null, workout_plan: { name: 'Lower body B' } }]),
    },
    aiActionDraft: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, decision_note: null, decided_at: null, created_at: NOW })),
      findMany: jest.fn(async () => [] as unknown[]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const consent = { grantedScopesByClient: jest.fn(async () => new Map([['client-a', opts.granted ?? ALL]])) };
  return { prisma, consent, svc: new CopilotTurnService(prisma as never, consent as never) };
}

describe('CopilotTurnService.facts (CP-A-17)', () => {
  it('writes every fact from the client’s own rows, numbered, in the client’s unit and zone', async () => {
    const { svc, consent } = build();
    const f = await svc.facts('client-a', ctx, NOW);
    expect(consent.grantedScopesByClient).toHaveBeenCalledWith('coach-k', ['client-a'], [...ALL]);
    expect(f.sources).toEqual([
      { n: 1, kind: 'plan', id: T1, date: '2026-10-19', label: 'Target 2,150 kcal from Mon 19 Oct, set by Alex', detail: 'Was 2,300 kcal' },
      { n: 2, kind: 'check_in', id: null, date: '2026-10-18', label: '71.4 kg on Sun 18 Oct', detail: '71.6 kg on Sun 4 Oct' },
      { n: 3, kind: 'food_log', id: null, date: '2026-10-21', label: '2,260 kcal a day over the last 7 days', detail: '6 of 7 days logged' },
      { n: 4, kind: 'workout_log', id: null, date: '2026-10-21', label: '7 of 8 sessions done', detail: 'Last 14 days' },
    ]);
    expect(f.sessions).toEqual([{ assignment_id: A1, workout: 'Lower body B', at: new Date('2026-10-22T16:00:00Z') }]);
    expect(f.target).toEqual({ id: T1, kcal: 2150 });
  });

  it('a kind the client does not share with their coach never becomes a fact or a movable session', async () => {
    const { svc, prisma } = build({ granted: new Set([ConsentScope.FITNESS_FOOD_MACROS]) });
    const f = await svc.facts('client-a', ctx, NOW);
    expect(f.sources.map((s) => s.kind)).toEqual(['plan', 'food_log']);
    expect(f.sources.map((s) => s.n)).toEqual([1, 2]);
    expect(f.sessions).toEqual([]);
    expect(prisma.clientWorkoutAssignment.findMany).not.toHaveBeenCalled();
  });

  it('with no coach nothing is shared: only the plan row', async () => {
    const { svc, consent } = build({ coach: null });
    const f = await svc.facts('client-a', ctx, NOW);
    expect(consent.grantedScopesByClient).not.toHaveBeenCalled();
    expect(f.sources.map((s) => s.kind)).toEqual(['plan']);
    expect(f.sources[0].label).toBe('Target 2,150 kcal from Mon 19 Oct');
  });
});

const FACTS: CopilotFacts = {
  sources: [
    { n: 1, kind: 'plan', id: T1, date: '2026-10-19', label: 'Target 2,150 kcal from Mon 19 Oct, set by Alex', detail: null },
    { n: 2, kind: 'workout_log', id: null, date: '2026-10-21', label: '7 of 8 sessions done', detail: 'Last 14 days' },
  ],
  sessions: [{ assignment_id: A1, workout: 'Lower body B', at: new Date('2026-10-22T16:00:00Z') }],
  target: { id: T1, kcal: 2150 },
  floor: 1500,
  tz: 'America/Los_Angeles',
};

describe('the Copilot prompt section and the suggestion line', () => {
  it('lists the facts and the sessions by number, never an id', () => {
    const s = copilotSection(FACTS);
    expect(s).toContain('[1] Plan: Target 2,150 kcal from Mon 19 Oct, set by Alex');
    expect(s).toContain('[2] Workout log: 7 of 8 sessions done');
    expect(s).toContain('S1: Lower body B, Thu 22 Oct (2026-10-22)');
    expect(s).not.toContain(A1);
    expect(s).not.toContain(T1);
  });

  it('takes the suggestion out of the text, closed or cut off, and drops citations of facts that do not exist', () => {
    expect(splitCopilotReply('Friday works [2]. See [7].\n<suggestion>{"kind":"x"}</suggestion>', FACTS)).toEqual({
      text: 'Friday works [2]. See .',
      asked: { kind: 'x' },
    });
    expect(splitCopilotReply('Friday works [1].\n<suggestion>{"kind":"move_', FACTS)).toEqual({ text: 'Friday works [1].', asked: null });
    expect(splitCopilotReply('Ok.<suggestion>not json</suggestion>', FACTS).asked).toBeUndefined();
  });

  it('fills a move from the server’s own session: the model’s ids and times are never used', () => {
    const asked = { kind: 'move_session', session: 'S1', to: '2026-10-23', reason: 'Thursday is busy.', sources: [2, 1, 2, 9], assignment_id: 'evil' };
    const sources = [{ kind: 'workout_log', id: null, date: '2026-10-21', label: '7 of 8 sessions done' }, { kind: 'plan', id: T1, date: '2026-10-19', label: FACTS.sources[0].label }];
    expect(copilotChange(asked, FACTS, NOW)).toEqual({
      reason: 'Thursday is busy.',
      change: { kind: 'move_session', assignment_id: A1, workout: 'Lower body B', from_at: '2026-10-22T16:00:00.000Z', to_at: '2026-10-23T16:00:00.000Z', sources },
    });
  });

  it.each([
    ['an unknown session', { kind: 'move_session', session: 'S4', to: '2026-10-23', reason: 'r' }],
    ['the same day', { kind: 'move_session', session: 'S1', to: '2026-10-22', reason: 'r' }],
    ['a day outside the move window', { kind: 'move_session', session: 'S1', to: '2026-11-20', reason: 'r' }],
    ['no reason', { kind: 'move_session', session: 'S1', to: '2026-10-23' }],
    ['a target under the floor', { kind: 'set_calorie_target', to_kcal: 1200, reason: 'r' }],
    ['the target the client already has', { kind: 'set_calorie_target', to_kcal: 2150, reason: 'r' }],
    ['an unknown kind', { kind: 'delete_plan', reason: 'r' }],
  ])('offers nothing for %s', (_name, asked) => {
    expect(copilotChange(asked, FACTS, NOW)).toBeNull();
  });

  it('a new calorie target is filled from the current target row', () => {
    const sources = [{ kind: 'plan', id: T1, date: '2026-10-19', label: FACTS.sources[0].label }];
    expect(copilotChange({ kind: 'set_calorie_target', to_kcal: 2000, reason: 'Weight is flat.', sources: [1] }, FACTS, NOW)?.change).toEqual({ kind: 'set_calorie_target', target_id: T1, from_kcal: 2150, to_kcal: 2000, sources });
  });
});

describe('the client’s own suggestion rows', () => {
  const change = copilotChange({ kind: 'set_calorie_target', to_kcal: 2000, reason: 'Weight is flat.', sources: [1] }, FACTS, NOW)!;

  it('stores the suggestion unsent, with no tenant coach, expiring with the pending window', async () => {
    const { svc, prisma } = build();
    const view = await svc.saveSuggestion('d-1', 'client-a', 's-1', change, NOW);
    const expires_at = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    const row = { id: 'd-1', capability: 'client_path_change', status: 'suggested', requester_id: 'client-a', subject_user_id: 'client-a', tenant_coach_id: null };
    expect(prisma.aiActionDraft.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ...row, rationale: 'Weight is flat.', provenance: { roman_session_id: 's-1' }, expires_at }) });
    expect(view).toMatchObject({ id: 'd-1', status: 'suggested', sent_at: null, reason: 'Weight is flat.' });
  });

  it('a failed write offers no suggestion instead of failing the turn', async () => {
    const { svc, prisma } = build();
    prisma.aiActionDraft.create.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'P2003' }));
    await expect(svc.saveSuggestion('d-1', 'client-a', 's-1', change, NOW)).resolves.toBeNull();
  });

  it('deleting a chat deletes only that chat’s unsent suggestions', async () => {
    const { svc, prisma } = build();
    await svc.forgetUnsent(prisma as never, 'client-a', 's-1');
    expect(prisma.aiActionDraft.deleteMany).toHaveBeenCalledWith({
      where: { capability: 'client_path_change', status: 'suggested', requester_id: 'client-a', provenance: { path: ['roman_session_id'], equals: 's-1' } },
    });
  });

  it('message views read only suggestions the caller made about themselves', async () => {
    const { svc, prisma } = build();
    prisma.aiActionDraft.findMany.mockResolvedValueOnce([
      { id: 'd-1', status: 'approved', payload: {}, rationale: 'r', decision_note: null, created_at: NOW, decided_at: NOW, expires_at: NOW, capability: 'client_path_change' },
    ]);
    const stored = { question_id: 'q', sources: FACTS.sources, suggestion_id: 'd-1' };
    const views = await svc.views('client-a', [{ id: 'm-1', copilot: stored }, { id: 'm-2', copilot: null }]);
    expect(prisma.aiActionDraft.findMany).toHaveBeenCalledWith({ where: { id: { in: ['d-1'] }, capability: 'client_path_change', requester_id: 'client-a', subject_user_id: 'client-a' } });
    expect([...views.keys()]).toEqual(['m-1']);
    expect(views.get('m-1')).toMatchObject({ sources: FACTS.sources, suggestion: { id: 'd-1', status: 'approved' } });
  });
});

describe('CopilotService week block and past questions', () => {
  const REPLIES = [
    { id: 'm-2', session_id: 's-2', created_at: NOW, copilot: { question_id: 'q-2', sources: [], suggestion_id: 'd-1' } },
    { id: 'm-1', session_id: 's-1', created_at: NOW, copilot: { question_id: 'q-1', sources: [], suggestion_id: null } },
  ];
  const QUESTIONS = [{ id: 'q-2', content: 'Can I move Thursday?' }, { id: 'q-1', content: 'Why did my calories change this week?' }];
  function service() {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ coach_joined_at: new Date(NOW.getTime() - 15 * 86_400_000), coach: { name: 'Alex Morgan' }, notification_prefs: { timezone: 'America/Los_Angeles' } })) },
      macroTarget: { findMany: jest.fn(async () => [{ calories_kcal: 2150, effective_from: new Date('2026-10-19T07:00:00Z') }, { calories_kcal: 2300 }]) },
      clientWorkoutAssignment: { findMany: jest.fn(async () => [{ completed_at: NOW }, { completed_at: null }, { completed_at: null }, { completed_at: null }]) },
      checkIn: { findFirst: jest.fn(async () => ({ date: new Date('2026-10-18T00:00:00Z') })) },
      romanMessage: {
        findMany: jest.fn(async (a: { where: { role?: string } }) => (a.where.role === 'roman' ? REPLIES : QUESTIONS)),
        count: jest.fn(async () => 186),
        findFirst: jest.fn(async () => ({ created_at: new Date('2025-10-02T17:00:00Z') })),
      },
      aiActionDraft: { findMany: jest.fn(async () => [{ id: 'd-1', status: 'rejected', expires_at: null, created_at: NOW }]) },
    };
    return { prisma, svc: new CopilotService(prisma as never) };
  }

  it('the week block: week n with the coach, the target and the one before, this local week’s workouts, the last check-in', async () => {
    const { svc, prisma } = service();
    await expect(svc.week('client-a', NOW)).resolves.toEqual({
      number: 3,
      coach_first_name: 'Alex',
      target: { kcal: 2150, from: new Date('2026-10-19T07:00:00Z'), previous_kcal: 2300 },
      workouts: { done: 1, total: 4 },
      last_check_in: '2026-10-18',
    });
    // Monday 19 Oct to Monday 26 Oct, local midnight to local midnight.
    expect(prisma.clientWorkoutAssignment.findMany).toHaveBeenCalledWith({
      where: { client_id: 'client-a', scheduled_for: { gte: new Date('2026-10-19T07:00:00Z'), lt: new Date('2026-10-26T07:00:00Z') } },
      select: { completed_at: true },
    });
    expect(prisma.macroTarget.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ client_id: 'client-a' }) }));
    expect(prisma.checkIn.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id: 'client-a' } }));
  });

  it('past questions: only the caller’s Copilot replies, their questions and outcomes, with the total and the first ask', async () => {
    const { svc, prisma } = service();
    const out = await svc.questions('client-a');
    const mine = { user_id: 'client-a', role: 'roman', copilot: { not: Prisma.DbNull }, session: { deleted_at: null } };
    expect(prisma.romanMessage.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: mine, take: 21 }));
    expect(prisma.romanMessage.count).toHaveBeenCalledWith({ where: mine });
    expect(prisma.romanMessage.findMany).toHaveBeenNthCalledWith(2, { where: { user_id: 'client-a', id: { in: ['q-2', 'q-1'] } }, select: { id: true, content: true } });
    expect(prisma.aiActionDraft.findMany).toHaveBeenCalledWith({ where: { capability: 'client_path_change', requester_id: 'client-a', subject_user_id: 'client-a', id: { in: ['d-1'] } } });
    expect(out).toEqual({
      items: [
        { question: 'Can I move Thursday?', asked_at: NOW, session_id: 's-2', message_id: 'm-2', outcome: 'rejected' },
        { question: 'Why did my calories change this week?', asked_at: NOW, session_id: 's-1', message_id: 'm-1', outcome: null },
      ],
      total: 186,
      since: new Date('2025-10-02T17:00:00Z'),
      next_cursor: null,
    });
  });
});
