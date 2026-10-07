// test/roman/r11-coach-method.spec.ts
//
// Roman v1.1 slice R11-P4: the coach-method block in a client's turn
// (behind FEATURE_ROMAN_PLAYBOOK). The block comes only from the active
// playbook of the head coach of the client's CURRENT live coach, re-validated
// before use; the coach surface never gets it. In-memory doubles only.

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
import {
  AnthropicHandle,
  type AnthropicMessagesClient,
} from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { _resetRomanContextListeners } from '../../src/roman/context/roman-context-invalidation';
import {
  makePersonaDb,
  FakeSafetyIntakeSource,
  NOW,
  LOCAL_TODAY_PT,
  P1,
  COACH_A,
} from './fixtures/roman-personas';

// ─── doubles ─────────────────────────────────────────────────────────────────

type Coach = { id: string; role: string; deleted_at: Date | null };
type UserRow = { role: string; coach: Coach | null };
type PlaybookRow = {
  coach_id: string;
  version: number;
  status: string;
  sections: unknown;
  red_lines: unknown;
};

const item = (text: string, basis: 'stated' | 'observed' = 'observed', evidence_count = 3) => ({
  text,
  basis,
  evidence_count,
});

function playbook(coach_id: string, version: number, marker: string, status = 'active'): PlaybookRow {
  return {
    coach_id,
    version,
    status,
    sections: {
      exercises: {
        go_to: [item(`${marker} trap-bar deadlift as the main hinge`)],
        substitutions: [
          { for: 'Back squat', use: 'Goblet squat', when: 'knees ache', basis: 'observed', evidence_count: 4 },
        ],
      },
      training: { progression: [item('Add a rep each week, then add load')] },
      diet: { protein: [item('Protein at every meal', 'stated')] },
      recovery: { sleep_target: [item('Eight hours in bed')] },
    },
    red_lines: [
      { kind: 'no_train_through_pain', text: 'Never train through sharp pain', basis: 'stated', evidence_count: 2 },
    ],
  };
}

const CLIENT = 'client-1';
const coach = (id: string, deleted_at: Date | null = null): Coach => ({ id, role: 'coach', deleted_at });

function harness(opts: {
  users?: Record<string, UserRow>;
  playbooks?: PlaybookRow[];
  heads?: Record<string, string>;
  noBudget?: boolean;
}) {
  const users: Record<string, UserRow> = opts.users ?? {
    [CLIENT]: { role: 'student', coach: coach('coach-A') },
  };
  const playbooks = opts.playbooks ?? [];
  const prisma = {
    user: {
      findUnique: jest.fn(async (args: { where: { id: string } }) => users[args.where.id] ?? null),
    },
    coachPlaybook: {
      findFirst: jest.fn(
        async (args: {
          where: { coach_id: string; status: string; version?: number };
          select: Record<string, boolean>;
        }) => {
          const rows = playbooks
            .filter(
              (p) =>
                p.coach_id === args.where.coach_id &&
                p.status === args.where.status &&
                (args.where.version === undefined || p.version === args.where.version),
            )
            .sort((a, b) => b.version - a.version);
          return rows[0] ?? null;
        },
      ),
    },
  };
  const budget = {
    resolveHeadCoachId: jest.fn(async (id: string) => opts.heads?.[id] ?? id),
  };
  const augmenter = new RomanCoachMethodAugmenter(
    fakeOf<PrismaService>(prisma),
    opts.noBudget ? null : fakeOf<CoachAIBudgetService>(budget),
  );
  return { prisma, budget, users, playbooks, augmenter };
}

const BUNDLE = fakeOf<RomanClientContextBundle>({});
const student = { id: CLIENT, role: 'student' };

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
  it('flag off (unset, false): null and no read', async () => {
    for (const v of [undefined, 'false', '1']) {
      if (v === undefined) delete process.env[FEATURE_ROMAN_PLAYBOOK_ENV];
      else process.env[FEATURE_ROMAN_PLAYBOOK_ENV] = v;
      const h = harness({ playbooks: [playbook('coach-A', 1, 'A')] });
      expect(await h.augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
      expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(h.prisma.coachPlaybook.findFirst).not.toHaveBeenCalled();
    }
  });

  it('renders the active playbook: heading, instruction, items per section, red lines as rules and post-check phrases', async () => {
    const h = harness({ playbooks: [playbook('coach-A', 1, 'COACH-A')] });
    const out = await h.augmenter.augment(student, BUNDLE, 'What should I do today?');
    expect(out).not.toBeNull();
    if (!out) return;
    const lines = out.block.split('\n');
    expect(lines[0]).toBe(COACH_METHOD_HEADING);
    expect(lines[1]).toBe(COACH_METHOD_INSTRUCTION);
    expect(lines[2]).toBe('<coach_method>');
    expect(lines[lines.length - 1]).toBe('</coach_method>');
    expect(out.block).toContain('Exercises:\n- Go-to: COACH-A trap-bar deadlift as the main hinge');
    expect(out.block).toContain('- Swap: Goblet squat instead of Back squat (knees ache)');
    expect(out.block).toContain('Training:\n- Progression: Add a rep each week, then add load');
    expect(out.block).toContain('Nutrition:\n- Protein: Protein at every meal');
    expect(out.block).toContain('Recovery:\n- Sleep: Eight hours in bed');
    expect(out.block).toContain('Rules this coach never breaks:\n- Never train through sharp pain');
    expect(out.post_check).toEqual({ red_lines: ['Never train through sharp pain'] });
    expect(out.hash).toBe(createHash('sha256').update(out.block).digest('hex'));
    expect(out.estimated_tokens).toBe(Math.ceil(out.block.length / 4));
    expect(COACH_METHOD_INSTRUCTION).toMatch(/never quote the coach’s notes/);
  });

  it('caps each section at 12 items, stated first then the strongest evidence', async () => {
    const pb = playbook('coach-A', 1, 'A');
    const observed = (label: string, from: number) =>
      Array.from({ length: 6 }, (_, i) => item(`${label} ${from + i}`, 'observed', from + i));
    pb.sections = {
      training: {
        split: observed('Observed', 0),
        frequency: observed('Observed', 6),
        progression: [item('Add a rep each week', 'stated', 0)],
      },
    };
    pb.red_lines = [];
    const out = await harness({ playbooks: [pb] }).augmenter.augment(student, BUNDLE, 'hi');
    const rendered = (out?.block ?? '').split('\n').filter((l) => l.startsWith('- '));
    expect(rendered).toHaveLength(COACH_METHOD_SECTION_ITEMS_MAX);
    expect(rendered).toContain('- Progression: Add a rep each week');
    expect(rendered).not.toContain('- Split: Observed 0');
    expect(rendered).toContain('- Split: Observed 1');
    expect(out?.post_check).toBeUndefined();
  });

  it('a coach caller, a client with no coach, a deleted coach, or no budget service: null', async () => {
    const h = harness({ playbooks: [playbook('coach-A', 1, 'A')] });
    expect(await h.augmenter.augment({ id: 'coach-A', role: 'coach' }, BUNDLE, 'hi')).toBeNull();
    const none = harness({
      users: { [CLIENT]: { role: 'student', coach: null } },
      playbooks: [playbook('coach-A', 1, 'A')],
    });
    expect(await none.augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
    const gone = harness({
      users: { [CLIENT]: { role: 'student', coach: coach('coach-A', NOW) } },
      playbooks: [playbook('coach-A', 1, 'A')],
    });
    expect(await gone.augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
    const noBudget = harness({ playbooks: [playbook('coach-A', 1, 'A')], noBudget: true });
    expect(await noBudget.augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
  });

  it('a sub-coach client gets the head coach’s playbook', async () => {
    const h = harness({
      users: { [CLIENT]: { role: 'student', coach: coach('coach-sub') } },
      heads: { 'coach-sub': 'coach-head' },
      playbooks: [playbook('coach-sub', 1, 'SUB'), playbook('coach-head', 3, 'HEAD')],
    });
    const out = await h.augmenter.augment(student, BUNDLE, 'hi');
    expect(out?.block).toContain('HEAD trap-bar');
    expect(out?.block).not.toContain('SUB trap-bar');
  });

  it('a former coach’s playbook is never used after reassignment', async () => {
    const h = harness({
      playbooks: [playbook('coach-A', 1, 'COACH-A'), playbook('coach-B', 1, 'COACH-B')],
    });
    expect((await h.augmenter.augment(student, BUNDLE, 'hi'))?.block).toContain('COACH-A');
    h.users[CLIENT] = { role: 'student', coach: coach('coach-B') };
    const after = await h.augmenter.augment(student, BUNDLE, 'hi');
    expect(after?.block).toContain('COACH-B');
    expect(after?.block).not.toContain('COACH-A');
    // New coach without a playbook: nothing, never the old coach's (cached) block.
    h.users[CLIENT] = { role: 'student', coach: coach('coach-C') };
    expect(await h.augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
  });

  it('a superseded playbook is ignored; the active version is used', async () => {
    const onlyOld = harness({ playbooks: [playbook('coach-A', 2, 'OLD', 'superseded')] });
    expect(await onlyOld.augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
    const h = harness({
      playbooks: [playbook('coach-A', 1, 'V1', 'superseded'), playbook('coach-A', 2, 'V2')],
    });
    const out = await h.augmenter.augment(student, BUNDLE, 'hi');
    expect(out?.block).toContain('V2 trap-bar');
    expect(out?.block).not.toContain('V1 trap-bar');
  });

  it('invalid stored JSON gives no block', async () => {
    const unknownKey = playbook('coach-A', 1, 'A');
    unknownKey.sections = { exercises: { go_to: [item('Fine')] }, secrets: { x: 1 } };
    const badRedLines = playbook('coach-A', 1, 'A');
    badRedLines.red_lines = [{ kind: 'quote_the_notes', text: 'x', basis: 'stated', evidence_count: 1 }];
    const notJson = playbook('coach-A', 1, 'A');
    notJson.sections = 'not an object';
    for (const pb of [unknownKey, badRedLines, notJson]) {
      expect(await harness({ playbooks: [pb] }).augmenter.augment(student, BUNDLE, 'hi')).toBeNull();
    }
  });

  it('caches the rendered block by (coach, version) for 10 minutes; a new version is read at once', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const h = harness({ playbooks: [playbook('coach-A', 1, 'V1')] });
    const first = await h.augmenter.augment(student, BUNDLE, 'hi');
    const second = await h.augmenter.augment(student, BUNDLE, 'hi');
    expect(second).toEqual(first);
    // version probe on each turn, content read once
    expect(h.prisma.coachPlaybook.findFirst).toHaveBeenCalledTimes(3);
    h.playbooks[0].status = 'superseded';
    h.playbooks.push(playbook('coach-A', 2, 'V2'));
    expect((await h.augmenter.augment(student, BUNDLE, 'hi'))?.block).toContain('V2 trap-bar');
    now.mockReturnValue(1_000_000 + COACH_METHOD_CACHE_TTL_MS + 1);
    const calls = h.prisma.coachPlaybook.findFirst.mock.calls.length;
    await h.augmenter.augment(student, BUNDLE, 'hi');
    expect(h.prisma.coachPlaybook.findFirst.mock.calls.length).toBe(calls + 2);
  });

  it('RomanModule provides the augmenter under its kind token', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    expect(providers).toContainEqual({
      provide: ROMAN_COACH_METHOD_AUGMENTER,
      useClass: RomanCoachMethodAugmenter,
    });
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
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  const session = (surface: 'client' | 'coach', user_id: string) => ({
    id: 'sess_1',
    user_id,
    surface,
    day_key: LOCAL_TODAY_PT,
    message_count: 0,
    started_at: NOW,
    last_activity_at: NOW,
    quips_in_session: 0,
    exclamation_used: false,
    subject_context_json: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  });

  function run() {
    const db = makePersonaDb();
    const calls: Array<Record<string, unknown>> = [];
    const anthropic = {
      messages: {
        stream: jest.fn((body: Record<string, unknown>) => {
          calls.push(body);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
              yield {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'Your plan for today is on the Today tab.' },
              };
              yield { type: 'message_delta', usage: { output_tokens: 6 } };
            },
          };
        }),
      },
    };
    const method = harness({
      users: {
        [P1]: { role: 'student', coach: coach(COACH_A.id) },
        [COACH_A.id]: { role: 'coach', coach: null },
      },
      playbooks: [playbook(COACH_A.id, 1, 'METHOD-CANARY')],
    });
    const augment = jest.spyOn(method.augmenter, 'augment');
    const svc = new RomanService(
      fakeOf(db.prisma),
      grantAllEgress(),
      AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
      new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource()),
      null,
      null,
      [method.augmenter],
    );
    return { svc, calls, augment };
  }
  async function drain(gen: AsyncGenerator<unknown>) {
    for await (const _ of gen) void _;
  }

  it('the client turn carries the block after client_data; the coach surface never gets it', async () => {
    const client = run();
    await drain(
      client.svc.streamAssistantTurn({ id: P1, role: 'student' }, session('client', P1), {
        userMessage: 'How should I train this week?',
      }),
    );
    const system = client.calls[0].system as string;
    expect(system).toContain(COACH_METHOD_HEADING);
    expect(system).toContain('METHOD-CANARY');
    expect(system.indexOf('<coach_method>')).toBeGreaterThan(system.indexOf('</client_data>'));

    const coachSide = run();
    await drain(
      coachSide.svc.streamAssistantTurn(
        { id: COACH_A.id, role: 'coach' },
        session('coach', COACH_A.id),
        { userMessage: 'Brief me on my week.' },
      ),
    );
    await drain(
      coachSide.svc.streamAssistantTurn(
        { id: COACH_A.id, role: 'coach' },
        session('client', COACH_A.id),
        { userMessage: 'Brief me on my week.' },
      ),
    );
    expect(coachSide.augment).not.toHaveBeenCalled();
    for (const c of coachSide.calls) {
      expect(c.system as string).not.toContain(COACH_METHOD_HEADING);
      expect(c.system as string).not.toContain('METHOD-CANARY');
    }
  });
});
