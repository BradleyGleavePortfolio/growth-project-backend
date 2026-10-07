// test/roman/r11-seams.spec.ts
//
// Roman v1.1 slice R11-00 (A-ROMAN11-124 plan): the seams later slices plug
// into. Flags parse, capabilities are metered, the background breaker fails
// closed, and the turn-augmenter seam leaves every turn exactly as before
// while no augmenter is registered. In-memory doubles only; no network, no DB.

import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { buildRomanSystemPrompt } from '../../src/roman/roman.prompts';
import {
  ROMAN_TURN_AUGMENTERS,
  romanTurnAugmentersProvider,
  runRomanTurnAugmenters,
  type RomanTurnAugment,
  type RomanTurnAugmenter,
} from '../../src/roman/augment/roman-turn-augmenter';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import { RomanBackgroundSpendService } from '../../src/roman/background/roman-background-spend';
import { isRomanMemoryEnabled } from '../../src/roman/memory/roman-memory.feature';
import { isRomanPlaybookEnabled } from '../../src/roman/playbook/roman-playbook.feature';
import { isRomanToolsEnabled } from '../../src/roman/tools/roman-tools.feature';
import { ROMAN_TOOLBOX, ROMAN_TOOL_LIMITS } from '../../src/roman/tools/roman-tool.types';
import type { ClientAiConsentReader } from '../../src/ai-consent/ai-consent.reader';
import type { ClientAiConsentScope } from '../../src/ai-consent/ai-consent.constants';
import {
  ROMAN_MEMORY_CAPABILITY,
  ROMAN_PLAYBOOK_CAPABILITY,
} from '../../src/roman/roman.constants';
import {
  ROMAN_MODEL_BACKGROUND,
  ROMAN_MODEL_PHASE_1,
} from '../../src/roman/anthropic-client.provider';
import { COACH_AI_METERED_CAPABILITIES } from '../../src/ai-credits/ai-credits.constants';
import { ENV_RULES } from '../../src/common/env-validation';
import { RomanModule } from '../../src/roman/roman.module';
import { RomanService } from '../../src/roman/roman.service';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import {
  AiEgressService,
  AnthropicHandle,
  type AnthropicMessagesClient,
} from '../../src/ai-egress/ai-egress.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { _resetRomanContextListeners } from '../../src/roman/context/roman-context-invalidation';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import type { PrismaService } from '../../src/prisma.service';
import {
  makePersonaDb,
  FakeSafetyIntakeSource,
  NOW,
  LOCAL_TODAY_PT,
  P1,
} from './fixtures/roman-personas';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── prompt: zero augments = main, byte for byte ─────────────────────────────

describe('R11-00 prompt seam', () => {
  const v0 = { quipsInSession: 0, exclamationUsed: false };
  const v1 = { quipsInSession: 2, exclamationUsed: true, lastTurnHadQuip: true };
  const CLIENT_DATA = '<client_data as_of="2026-09-30">{"first_name":"Test"}</client_data>';
  // sha256 of buildRomanSystemPrompt on origin/main 302c4522 for these inputs;
  // client hashes re-pinned for the roman-client-v4 crisis section (AUDIT-05-125).
  const MAIN = {
    client_plain: {
      input: { surface: 'client' as const, voice: v0 },
      hash: '962b871d82f71897b51a1085b83f5c573ac153a1221ef2153246ca7a98611965',
    },
    coach_plain: {
      input: {
        surface: 'coach' as const,
        voice: v1,
        subjectContext: 'Weekly brief for the coach.',
      },
      hash: '41bcea54db0453a4f7a20ca596cb7917e1f97929fe0f523401abc90a1de4cdc7',
    },
    client_data: {
      input: {
        surface: 'client' as const,
        voice: v0,
        routerHint: 'Hint line.',
        clientData: CLIENT_DATA,
      },
      hash: 'd3ec365d34c74fea135eb8da88c78ab0de014bbd7f6fa05dc5cf480cd0df5889',
    },
    client_unavailable: {
      input: { surface: 'client' as const, voice: v1, clientDataUnavailable: true },
      hash: 'a3e665f5ade3cfa43a11f1555e0fa2ced51418dbffc890459519740254750b84',
    },
  };

  it('no augments (absent, empty, blank) -> the prompt hash equals main', () => {
    for (const [name, c] of Object.entries(MAIN)) {
      expect([name, sha(buildRomanSystemPrompt(c.input))]).toEqual([name, c.hash]);
      expect([name, sha(buildRomanSystemPrompt({ ...c.input, augments: [] }))]).toEqual([
        name,
        c.hash,
      ]);
      expect([name, sha(buildRomanSystemPrompt({ ...c.input, augments: ['  '] }))]).toEqual([
        name,
        c.hash,
      ]);
      // R11-T3: tools false (or any coach prompt) is byte-identical to main.
      expect([name, sha(buildRomanSystemPrompt({ ...c.input, tools: false }))]).toEqual([name, c.hash]);
      if (c.input.surface === 'coach') expect(sha(buildRomanSystemPrompt({ ...c.input, tools: true }))).toBe(c.hash);
    }
  });

  it('augments follow client_data as their own sections, in the given order, before subject context', () => {
    const p = buildRomanSystemPrompt({
      ...MAIN.client_data.input,
      subjectContext: 'Subject.',
      augments: ['<client_memory>M</client_memory>', '<coach_method>C</coach_method>'],
    });
    const iData = p.indexOf(CLIENT_DATA);
    const iMem = p.indexOf('\n\n<client_memory>M</client_memory>\n\n');
    const iMethod = p.indexOf('\n\n<coach_method>C</coach_method>\n\n');
    expect(iData).toBeGreaterThan(0);
    expect(iMem).toBeGreaterThan(iData);
    expect(iMethod).toBeGreaterThan(iMem);
    expect(p.indexOf('# SUBJECT CONTEXT')).toBeGreaterThan(iMethod);
  });

  it('the coach surface never carries augments', () => {
    const p = buildRomanSystemPrompt({
      ...MAIN.coach_plain.input,
      augments: ['<client_memory>M</client_memory>'],
    });
    expect(sha(p)).toBe(MAIN.coach_plain.hash);
  });
});

// ─── augmenter runner ────────────────────────────────────────────────────────

function aug(
  kind: RomanTurnAugmenter['kind'],
  impl: () => Promise<RomanTurnAugment | null>,
): RomanTurnAugmenter {
  return { kind, augment: jest.fn(impl) };
}
const block = (kind: string, text: string) => ({
  block: `<${kind}>${text}</${kind}>`,
  hash: sha(text),
  estimated_tokens: 4,
});
const fakeBundle = fakeOf<RomanClientContextBundle>({ rendered: '', hash: 'h', context: {} });

describe('R11-00 runRomanTurnAugmenters', () => {
  it('fixed order (client_memory, then coach_method) whatever the registration order', async () => {
    const run = await runRomanTurnAugmenters(
      [
        aug('coach_method', async () => block('coach_method', 'C')),
        aug('client_memory', async () => block('client_memory', 'M')),
      ],
      { id: P1, role: 'student' },
      fakeBundle,
      'hi',
      { timeoutMs: 1000 },
    );
    expect(run.applied.map((a) => a.kind)).toEqual(['client_memory', 'coach_method']);
    expect(run.omitted).toEqual([]);
  });

  it('a throw, a timeout and an empty block each omit only that block; failures carry no content', async () => {
    const failures: Array<{ kind: string; reason: string }> = [];
    const throwing = aug('client_memory', async () => {
      throw new Error('SECRET-CANARY');
    });
    const slow = aug(
      'coach_method',
      () =>
        new Promise<RomanTurnAugment | null>((r) =>
          setTimeout(() => r(block('coach_method', 'late')), 200),
        ),
    );
    const run = await runRomanTurnAugmenters(
      [throwing, slow],
      { id: P1, role: 'student' },
      fakeBundle,
      'hi',
      {
        timeoutMs: 20,
        onFailure: (f) => failures.push({ kind: f.kind, reason: f.reason }),
      },
    );
    expect(run.applied).toEqual([]);
    expect(run.omitted).toEqual(['client_memory', 'coach_method']);
    expect(failures).toEqual([
      { kind: 'client_memory', reason: 'error' },
      { kind: 'coach_method', reason: 'timeout' },
    ]);
    const empty = await runRomanTurnAugmenters(
      [
        aug('client_memory', async () => ({ block: '   ', hash: 'x', estimated_tokens: 0 })),
        aug('coach_method', async () => null),
      ],
      { id: P1, role: 'student' },
      fakeBundle,
      'hi',
      { timeoutMs: 1000 },
    );
    expect(empty.applied).toEqual([]);
    expect(empty.omitted).toEqual(['client_memory', 'coach_method']);
  });

  it('the module collects no augmenter on main (default empty) and provides the background spend service', () => {
    const p = romanTurnAugmentersProvider;
    expect(p.provide).toBe(ROMAN_TURN_AUGMENTERS);
    expect(p.useFactory()).toEqual([]);
    expect(p.useFactory(undefined, undefined)).toEqual([]);
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    expect(providers).toContain(romanTurnAugmentersProvider);
    expect(providers).toContain(RomanBackgroundSpendService);
  });
});

// ─── full turns through RomanService ─────────────────────────────────────────

/** R11-T2A: every client holds the base grant; only a `v5` client holds 'memory'. */
class ScopedConsentReader implements ClientAiConsentReader {
  memoryReads = 0;
  constructor(private readonly v5: boolean) {}
  async hasClientAiConsent(_id: string, scope: ClientAiConsentScope = 'base'): Promise<boolean> {
    if (scope !== 'memory') return true;
    this.memoryReads += 1;
    return this.v5;
  }
  async clientsWithAiConsent(
    ids: readonly string[],
    scope: ClientAiConsentScope = 'base',
  ): Promise<ReadonlySet<string>> {
    if (scope === 'memory') this.memoryReads += 1;
    return new Set(scope === 'memory' && !this.v5 ? [] : ids);
  }
}

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
describe('R11-00 turn seam (RomanService.streamAssistantTurn)', () => {
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

  function makeAnthropic(reply = 'Your plan for today is on the Today tab.') {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      messages: {
        stream: jest.fn((body: Record<string, unknown>) => {
          calls.push(body);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } };
              yield { type: 'message_delta', usage: { output_tokens: 6 } };
            },
          };
        }),
      },
    };
  }
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
  async function drain(gen: AsyncGenerator<unknown>) {
    const out: Array<{ type: string; text?: string }> = [];
    for await (const c of gen) out.push(c as { type: string; text?: string });
    return out;
  }
  function run(
    augmenters: RomanTurnAugmenter[] | null,
    withContext = true,
    egress: AiEgressService = grantAllEgress(),
  ) {
    const db = makePersonaDb();
    const ctx = withContext
      ? new RomanClientContextService(db.prisma, new FakeSafetyIntakeSource())
      : null;
    const anthropic = makeAnthropic();
    const svc = new RomanService(
      fakeOf(db.prisma),
      egress,
      AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(anthropic)),
      ctx,
      null,
      null,
      augmenters,
    );
    return { db, anthropic, svc };
  }

  it('zero augmenters: the system prompt and the ledger row are exactly the pre-v1.1 ones', async () => {
    const a = run(null);
    const b = run([]);
    await drain(
      a.svc.streamAssistantTurn({ id: P1, role: 'student' }, session('client', P1), {
        userMessage: 'How is my week?',
      }),
    );
    await drain(
      b.svc.streamAssistantTurn({ id: P1, role: 'student' }, session('client', P1), {
        userMessage: 'How is my week?',
      }),
    );
    expect(a.anthropic.calls[0].system).toBe(b.anthropic.calls[0].system);
    const meta = a.db.raw.aiRequestAudits[0].metadata as Record<string, unknown>;
    expect(Object.keys(meta)).not.toContain('augments');
    expect(Object.keys(b.db.raw.aiRequestAudits[0].metadata as object)).not.toContain('augments');
  });

  it('a throwing augmenter: the turn still answers, its block is absent, the other block is applied; ledger has kinds + hashes only', async () => {
    const mem = block('client_memory', 'MEMORY-BLOCK-TEXT');
    const t = run([
      aug('coach_method', async () => {
        throw new Error('boom');
      }),
      aug('client_memory', async () => mem),
    ]);
    const chunks = await drain(
      t.svc.streamAssistantTurn({ id: P1, role: 'student' }, session('client', P1), {
        userMessage: 'How is my week?',
      }),
    );
    const done = chunks.find((c) => c.type === 'done');
    expect((done?.text ?? '').length).toBeGreaterThan(0);
    const system = t.anthropic.calls[0].system as string;
    expect(system.match(/<client_memory>/g)).toHaveLength(1);
    expect(system.indexOf('<client_memory>')).toBeGreaterThan(system.indexOf('</client_data>'));
    expect(system).not.toContain('<coach_method>');
    const ledger = t.db.raw.aiRequestAudits[0];
    expect(ledger.metadata).toMatchObject({
      state: 'settled',
      augments: [`client_memory:${mem.hash}`],
      augments_omitted: ['coach_method'],
    });
    expect(JSON.stringify(ledger)).not.toContain('MEMORY-BLOCK-TEXT');
  });

  it('the coach surface, a coach caller and a degraded turn never call an augmenter', async () => {
    const a = aug('client_memory', async () => block('client_memory', 'M'));
    const t = run([a]);
    await drain(
      t.svc.streamAssistantTurn({ id: 'coach-A', role: 'coach' }, session('coach', 'coach-A'), {
        userMessage: 'hi',
      }),
    );
    await drain(
      t.svc.streamAssistantTurn({ id: 'coach-A', role: 'coach' }, session('client', 'coach-A'), {
        userMessage: 'hi',
      }),
    );
    const degraded = run([a], false);
    await drain(
      degraded.svc.streamAssistantTurn({ id: P1, role: 'student' }, session('client', P1), {
        userMessage: 'hi',
      }),
    );
    expect(a.augment).not.toHaveBeenCalled();
    for (const c of [...t.anthropic.calls, ...degraded.anthropic.calls])
      expect(c.system as string).not.toContain('<client_memory>');
  });

  // ─── R11-T2A: memory scope for augmented turns ─────────────────────────────
  async function scopedTurn(augmenters: RomanTurnAugmenter[] | null, v5: boolean) {
    const reader = new ScopedConsentReader(v5);
    const egress = new AiEgressService(reader);
    const send = jest.spyOn(egress, 'anthropicMessagesStream');
    const t = run(augmenters, true, egress);
    const chunks = await drain(
      t.svc.streamAssistantTurn({ id: P1, role: 'student' }, session('client', P1), {
        userMessage: 'How is my week?',
      }),
    );
    return {
      chunks,
      reader,
      system: t.anthropic.calls[0].system as string,
      subject: send.mock.calls[0][1],
      ledger: t.db.raw.aiRequestAudits[0].metadata as Record<string, unknown>,
    };
  }
  const memAug = () => aug('client_memory', async () => block('client_memory', 'MEM-TEXT'));
  const BASE = { kind: 'client_data', clientIds: [P1], audience: 'client' };

  it('R11-T2A v4 caller: the block is dropped, the prompt has no augment, the send is base scope', async () => {
    const t = await scopedTurn([memAug()], false);
    expect(t.system).not.toContain('<client_memory>');
    expect(t.system).not.toContain('MEM-TEXT');
    expect(t.subject).toEqual(BASE);
    expect(t.reader.memoryReads).toBe(1);
    expect(t.ledger).toMatchObject({ augments: [], augments_omitted: ['client_memory'] });
    expect(t.chunks.map((c) => c.type)).toEqual(['delta', 'done']);
  });

  it('R11-T2A v5 caller: the block follows client_data and the send carries scope memory', async () => {
    const t = await scopedTurn([memAug()], true);
    expect(t.system.indexOf('<client_memory>MEM-TEXT')).toBeGreaterThan(
      t.system.indexOf('</client_data>'),
    );
    expect(t.subject).toEqual({ ...BASE, scope: 'memory' });
    expect(t.ledger).toMatchObject({ augments: [expect.stringMatching(/^client_memory:/)] });
  });

  it('R11-T2A no augmenter, or none applied: no memory read and the base-scope send', async () => {
    for (const augs of [null, [], [aug('client_memory', async () => null)]]) {
      const t = await scopedTurn(augs, false);
      expect(t.reader.memoryReads).toBe(0);
      expect(t.subject).toEqual(BASE);
    }
  });
});

// ─── flags, registry, capabilities ───────────────────────────────────────────

describe('R11-00 flags and capabilities', () => {
  it('only the literal "true" turns each flag on', () => {
    for (const [fn, name] of [
      [isRomanMemoryEnabled, 'FEATURE_ROMAN_MEMORY'],
      [isRomanPlaybookEnabled, 'FEATURE_ROMAN_PLAYBOOK'],
      [isRomanToolsEnabled, 'FEATURE_ROMAN_TOOLS'],
    ] as const) {
      expect(fn({})).toBe(false);
      for (const v of ['', 'false', '1', 'yes', 'on'])
        expect([name, v, fn({ [name]: v })]).toEqual([name, v, false]);
      expect(fn({ [name]: 'true' })).toBe(true);
      expect(fn({ [name]: 'TRUE' })).toBe(true);
    }
  });

  it('ENV_RULES, the Fly manifest and the runbook register both flags off and the background cap', () => {
    const byName = new Map(ENV_RULES.map((r) => [r.name, r]));
    for (const n of ['FEATURE_ROMAN_MEMORY', 'FEATURE_ROMAN_PLAYBOOK', 'FEATURE_ROMAN_TOOLS']) {
      expect(byName.get(n)).toMatchObject({
        values: ['true', 'false'],
        unsetIs: 'off',
        tier: 'optional',
      });
    }
    expect(byName.get('ROMAN_BACKGROUND_DAILY_COST_CAP_USD')?.values).toBeUndefined();
    const root = join(__dirname, '../..');
    const m = JSON.parse(readFileSync(join(root, '.github/fly-env-desired-state.json'), 'utf8'));
    const runbook = readFileSync(join(root, 'docs/runbooks/launch-flags.md'), 'utf8');
    for (const n of ['FEATURE_ROMAN_MEMORY', 'FEATURE_ROMAN_PLAYBOOK', 'FEATURE_ROMAN_TOOLS']) {
      // FLIP-TOOLS-128: tools are declared on; the code default (and the kill) stays unset = off.
      expect(m.flags[n]).toBe(n === 'FEATURE_ROMAN_TOOLS' ? 'true' : 'unset');
      expect(m.gates[n]).toMatch(/unset = off/);
      expect(runbook).toContain(
        `${n} | off | fly secrets unset -a backend-spring-lake-3890 ${n} |`,
      );
    }
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    expect(example).toMatch(/^FEATURE_ROMAN_MEMORY=false$/m);
    expect(example).toMatch(/^FEATURE_ROMAN_PLAYBOOK=false$/m);
    expect(example).toMatch(/^FEATURE_ROMAN_TOOLS=false$/m);
    expect(example).toMatch(/^ROMAN_BACKGROUND_DAILY_COST_CAP_USD=$/m);
  });

  it('R11-T2A: the toolbox is an optional injection and the tool limits are pinned', () => {
    const deps: Array<{ index: number; param: unknown }> =
      Reflect.getMetadata('self:paramtypes', RomanService) ?? [];
    const optional: number[] = Reflect.getMetadata('optional:paramtypes', RomanService) ?? [];
    const slot = deps.find((d) => d.param === ROMAN_TOOLBOX);
    expect(slot?.index).toBe(7);
    expect(optional).toContain(7);
    expect(Object.isFrozen(ROMAN_TOOL_LIMITS)).toBe(true);
    expect(ROMAN_TOOL_LIMITS).toEqual({
      max_rounds: 3,
      max_calls_per_turn: 6,
      max_result_chars: 12_000,
      turn_wall_ms: 25_000,
      tool_timeout_ms: 3_000,
    });
  });

  it('the background capabilities are metered and are not the chat capability', () => {
    expect(ROMAN_MEMORY_CAPABILITY).toBe('roman.memory');
    expect(ROMAN_PLAYBOOK_CAPABILITY).toBe('roman.playbook');
    expect(COACH_AI_METERED_CAPABILITIES.has('roman.memory')).toBe(true);
    expect(COACH_AI_METERED_CAPABILITIES.has('roman.playbook')).toBe(true);
    expect(ROMAN_MODEL_BACKGROUND).not.toBe(ROMAN_MODEL_PHASE_1);
  });
});

// ─── background breaker ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
function bgDb(opts: { usedRows?: Row[]; ledgerFails?: boolean; coachOf?: string | null } = {}) {
  const created: Row[] = [];
  const updated: Row[] = [];
  const groupByArgs: Row[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    aiRequestAudit: {
      groupBy: jest.fn(async (args: Row) => {
        groupByArgs.push(args);
        if (opts.ledgerFails) throw new Error('ledger down');
        return opts.usedRows ?? [];
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        created.push(data);
        return data;
      }),
      update: jest.fn(async (args: Row) => {
        updated.push(args);
        return args;
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    user: {
      findUnique: jest.fn(async () => ({
        coach_id: opts.coachOf === undefined ? 'coach-sub' : opts.coachOf,
      })),
    },
  };
  return { prisma, created, updated, groupByArgs };
}
function fakeBudget(opts: { used?: number; available?: number; fails?: boolean } = {}) {
  const debits: Row[] = [];
  const budget = {
    resolveHeadCoachId: jest.fn(async (id: string) => (id === 'coach-sub' ? 'coach-head' : id)),
    canCharge: jest.fn(async () => {
      if (opts.fails) throw new Error('pool down');
      return {
        allowed: true,
        budget: {
          actual_used_cents: opts.used ?? 0,
          total_actual_available_cents: opts.available ?? 4000,
        },
      };
    }),
    recordUsage: jest.fn(async (args: Row) => {
      debits.push(args);
      return { recorded: true, budgetId: 'b1' };
    }),
  };
  return { budget, debits };
}
function bg(db: ReturnType<typeof bgDb>, budget: ReturnType<typeof fakeBudget>['budget'] | null) {
  return new RomanBackgroundSpendService(
    fakeOf<PrismaService>(db.prisma),
    budget ? fakeOf<CoachAIBudgetService>(budget) : null,
  );
}
const memoryJob = {
  capability: 'roman.memory' as const,
  payer: { kind: 'client' as const, clientId: P1 },
  model: ROMAN_MODEL_BACKGROUND,
  inputTokenBound: 20_000,
  maxOutputTokens: 2_000,
};

describe('R11-00 background spend breaker', () => {
  let savedCap: string | undefined;
  beforeEach(() => {
    savedCap = process.env.ROMAN_BACKGROUND_DAILY_COST_CAP_USD;
    delete process.env.ROMAN_BACKGROUND_DAILY_COST_CAP_USD;
  });
  afterEach(() => {
    if (savedCap === undefined) delete process.env.ROMAN_BACKGROUND_DAILY_COST_CAP_USD;
    else process.env.ROMAN_BACKGROUND_DAILY_COST_CAP_USD = savedCap;
  });

  it('cap: unset or invalid = 10, never no cap', () => {
    const s = bg(bgDb(), null);
    expect(s.dailyCapUsd({})).toBe(10);
    expect(s.dailyCapUsd({ ROMAN_BACKGROUND_DAILY_COST_CAP_USD: 'lots' })).toBe(10);
    expect(s.dailyCapUsd({ ROMAN_BACKGROUND_DAILY_COST_CAP_USD: '-1' })).toBe(10);
    expect(s.dailyCapUsd({ ROMAN_BACKGROUND_DAILY_COST_CAP_USD: '25' })).toBe(25);
    expect(RomanBackgroundSpendService.costUsd('unknown-model', 1_000_000, 0)).toBe(3);
    expect(RomanBackgroundSpendService.costUsd(ROMAN_MODEL_BACKGROUND, 1_000_000, 0)).toBe(1);
  });

  it('admits under the cap: reserves on the ledger under its own capability, the head coach pays', async () => {
    const db = bgDb();
    const { budget } = fakeBudget();
    const out = await bg(db, budget).reserve(memoryJob);
    expect(out.admitted).toBe(true);
    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toMatchObject({
      capability: 'roman.memory',
      model: ROMAN_MODEL_BACKGROUND,
      subject_user_id: P1,
      tenant_coach_id: 'coach-head',
      prompt_token_estimate: 20_000,
      response_token_estimate: 2_000,
    });
    // Background rows only: chat spend (roman.chat) is never counted here.
    expect(db.groupByArgs[0]).toMatchObject({
      where: { capability: { in: ['roman.memory', 'roman.playbook'] } },
    });
    if (out.admitted) expect(out.reservation.poolCoachId).toBe('coach-head');
  });

  it('refuses above the cap and on a ledger read failure, inserting nothing', async () => {
    process.env.ROMAN_BACKGROUND_DAILY_COST_CAP_USD = '1';
    const full = bgDb({
      usedRows: [
        {
          model: ROMAN_MODEL_BACKGROUND,
          _sum: { prompt_token_estimate: 990_000, response_token_estimate: 0 },
        },
      ],
    });
    expect(await bg(full, fakeBudget().budget).reserve(memoryJob)).toEqual({
      admitted: false,
      reason: 'cap_reached',
    });
    expect(full.created).toEqual([]);
    const down = bgDb({ ledgerFails: true });
    expect(await bg(down, fakeBudget().budget).reserve(memoryJob)).toEqual({
      admitted: false,
      reason: 'ledger_unavailable',
    });
    expect(down.created).toEqual([]);
  });

  it('refuses when the coach pool cannot pay the worst case, or cannot be read, before any ledger write', async () => {
    const db = bgDb();
    expect(
      await bg(db, fakeBudget({ used: 3999, available: 4000 }).budget).reserve(memoryJob),
    ).toEqual({ admitted: false, reason: 'pool_empty' });
    expect(await bg(db, fakeBudget({ fails: true }).budget).reserve(memoryJob)).toEqual({
      admitted: false,
      reason: 'pool_unavailable',
    });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('settle replaces the reservation and debits the pool under the job capability; a coach payer uses its head coach', async () => {
    const db = bgDb();
    const { budget, debits } = fakeBudget();
    const s = bg(db, budget);
    const out = await s.reserve({
      ...memoryJob,
      capability: 'roman.playbook',
      payer: { kind: 'coach', coachId: 'coach-sub' },
      model: ROMAN_MODEL_PHASE_1,
    });
    expect(out.admitted).toBe(true);
    expect(db.created[0]).toMatchObject({
      subject_user_id: null,
      tenant_coach_id: 'coach-head',
      capability: 'roman.playbook',
    });
    if (!out.admitted) return;
    await s.settle(out.reservation, 10_000, 1_000, { outcome: 'ok' });
    expect(db.updated[0]).toMatchObject({
      where: { request_id: out.reservation.requestId },
      data: {
        prompt_token_estimate: 10_000,
        response_token_estimate: 1_000,
        metadata: { state: 'settled', outcome: 'ok' },
      },
    });
    // 10k in x $2 + 1k out x $10 per MTok (Sonnet 5.5) = $0.03 -> 3 cents.
    expect(debits).toEqual([
      {
        coachId: 'coach-head',
        actualCostCents: 3,
        capability: 'roman.playbook',
        contextId: out.reservation.requestId,
      },
    ]);
  });
});
