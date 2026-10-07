/**
 * Roman v1.1 R11-P3b-2: playbook builder and schedule.
 *
 * Pins: flag off -> no reads, no spend, no call, no timer; same digest -> no
 * call; spend refused -> no call; invalid or fully-dropped draft -> no write;
 * v1 then v2 supersedes; memory-scope subject with consented clients and the
 * coach's own scope without; spend settled on every path after a call.
 */
import type { PrismaService } from '../../src/prisma.service';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { AiEgressService, AnthropicHandle } from '../../src/ai-egress/ai-egress.service';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import { ROMAN_MODEL_PHASE_1 } from '../../src/roman/anthropic-client.provider';
import type { RomanBackgroundSpendService } from '../../src/roman/background/roman-background-spend';
import { buildPlaybookRoster } from '../../src/roman/playbook/playbook-scrub';
import type { PlaybookSourceCollector, PlaybookSources } from '../../src/roman/playbook/playbook-sources';
import { PlaybookBuilderService, parsePlaybookReply } from '../../src/roman/playbook/playbook-builder.service';
import { PlaybookBuilderScheduler } from '../../src/roman/playbook/playbook-builder.scheduler';

type Row = Record<string, any>;
const H = 'coach-head-7f3a';
const NOW = new Date('2026-10-07T12:00:00.000Z');
const RESERVATION = { requestId: 'roman-bg:1', capability: 'roman.playbook', model: ROMAN_MODEL_PHASE_1, poolCoachId: null };

const DRAFT = {
  sections: {
    training: { progression: [{ text: 'Add load once every set reaches the top of the rep range.', basis: 'observed', evidence_count: 4 }] },
    recovery: { sleep_target: [{ text: 'Eight hours of sleep a night.', basis: 'stated', evidence_count: 2 }] },
  },
  red_lines: [{ kind: 'no_train_through_pain', text: 'Never train through sharp pain.', basis: 'stated', evidence_count: 3 }],
};

function sources(over: Partial<PlaybookSources> = {}): PlaybookSources {
  return {
    headCoachId: H,
    roster: buildPlaybookRoster([{ name: 'Zelda Quill' }]),
    items: [
      { kind: 'guideline', id: 'g-wide', text: 'Always a ten minute warm up.', private: false },
      { kind: 'session_note', id: 'sn-1', text: '[NAME] should rest two full days after every heavy leg session.', private: true },
    ],
    ledger: [
      { source_kind: 'guideline', source_id: 'g-wide' },
      { source_kind: 'session_note', source_id: 'sn-1', client_id: 'client-aa11' },
    ],
    digest: 'digest-1',
    consentedClientIds: ['client-aa11'],
    signals: { version: 'pbs-v1', team_size: 1, top_exercises: [], schedule: null, adjustments: [], substitutions: [], macros: null, meals: null },
    ...over,
  };
}

function harness(opts: { src?: PlaybookSources; reply?: string; admitted?: boolean; sendError?: Error } = {}) {
  const playbooks: Row[] = [];
  const sourceRows: Row[] = [];
  let src = opts.src ?? sources();
  const pick = (where: Row) => playbooks.filter((p) => p.coach_id === where.coach_id && (!where.status || p.status === where.status));
  const coachPlaybook = {
    findFirst: jest.fn(async (a: Row) => [...pick(a.where)].sort((x, y) => y.version - x.version)[0] ?? null),
    findMany: jest.fn(async (a: Row) => playbooks.filter((p) => a.where.coach_id.in.includes(p.coach_id) && p.status === a.where.status)),
    updateMany: jest.fn(async (a: Row) => {
      for (const p of pick(a.where)) Object.assign(p, a.data);
      return { count: 1 };
    }),
    create: jest.fn(async (a: Row) => {
      const row = { id: `pb-${playbooks.length + 1}`, ...a.data };
      playbooks.push(row);
      return { id: row.id };
    }),
  };
  const coachPlaybookSource = { createMany: jest.fn(async (a: Row) => sourceRows.push(...a.data)) };
  const tx = { coachPlaybook, coachPlaybookSource };
  const prisma = Object.assign(Object.create(null) as PrismaService, {
    user: { findMany: jest.fn(async () => [{ coach_id: H }]) },
    coachPlaybook,
    $transaction: jest.fn(async (fn: (t: Row) => Promise<unknown>) => fn(tx)),
  });
  const budget = Object.assign(Object.create(null) as CoachAIBudgetService, {
    resolveHeadCoachId: jest.fn(async (id: string) => id),
  });
  const egress = Object.assign(Object.create(null) as AiEgressService, {
    anthropicMessagesCreate: jest.fn(async (..._args: unknown[]) => {
      if (opts.sendError) throw opts.sendError;
      return { content: [{ type: 'text', text: opts.reply ?? JSON.stringify(DRAFT) }], usage: { input_tokens: 1000, output_tokens: 200 } };
    }),
  });
  const collector = Object.assign(Object.create(null) as PlaybookSourceCollector, { collect: jest.fn(async () => src) });
  const spend = Object.assign(Object.create(null) as RomanBackgroundSpendService, {
    reserve: jest.fn(async () =>
      opts.admitted === false ? { admitted: false, reason: 'cap_reached' } : { admitted: true, reservation: RESERVATION }),
    settle: jest.fn(async () => undefined),
  });
  const handle = Object.create(AnthropicHandle.prototype) as AnthropicHandle;
  const svc = new PlaybookBuilderService(prisma, budget, egress, collector, spend, handle);
  return { svc, prisma, egress, collector, spend, playbooks, sourceRows, setSrc: (s: PlaybookSources) => (src = s) };
}

describe('R11-P3b-2 playbook builder', () => {
  const prev = process.env.FEATURE_ROMAN_PLAYBOOK;
  beforeEach(() => {
    process.env.FEATURE_ROMAN_PLAYBOOK = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.FEATURE_ROMAN_PLAYBOOK;
    else process.env.FEATURE_ROMAN_PLAYBOOK = prev;
  });

  it('flag off: no reads, no spend, no provider call', async () => {
    delete process.env.FEATURE_ROMAN_PLAYBOOK;
    const h = harness();
    expect(await h.svc.runOnce(NOW)).toEqual({ coaches: 0, outcomes: {} });
    expect(h.prisma.user.findMany).not.toHaveBeenCalled();
    expect(h.collector.collect).not.toHaveBeenCalled();
    expect(h.spend.reserve).not.toHaveBeenCalled();
    expect(h.egress.anthropicMessagesCreate).not.toHaveBeenCalled();
  });

  it('builds v1 with a memory-scope subject, settles the spend and stores the ledger', async () => {
    const h = harness();
    expect(await h.svc.runOnce(NOW)).toEqual({ coaches: 1, outcomes: { built: 1 } });
    expect(h.spend.reserve).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'roman.playbook', payer: { kind: 'platform', coachId: H }, model: ROMAN_MODEL_PHASE_1,
    }));
    // PB-POOL: the platform pays playbook learning, never the head coach's AI credits.
    expect(h.spend.reserve).not.toHaveBeenCalledWith(expect.objectContaining({ payer: expect.objectContaining({ kind: 'coach' }) }));
    const [, subject, surface, params] = h.egress.anthropicMessagesCreate.mock.calls[0];
    expect(subject).toEqual({ kind: 'client_data', clientIds: ['client-aa11'], audience: 'coach', scope: 'memory' });
    expect(surface).toBe('roman.playbook');
    expect(JSON.stringify(params)).not.toMatch(/g-wide|sn-1|client-aa11|Zelda/);
    expect(h.spend.settle).toHaveBeenCalledWith(RESERVATION, 1000, 200, { outcome: 'ok' });
    expect(h.playbooks).toEqual([expect.objectContaining({
      coach_id: H, version: 1, status: 'active', source_count: 2, source_digest: 'digest-1', model_id: ROMAN_MODEL_PHASE_1,
    })]);
    expect(h.playbooks[0].red_lines).toEqual(DRAFT.red_lines);
    expect(h.sourceRows).toEqual([
      { playbook_id: 'pb-1', coach_id: H, client_id: null, source_kind: 'guideline', source_id: 'g-wide' },
      { playbook_id: 'pb-1', coach_id: H, client_id: 'client-aa11', source_kind: 'session_note', source_id: 'sn-1' },
    ]);
  });

  it('same digest: no spend and no call; a new digest builds v2 and supersedes v1', async () => {
    const h = harness();
    await h.svc.buildFor(H, NOW);
    expect(await h.svc.buildFor(H, NOW)).toBe('unchanged');
    expect(h.egress.anthropicMessagesCreate).toHaveBeenCalledTimes(1);
    expect(h.spend.reserve).toHaveBeenCalledTimes(1);
    h.setSrc(sources({ digest: 'digest-2' }));
    expect(await h.svc.buildFor(H, NOW)).toBe('built');
    expect(h.playbooks.map((p) => [p.version, p.status])).toEqual([[1, 'superseded'], [2, 'active']]);
  });

  it('spend refused: no provider call, no write', async () => {
    const h = harness({ admitted: false });
    expect(await h.svc.buildFor(H, NOW)).toBe('not_admitted');
    expect(h.egress.anthropicMessagesCreate).not.toHaveBeenCalled();
    expect(h.playbooks).toEqual([]);
  });

  it('consent refused at send: settles zero, no write', async () => {
    const h = harness({ sendError: new AiConsentRequiredException('coach') });
    expect(await h.svc.buildFor(H, NOW)).toBe('refused');
    expect(h.spend.settle).toHaveBeenCalledWith(RESERVATION, 0, 0, { outcome: 'refused' });
    expect(h.playbooks).toEqual([]);
  });

  it('invalid or fully dropped draft: spend settled, nothing written', async () => {
    for (const reply of ['no json here', JSON.stringify({ sections: { diet: { bogus: [] } }, red_lines: [] })]) {
      const h = harness({ reply });
      expect(await h.svc.buildFor(H, NOW)).toBe('invalid_draft');
      expect(h.spend.settle).toHaveBeenCalledTimes(1);
      expect(h.playbooks).toEqual([]);
    }
    const quoted = { sections: { recovery: { rest_days: [{ text: 'Should rest two full days after every heavy leg session.', basis: 'stated', evidence_count: 1 }] } }, red_lines: [] };
    const h = harness({ reply: JSON.stringify(quoted) });
    expect(await h.svc.buildFor(H, NOW)).toBe('empty_draft');
    expect(h.playbooks).toEqual([]);
  });

  it('no memory-scope client: coach-own-scope send; a client row without consent stops before spend', async () => {
    const own = harness({ src: sources({ consentedClientIds: [], items: [sources().items[0]], ledger: [sources().ledger[0]] }) });
    expect(await own.svc.buildFor(H, NOW)).toBe('built');
    expect(own.egress.anthropicMessagesCreate.mock.calls[0][1]).toEqual({ kind: 'no_client_data', reason: 'coach_own_scope' });
    const unsafe = harness({ src: sources({ consentedClientIds: [] }) });
    expect(await unsafe.svc.buildFor(H, NOW)).toBe('unsafe_ledger');
    expect(unsafe.spend.reserve).not.toHaveBeenCalled();
    expect(unsafe.egress.anthropicMessagesCreate).not.toHaveBeenCalled();
  });

  it('parsePlaybookReply reads a fenced object and rejects non-JSON', () => {
    expect(parsePlaybookReply('```json\n{"red_lines": []}\n```')).toEqual({ red_lines: [] });
    expect(parsePlaybookReply('{not json}')).toBeNull();
  });
});

describe('R11-P3b-2 playbook schedule', () => {
  afterEach(() => {
    delete process.env.FEATURE_ROMAN_PLAYBOOK;
    jest.useRealTimers();
  });

  it('flag off: no boot timer and the 6-hourly tick does nothing', async () => {
    delete process.env.FEATURE_ROMAN_PLAYBOOK;
    const runOnce = jest.fn(async () => ({ coaches: 0, outcomes: {} }));
    const sched = new PlaybookBuilderScheduler(Object.assign(Object.create(null) as PlaybookBuilderService, { runOnce }));
    jest.useFakeTimers();
    sched.onApplicationBootstrap();
    jest.advanceTimersByTime(4 * 60 * 1000);
    await sched.tick();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('flag on: runs 3 minutes after boot and on each tick', async () => {
    process.env.FEATURE_ROMAN_PLAYBOOK = 'true';
    const runOnce = jest.fn(async () => ({ coaches: 0, outcomes: {} }));
    const sched = new PlaybookBuilderScheduler(Object.assign(Object.create(null) as PlaybookBuilderService, { runOnce }));
    jest.useFakeTimers();
    sched.onApplicationBootstrap();
    jest.advanceTimersByTime(2 * 60 * 1000);
    expect(runOnce).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60 * 1000 + 1);
    expect(runOnce).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    await sched.tick();
    expect(runOnce).toHaveBeenCalledTimes(2);
    sched.onModuleDestroy();
  });
});
