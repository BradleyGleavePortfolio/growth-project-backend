// Standalone, read-only Node probe. No Jest, provider, database, or build.
// TypeScript transpileModule is used in-memory only for the exact two files.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const nest = require('/home/user/workspace/deps/backend/node_modules/@nestjs/common');
nest.Logger.overrideLogger(false);
const root = process.argv[2];
if (!root) throw new Error('Pass the exact-head read-only worktree');

function load(relative, dependencies = {}) {
  const filename = `${root}/${relative}`;
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      emitDecoratorMetadata: false,
    },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, {
    exports: mod.exports,
    module: mod,
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
      return dependencies[name];
    },
    console,
    Date,
    process,
  }, { filename });
  return mod.exports;
}

const router = load('src/ai/ai-crisis-router.ts');
const service = load('src/ai/ai.service.ts', {
  '@nestjs/common': nest,
  '../analytics/events': { Events: { AI_CHAT_INVOKED: 'probe' } },
  './coach/coach-ai.constants': {
    COACH_AI_CAPABILITIES: { CLIENT_CHAT_FALLBACK: 'probe' },
  },
  '../ai-egress/ai-consent-required.exception': {
    isAiEgressRefusal: (error) => error?.response?.error === 'ai_consent_required',
  },
  '../ai-egress/ai-egress.types': {
    clientDataSubject: (id, role) => ({ id, role }),
  },
  './ai-crisis-router': router,
});

const cases = [
  ['I want to kill myself', 'self_harm'],
  ['I don’t want to live anymore', 'self_harm'],
  ['I took a whole bottle of pills', 'emergency'],
  ['I took a whole bottle of my sleeping pills', 'emergency'],
  ['I can’t breathe', 'emergency'],
  ['kill this workout', null],
  ["I'm dying after leg day", null],
  ['overdose on cardio', null],
  ['I think I overdose on cardio. How much should I do each week?', null],
  ['I took a whole bottle of Tylenol', 'emergency'],
  ['I swallowed a whole bottle of ibuprofen', 'emergency'],
  ['I took 20 Tylenol', 'emergency'],
  ['I took 2 Tylenol for my headache', null],
  ['How much protein should I eat?', null],
];

function createService({ atCap = false, consent = true } = {}) {
  const calls = { context: 0, consent: 0, quota: 0, model: 0, audit: 0, analytics: 0 };
  const row = { tokens_used: atCap ? service.DAILY_TOKEN_QUOTA : 0 };
  const prisma = {
    userAIQuota: {
      async upsert() { calls.quota++; return row; },
      async updateMany({ data }) {
        calls.quota++;
        row.tokens_used += data.tokens_used?.increment ?? 0;
        row.tokens_used -= data.tokens_used?.decrement ?? 0;
        return { count: 1 };
      },
    },
    aiRequestAudit: { async create() { calls.audit++; } },
  };
  const context = {
    async build() {
      calls.context++;
      return { coach: { has_coach: true }, generated_at: 'probe-context' };
    },
  };
  const egress = {
    async assertMaySend() {
      calls.consent++;
      if (!consent) throw new nest.HttpException({ error: 'ai_consent_required' }, 403);
    },
  };
  const svc = new service.AiService(
    prisma,
    context,
    { validate: (_, reply) => ({ reply, applied: [] }) },
    { capture() { calls.analytics++; } },
    egress,
    { async complete() {
      calls.model++;
      return { text: 'NORMAL MODEL ANSWER', tokensIn: 5, tokensOut: 5 };
    } },
    { isReady: () => true },
  );
  // Prompt content is irrelevant to crisis/quota orchestration.
  svc.buildSystemPrompt = () => 'stub prompt';
  return { svc, calls, row };
}

(async () => {
  const classification = cases.map(([message, expected]) => {
    const actual = router.classifyAiGuideCrisis(message);
    return { message, expected, actual, pass: actual === expected };
  });
  const chatCases = [
    ['at-cap self-harm', 'I want to kill myself', { atCap: true }],
    ['at-cap pills', 'I took a whole bottle of pills', { atCap: true }],
    ['no-consent self-harm', 'I want to die', { consent: false }],
    ['at-cap named medicine', 'I took a whole bottle of Tylenol', { atCap: true }],
    ['no-consent named medicine', 'I took a whole bottle of Tylenol', { consent: false }],
    ['ordinary training figure of speech', 'overdose on cardio', {}],
    ['normal training under cap', 'kill this workout', {}],
    ['normal training at cap', "I'm dying after leg day", { atCap: true }],
    ['normal small medicine dose', 'I took 2 Tylenol for my headache', {}],
  ];
  const chat = [];
  for (const [label, message, options] of chatCases) {
    const { svc, calls, row } = createService(options);
    try {
      const result = await svc.chat('probe-client', message, []);
      chat.push({
        label, message, model: result.model_used,
        reply: result.reply, calls, tokens_used: row.tokens_used,
      });
    } catch (error) {
      chat.push({
        label, message, status: error.getStatus?.(),
        response: error.getResponse?.(), calls, tokens_used: row.tokens_used,
      });
    }
  }
  console.log(JSON.stringify({
    method: 'Exact source loaded in-memory; actual router and AiService.chat, dependency doubles only',
    classification,
    chat,
  }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
