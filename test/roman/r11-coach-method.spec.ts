// test/roman/r11-coach-method.spec.ts
//
// Roman v1.1 slice R11-P4: the coach-method block in a client's turn (behind
// FEATURE_ROMAN_PLAYBOOK), only from the active playbook of the head coach of
// the client's CURRENT live coach, re-validated before use; the coach surface
// never gets it. In-memory doubles only.

import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { MODULE_METADATA } from '@nestjs/common/constants';
import {
  COACH_METHOD_CACHE_TTL_MS,
  COACH_METHOD_HEADING,
  COACH_METHOD_INSTRUCTION,
  COACH_METHOD_SECTION_ITEMS_MAX,
  RomanCoachMethodAugmenter,
} from '../../src/roman/playbook/roman-coach-method.augmenter';
import { ROMAN_COACH_METHOD_AUGMENTER } from '../../src/roman/augment/roman-turn-augmenter';
import { FEATURE_ROMAN_PLAYBOOK_ENV } from '../../src/roman/playbook/roman-playbook.feature';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import type { PrismaService } from '../../src/prisma.service';
import { RomanModule } from '../../src/roman/roman.module';
import { RomanService } from '../../src/roman/roman.service';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import { AnthropicHandle, type AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { _resetRomanContextListeners } from '../../src/roman/context/roman-context-invalidation';
import { makePersonaDb, FakeSafetyIntakeSource, NOW, LOCAL_TODAY_PT, P1, COACH_A } from './fixtures/roman-personas';

// ─── doubles ─────────────────────────────────────────────────────────────────

type Coach = { id: string; role: string; deleted_at: Date | null };
type UserRow = { role: string; coach: Coach | null };
type PlaybookRow = { coach_id: string; version: number; status: string; sections: unknown; red_lines: unknown };

const item = (text: string, basis: 'stated' | 'observed' = 'observed', evidence_count = 3) => ({ text, basis, evidence_count });

function playbook(coach_id: string, version: number, marker: string, status = 'active'): PlaybookRow {
  return {
    coach_id,
    version,
    status,
    sections: {
      exercises: {
        go_to: [item(`${marker} trap-bar deadlift as the main hinge`)],
        substitutions: [{ for: 'Back squat', use: 'Goblet squat', when: 'knees ache', basis: 'observed', evidence_count: 4 }],
      },
      training: { progression: [item('Add a rep each week, then add load')] },
      diet: { protein: [item('Protein at every meal', 'stated')] },
      recovery: { sleep_target: [item('Eight hours in bed')] },
    },
    red_lines: [{ kind: 'no_train_through_pain', text: 'Never train through sharp pain', basis: 'stated', evidence_count: 2 }],
  };
}

const CLIENT = 'client-1';
const BUNDLE = fakeOf<RomanClientContextBundle>({});
const student = { id: CLIENT, role: 'student' };
const coach = (id: string, deleted_at: Date | null = null): Coach => ({ id, role: 'coach', deleted_at });

type HarnessOpts = { users?: Record<string, UserRow>; playbooks?: PlaybookRow[]; heads?: Record<string, string>; noBudget?: boolean };
function harness(opts: HarnessOpts) {
  const users: Record<string, UserRow> = opts.users ?? { [CLIENT]: { role: 'student', coach: coach('coach-A') } };
  const playbooks = opts.playbooks ?? [];
  const prisma = {
    user: { findUnique: jest.fn(async (a: { where: { id: string } }) => users[a.where.id] ?? null) },
    coachPlaybook: {
      findFirst: jest.fn(async (a: { where: { coach_id: string; status: string; version?: number } }) => {
        const w = a.where;
        const rows = playbooks.filter(
          (p) => p.coach_id === w.coach_id && p.status === w.status && (w.version === undefined || p.version === w.version),
        );
        return rows.sort((x, y) => y.version - x.version)[0] ?? null;
      }),
    },
  };
  const budget = { resolveHeadCoachId: jest.fn(async (id: string) => opts.heads?.[id] ?? id) };
  const augmenter = new RomanCoachMethodAugmenter(
    fakeOf<PrismaService>(prisma),
    opts.noBudget ? null : fakeOf<CoachAIBudgetService>(budget),
  );
  const run = (caller: { id: string; role: string } = student) => augmenter.augment(caller, BUNDLE, 'hi');
  return { prisma, users, playbooks, augmenter, run };
}
const only = (...playbooks: PlaybookRow[]) => harness({ playbooks }).run();

let savedPlaybookFlag: string | undefined;
beforeEach(() => {
  savedPlaybookFlag = process.env[FEATURE_ROMAN_PLAYBOOK_ENV];
  process.env[FEATURE_ROMAN_PLAYBOOK_ENV] = 'true';
});
afterEach(() => {
  jest.restoreAllMocks();
  if (savedPlaybookFlag === undefined) delete process.env[FEATURE_ROMAN_PLAYBOOK_ENV];
  else process.env[FEATURE_ROMAN_PLAYBOOK_ENV] = savedPlaybookFlag;
});

// ─── the augmenter ───────────────────────────────────────────────────────────

describe('R11-P4 RomanCoachMethodAugmenter', () => {
  it('flag off (unset, false, 1): null and no read', async () => {
    for (const v of [undefined, 'false', '1']) {
      if (v === undefined) delete process.env[FEATURE_ROMAN_PLAYBOOK_ENV];
      else process.env[FEATURE_ROMAN_PLAYBOOK_ENV] = v;
      const h = harness({ playbooks: [playbook('coach-A', 1, 'A')] });
      expect(await h.run()).toBeNull();
      expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(h.prisma.coachPlaybook.findFirst).not.toHaveBeenCalled();
    }
  });

  it('renders heading, instruction, items per section, red lines as rules and post-check phrases', async () => {
    const out = await only(playbook('coach-A', 1, 'COACH-A'));
    if (!out) throw new Error('expected a block');
    const lines = out.block.split('\n');
    expect(lines.slice(0, 3)).toEqual([COACH_METHOD_HEADING, COACH_METHOD_INSTRUCTION, '<coach_method>']);
    expect(lines[lines.length - 1]).toBe('</coach_method>');
    for (const want of [
      'Exercises:\n- Go to: COACH-A trap-bar deadlift as the main hinge',
      '- Swap: Goblet squat instead of Back squat (knees ache)',
      'Training:\n- Progression: Add a rep each week, then add load',
      'Nutrition:\n- Protein: Protein at every meal',
      'Recovery:\n- Sleep: Eight hours in bed',
      'Rules this coach never breaks:\n- Never train through sharp pain',
    ])
      expect(out.block).toContain(want);
    expect(out.post_check).toEqual({ red_lines: ['Never train through sharp pain'] });
    expect(out.hash).toBe(createHash('sha256').update(out.block).digest('hex'));
    expect(out.estimated_tokens).toBe(Math.ceil(out.block.length / 4));
    expect(COACH_METHOD_INSTRUCTION).toMatch(/never quote the coach’s notes/);
  });

  it('caps each section at 12 items, stated first then the strongest evidence', async () => {
    const pb = playbook('coach-A', 1, 'A');
    const observed = (from: number) => Array.from({ length: 6 }, (_, i) => item(`Observed ${from + i}`, 'observed', from + i));
    pb.sections = { training: { split: observed(0), frequency: observed(6), progression: [item('Add a rep', 'stated', 0)] } };
    pb.red_lines = [];
    const out = await only(pb);
    const rendered = (out?.block ?? '').split('\n').filter((l) => l.startsWith('- '));
    expect(rendered).toHaveLength(COACH_METHOD_SECTION_ITEMS_MAX);
    expect(rendered).toContain('- Progression: Add a rep');
    expect(rendered).not.toContain('- Split: Observed 0');
    expect(out?.post_check).toBeUndefined();
  });

  it('a coach caller, no coach, a deleted coach or no budget service: null', async () => {
    const pbs = [playbook('coach-A', 1, 'A')];
    expect(await harness({ playbooks: pbs }).run({ id: 'coach-A', role: 'coach' })).toBeNull();
    for (const c of [null, coach('coach-A', NOW)])
      expect(await harness({ users: { [CLIENT]: { role: 'student', coach: c } }, playbooks: pbs }).run()).toBeNull();
    expect(await harness({ playbooks: pbs, noBudget: true }).run()).toBeNull();
  });

  it('a sub-coach client gets the head coach’s playbook', async () => {
    const out = await harness({
      users: { [CLIENT]: { role: 'student', coach: coach('coach-sub') } },
      heads: { 'coach-sub': 'coach-head' },
      playbooks: [playbook('coach-sub', 1, 'SUB'), playbook('coach-head', 3, 'HEAD')],
    }).run();
    expect(out?.block).toContain('HEAD trap-bar');
    expect(out?.block).not.toContain('SUB trap-bar');
  });

  it('a former coach’s playbook is never used after reassignment', async () => {
    const h = harness({ playbooks: [playbook('coach-A', 1, 'COACH-A'), playbook('coach-B', 1, 'COACH-B')] });
    expect((await h.run())?.block).toContain('COACH-A');
    h.users[CLIENT] = { role: 'student', coach: coach('coach-B') };
    const after = await h.run();
    expect(after?.block).toContain('COACH-B');
    expect(after?.block).not.toContain('COACH-A');
    h.users[CLIENT] = { role: 'student', coach: coach('coach-C') };
    expect(await h.run()).toBeNull();
  });

  it('a superseded playbook is ignored; the active version is used', async () => {
    expect(await only(playbook('coach-A', 2, 'OLD', 'superseded'))).toBeNull();
    const out = await only(playbook('coach-A', 1, 'V1', 'superseded'), playbook('coach-A', 2, 'V2'));
    expect(out?.block).toContain('V2 trap-bar');
    expect(out?.block).not.toContain('V1 trap-bar');
  });

  it('invalid stored JSON gives no block', async () => {
    const unknownKey = playbook('coach-A', 1, 'A');
    unknownKey.sections = { exercises: { go_to: [item('Fine')] }, secrets: { x: 1 } };
    const badRedLine = playbook('coach-A', 1, 'A');
    badRedLine.red_lines = [{ kind: 'quote_the_notes', text: 'x', basis: 'stated', evidence_count: 1 }];
    const notJson = playbook('coach-A', 1, 'A');
    notJson.sections = 'not an object';
    for (const pb of [unknownKey, badRedLine, notJson]) expect(await only(pb)).toBeNull();
  });

  it('caches the block by (coach, version) for 10 minutes; a new version is read at once', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const h = harness({ playbooks: [playbook('coach-A', 1, 'V1')] });
    const first = await h.run();
    expect(await h.run()).toEqual(first);
    expect(h.prisma.coachPlaybook.findFirst).toHaveBeenCalledTimes(3); // version probe each turn, content once
    h.playbooks[0].status = 'superseded';
    h.playbooks.push(playbook('coach-A', 2, 'V2'));
    expect((await h.run())?.block).toContain('V2 trap-bar');
    now.mockReturnValue(1_000_000 + COACH_METHOD_CACHE_TTL_MS + 1);
    await h.run();
    expect(h.prisma.coachPlaybook.findFirst).toHaveBeenCalledTimes(7);
  });

  it('RomanModule provides the augmenter under its kind token', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    expect(providers).toContainEqual({ provide: ROMAN_COACH_METHOD_AUGMENTER, useClass: RomanCoachMethodAugmenter });
  });
});

// ─── through RomanService ────────────────────────────────────────────────────

describe('R11-P4 coach method through RomanService.streamAssistantTurn', () => {
  const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env[FLAG];
    process.env[FLAG] = 'true';
    _resetRomanContextListeners();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  async function turn(caller: { id: string; role: string }, surface: 'client' | 'coach') {
    const db = makePersonaDb();
    const calls: Array<{ system?: unknown }> = [];
    async function* reply() {
      yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Your plan is on Today.' } };
      yield { type: 'message_delta', usage: { output_tokens: 6 } };
    }
    const stream = jest.fn((body: { system?: unknown }) => {
      calls.push(body);
      return reply();
    });
    const anthropic = { messages: { stream } };
    const method = harness({
      users: { [P1]: { role: 'student', coach: coach(COACH_A.id) }, [COACH_A.id]: { role: 'coach', coach: null } },
      playbooks: [playbook(COACH_A.id, 1, 'METHOD-CANARY')],
    });
    const augment = jest.spyOn(method.augmenter, 'augment');
    const handle = AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic));
    const ctx = new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource());
    const svc = new RomanService(fakeOf(db.prisma), grantAllEgress(), handle, ctx, null, null, [method.augmenter]);
    const session = { id: 's1', user_id: caller.id, surface, day_key: LOCAL_TODAY_PT, message_count: 0, started_at: NOW,
      last_activity_at: NOW, quips_in_session: 0, exclamation_used: false, subject_context_json: null, created_at: NOW,
      updated_at: NOW, deleted_at: null };
    const gen = svc.streamAssistantTurn(caller, session, { userMessage: 'How is my week?' });
    for await (const _ of gen) void _;
    return { system: String(calls[0]?.system ?? ''), augment };
  }

  it('a client turn carries the block after client_data; the coach surface and a coach caller never get it', async () => {
    const client = await turn({ id: P1, role: 'student' }, 'client');
    expect(client.system).toContain(COACH_METHOD_HEADING);
    expect(client.system).toContain('METHOD-CANARY');
    expect(client.system.indexOf('<coach_method>')).toBeGreaterThan(client.system.indexOf('</client_data>'));
    for (const surface of ['coach', 'client'] as const) {
      const c = await turn({ id: COACH_A.id, role: 'coach' }, surface);
      expect(c.augment).not.toHaveBeenCalled();
      expect(c.system).not.toContain(COACH_METHOD_HEADING);
      expect(c.system).not.toContain('METHOD-CANARY');
    }
  });
});
