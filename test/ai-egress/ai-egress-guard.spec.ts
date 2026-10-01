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
    re: new RegExp(`^\\s*import\\s+(?!type\\b)(?:[^;'"]*?\\bfrom\\s*)?['"]${SDK_IMPORT_TARGET}['"]`, 'm'),
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
    // Every send method in the gate checks the subject first.
    const sends =
      service.match(
        /async (anthropicMessagesCreate|anthropicMessagesStream|perplexityChatCreate)\([\s\S]*?\n {2}\}/g,
      ) ?? [];
    expect(sends).toHaveLength(3);
    for (const body of sends) expect(body).toMatch(/await this\.assertMaySend\(/);
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
