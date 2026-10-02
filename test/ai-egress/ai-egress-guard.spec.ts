/**
 * R2b — static guard: no AI call site may bypass the egress gate.
 *
 * Fails if any production file under src/ outside src/ai-egress/:
 *   - imports an AI provider SDK as a VALUE (type-only imports are fine:
 *     they cannot send anything), via import, require() or import();
 *   - constructs a provider client (`new Anthropic(`, `new OpenAI(`);
 *   - calls a provider request method directly (`.messages.create(`,
 *     `.messages.stream(`, `.chat.completions.create(`, `.responses.create(`);
 *   - names a provider API host (raw HTTP to an AI provider).
 * Also fails if package.json gains an AI SDK this guard does not know about,
 * so a new SDK cannot slip in unguarded.
 *
 * A new AI feature must call AiEgressService (src/ai-egress/) with a declared
 * data subject. The negative cases at the bottom prove the scanner catches
 * each bypass shape.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AiEgressPolicyException } from '../../src/ai-egress/ai-consent-required.exception';
import {
  AiEgressService,
  AnthropicHandle,
  PerplexityHandle,
} from '../../src/ai-egress/ai-egress.service';
import { noClientDataSubject } from '../../src/ai-egress/ai-egress.types';
import {
  createAnthropicClient,
  createPerplexityClient,
} from '../../src/ai-egress/provider-clients';
import { romanAnthropicClientProvider } from '../../src/roman/anthropic-client.provider';

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const EGRESS_DIR = 'src/ai-egress/';

/** AI SDK packages this repo may depend on. Adding one means extending the guard. */
const KNOWN_AI_SDKS = ['@anthropic-ai/sdk', 'openai'] as const;
/** Package name fragments that indicate an AI provider SDK. */
const AI_SDK_NAME_HINTS = [
  'anthropic',
  'openai',
  'perplexity',
  'gemini',
  'generative-ai',
  'genai',
  'cohere',
  'mistral',
  'groq',
  'bedrock',
  'replicate',
  'langchain',
  'llamaindex',
  'together-ai',
  'huggingface',
  'vertexai',
];
// Bare package specifiers only (local files such as './anthropic.adapter' are not SDKs).
const SDK_IMPORT_TARGET = `(?![./])(?:${[
  ...KNOWN_AI_SDKS,
  ...AI_SDK_NAME_HINTS.map((h) => `[^'"\\s]*${h}[^'"\\s]*`),
]
  .map((s) => s.replace(/[@/]/g, (c) => `\\${c}`))
  .join('|')})`;

const RULES: Array<{ name: string; re: RegExp }> = [
  {
    // `import X from 'sdk'`, `import { X } from 'sdk'`, `import * as X from 'sdk'`,
    // `import 'sdk'` — but NOT `import type ...`.
    name: 'ai-sdk-value-import',
    // The specifier must be the whole quoted module string after `from` (or
    // a bare side-effect import); no match may start at a closing quote.
    re: new RegExp(
      `^\\s*import\\s+(?!type\\b)(?:[^;'"]*?\\bfrom\\s*)?['"]${SDK_IMPORT_TARGET}['"]`,
      'm',
    ),
  },
  { name: 'ai-sdk-require', re: new RegExp(`require\\(\\s*['"]${SDK_IMPORT_TARGET}['"]\\s*\\)`) },
  {
    name: 'ai-sdk-dynamic-import',
    re: new RegExp(`import\\(\\s*['"]${SDK_IMPORT_TARGET}['"]\\s*\\)`),
  },
  {
    name: 'provider-client-construction',
    re: /new\s+(?:Anthropic|OpenAI|AnthropicBedrock|AnthropicVertex)\s*\(/,
  },
  { name: 'provider-messages-call', re: /\.messages\s*\.\s*(?:create|stream)\s*\(/ },
  { name: 'provider-chat-completions-call', re: /\.completions\s*\.\s*create\s*\(/ },
  { name: 'provider-responses-call', re: /\.responses\s*\.\s*create\s*\(/ },
  {
    name: 'provider-host',
    re: /api\.anthropic\.com|api\.perplexity\.ai|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(?:ai|com)|api\.groq\.com/,
  },
];

/** Drop comments so prose that mentions an SDK call does not trip the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function scanSource(text: string): string[] {
  const code = stripComments(text);
  return RULES.filter((r) => r.re.test(code)).map((r) => r.name);
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...productionFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts'))
      out.push(p);
  }
  return out;
}

describe('AI egress guard (R2b)', () => {
  it('no production file outside src/ai-egress reaches an AI provider directly', () => {
    const violations: string[] = [];
    for (const file of productionFiles(SRC)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (rel.startsWith(EGRESS_DIR)) continue;
      for (const rule of scanSource(fs.readFileSync(file, 'utf8')))
        violations.push(`${rel}: ${rule}`);
    }
    expect(violations).toEqual([]);
  });

  it('the egress module itself is where the SDK clients and calls live', () => {
    const clients = fs.readFileSync(path.join(ROOT, EGRESS_DIR, 'provider-clients.ts'), 'utf8');
    const service = fs.readFileSync(path.join(ROOT, EGRESS_DIR, 'ai-egress.service.ts'), 'utf8');
    expect(scanSource(clients)).toEqual(
      expect.arrayContaining([
        'ai-sdk-value-import',
        'provider-client-construction',
        'provider-host',
      ]),
    );
    expect(scanSource(service)).toEqual(
      expect.arrayContaining(['provider-messages-call', 'provider-chat-completions-call']),
    );
    // Every send method goes through sendGated, which checks the subject
    // before EVERY attempt, and every SDK request forces SDK retries off.
    const sends =
      service.match(
        /async (anthropicMessagesCreate|anthropicMessagesStream|perplexityChatCreate)\([\s\S]*?\n {2}\}/g,
      ) ?? [];
    expect(sends).toHaveLength(3);
    for (const body of sends) {
      expect(body).toMatch(/return this\.sendGated\(/);
      expect(body).toMatch(/maxRetries: 0 \}/);
    }
    const gated = service.match(/private async sendGated<T>\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(gated).toMatch(/for \(let retry = 0; ; retry\+\+\) \{\s*await this\.assertMaySend\(/);
  });

  it('package.json has no AI SDK the guard does not know about', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const aiLike = names.filter((n) => AI_SDK_NAME_HINTS.some((h) => n.toLowerCase().includes(h)));
    expect(aiLike.sort()).toEqual([...KNOWN_AI_SDKS].sort());
  });

  describe('scanner self-test (each bypass shape is caught)', () => {
    it.each([
      ["import Anthropic from '@anthropic-ai/sdk';", 'ai-sdk-value-import'],
      ["import { Anthropic } from '@anthropic-ai/sdk';", 'ai-sdk-value-import'],
      ["import * as sdk from 'openai';", 'ai-sdk-value-import'],
      ["import { GoogleGenerativeAI } from '@google/generative-ai';", 'ai-sdk-value-import'],
      ["const A = require('@anthropic-ai/sdk');", 'ai-sdk-require'],
      ["const m = await import('openai');", 'ai-sdk-dynamic-import'],
      ['const c = new Anthropic({ apiKey });', 'provider-client-construction'],
      ["const c = new OpenAI({ apiKey, baseURL: 'x' });", 'provider-client-construction'],
      ['await this.client.messages.create({ model });', 'provider-messages-call'],
      ['const s = client.messages\n  .stream({ model });', 'provider-messages-call'],
      ['await px.chat.completions.create({ model });', 'provider-chat-completions-call'],
      ['await oa.responses.create({ model });', 'provider-responses-call'],
      ["await fetch('https://api.anthropic.com/v1/messages');", 'provider-host'],
      ["const u = 'https://api.perplexity.ai';", 'provider-host'],
    ])('%s -> %s', (code, rule) => {
      expect(scanSource(code)).toContain(rule);
    });

    it.each([
      ["import { AnthropicAdapter } from '../ai/adapters/anthropic.adapter';"],
      ["import { ROMAN_ANTHROPIC_CLIENT } from './anthropic-client.provider';"],
      ["import type Anthropic from '@anthropic-ai/sdk';"],
      ["import type OpenAI from 'openai';"],
      ['// we used to call client.messages.create( here'],
      ['/* new Anthropic( was here */'],
      ['await this.egress.anthropicMessagesCreate(client, subject, surface, params);'],
    ])('allowed: %s', (code) => {
      expect(scanSource(code)).toEqual([]);
    });
  });
});

// C-626-1 — the boundary is enforced, not only scanned: call sites hold
// opaque handles, ESLint rejects AI SDK value imports outside src/ai-egress
// (CI runs `npm run lint`), and the factories never hand out an SDK client.
describe('AI provider capability boundary (C-626-1)', () => {
  // Loaded untyped on purpose: the full eslint type graph is large and only
  // this small surface is used.
  interface LintApi {
    lintText(
      code: string,
      o: { filePath: string },
    ): Promise<Array<{ messages: Array<{ ruleId: string | null }> }>>;
  }
  const { ESLint } = require('eslint') as {
    ESLint: new (o: {
      cwd: string;
      overrideConfigFile: boolean;
      overrideConfig: unknown;
    }) => LintApi;
  };
  // The repo's real flat config, passed in directly (jest cannot run
  // ESLint's dynamic config-file import without --experimental-vm-modules).
  const repoConfig: unknown = require(path.join(ROOT, 'eslint.config.js'));

  async function lint(code: string, rel: string) {
    const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: repoConfig });
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, rel) });
    return result.messages
      .filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')
      .map((m) => m.ruleId);
  }

  it('ESLint rejects an AI SDK value import anywhere in src/ outside src/ai-egress', async () => {
    const anthropic =
      "import Anthropic from '@anthropic-ai/sdk';\nexport const c = new Anthropic();\n";
    const openai = "import OpenAI from 'openai';\nexport const c = new OpenAI();\n";
    const deep =
      "import { Messages } from '@anthropic-ai/sdk/resources/messages';\nexport const m = Messages;\n";
    expect(await lint(anthropic, 'src/roman/probe.ts')).toHaveLength(1);
    expect(await lint(openai, 'src/first-win/probe.ts')).toHaveLength(1);
    expect(await lint(deep, 'src/coach/brief/probe.ts')).toHaveLength(1);
    // Type-only imports cannot send anything and stay allowed.
    expect(
      await lint(
        "import type Anthropic from '@anthropic-ai/sdk';\nexport type A = Anthropic;\n",
        'src/roman/probe.ts',
      ),
    ).toEqual([]);
    // The egress module itself may use the SDK.
    expect(await lint(anthropic, 'src/ai-egress/probe.ts')).toEqual([]);
  }, 30_000);

  it('a handle exposes nothing: no SDK surface, no own properties, frozen', () => {
    const create = jest.fn();
    const handle = AnthropicHandle.bind({ messages: { create, stream: jest.fn() } });
    expect(Object.getOwnPropertyNames(handle)).toEqual([]);
    expect(Object.getOwnPropertySymbols(handle)).toEqual([]);
    expect(Object.isFrozen(handle)).toBe(true);
    expect('messages' in handle).toBe(false);
    expect(JSON.stringify(handle)).toBe('{}');
    const p = PerplexityHandle.bind({ chat: { completions: { create } } });
    expect('chat' in p).toBe(false);
    expect(Object.getOwnPropertyNames(p)).toEqual([]);
  });

  it('the factories and the Roman DI provider return handles, never SDK clients', () => {
    const a = createAnthropicClient('test-key-not-a-secret');
    const p = createPerplexityClient('test-key-not-a-secret');
    expect(a).toBeInstanceOf(AnthropicHandle);
    expect(p).toBeInstanceOf(PerplexityHandle);
    expect('messages' in a).toBe(false);
    expect('chat' in p).toBe(false);
    const provider = romanAnthropicClientProvider as {
      useFactory: (config: { get: (k: string) => string | undefined }) => unknown;
    };
    expect(provider.useFactory({ get: () => 'test-key-not-a-secret' })).toBeInstanceOf(
      AnthropicHandle,
    );
  });

  it('the gate refuses anything that is not a bound handle (503, nothing sent)', async () => {
    const reader = { hasClientAiConsent: jest.fn(), clientsWithAiConsent: jest.fn() };
    const egress = new AiEgressService(reader);
    const create = jest.fn();
    const forged = Object.create(AnthropicHandle.prototype);
    await expect(
      egress.anthropicMessagesCreate(
        forged,
        noClientDataSubject('health_probe'),
        'coach_ai.health_probe',
        {
          model: 'm',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
      ),
    ).rejects.toBeInstanceOf(AiEgressPolicyException);
    expect(create).not.toHaveBeenCalled();
  });
});
