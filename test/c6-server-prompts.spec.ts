// Owner rule C-6 (A1): no text a model or a person reads uses the barred
// medical-practice word. The word is only ever assembled at runtime, so this
// file never carries it.
//
// One guard, class-first (SoT A2 items 12-13): src/ and client-readable seeds
// are scanned except the short EXEMPT list below. In .ts files the guard reads
// every string and template literal, which is where prompts, Roman tool
// descriptions, safety-router hints, Roman's fixed safe replies, JSON-repair
// prompts, coach drafting prompts, Swagger text, errors, pushes, emails and
// pages live. Static assembly ('a' + 'b', `${'a'}b`, ['a', 'b'].join('')) is
// folded first, so a split word is read whole. It skips comments, import paths
// and regex literals (detector patterns). The word trips it with a glued
// letter prefix (sub-, non-, pre-) but not inside identifiers and machine
// codes built on it. JSON strings are decoded, with only the root fixture
// version's machine identifier skipped. Other files are read line by line.
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { WearableMetricBucket } from '@prisma/client';
import { AiService } from '../src/ai/ai.service';
import {
  CONSULT_CONSENT_COPIES,
  CONSULT_CONSENT_COPY_V3,
  CONSULT_CONSENT_V3,
  CONSULT_CONSENT_V4,
  consultConsentScreenText,
} from '../src/onboarding/consult-consent-copy';
import {
  clientAiConsentCopy,
  clientAiConsentV5Copy,
  ClientAiCopyFamily,
} from '../src/ai-consent/ai-consent.service';
import { buildRomanSystemPrompt } from '../src/roman/roman.prompts';
import buildInboxTriagePrompt from '../src/community/ai-triage/prompts/inbox-triage.prompt';
import { buildCoachHfPrompt } from '../src/wearables/insights/prompts/coach-hf.prompt';
import { buildCoachSrPrompt } from '../src/wearables/insights/prompts/coach-sr.prompt';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const BARRED = /cl[i]nic/i;
const WORD = /(?<![\d_$])cl[i]nic(?:al(?:ly)?|ians?|s)?(?![\w$])/i;
const W = ['cl', 'inic'].join('');
const ROOT = join(__dirname, '..');
const mask = (s: string) => s.replace(new RegExp(W, 'gi'), '[C-6 word]');
const CONSENT = 'src/onboarding/consult-consent-copy.ts';
const AI_CONSENT = 'src/ai-consent/ai-consent.service.ts';
const PROGRAM_SEED = `seed/${W}-programs.v1.json`;

// Path (from the repo root) -> why nobody reads it. Keep this list short.
const EXEMPT: Array<[RegExp, string]> = [
  [/^src\/common\/env-validation\.ts$/, 'env var names and operator-only startup reasons'],
  [/(^|\/)README\.md$/, 'developer handbooks, never sent to a model or shown in the app'],
  [/\.spec\.ts$/, 'tests, never shipped'],
];
const exempt = (path: string) => EXEMPT.some(([re]) => re.test(path));

// Path -> sha256 of the one string there that may keep the word. Keep it to one.
const HISTORIC: Record<string, string> = {
  // Consent v3/v4 paragraph 3, the pinned copy older app builds still send.
  'src/onboarding/consult-consent-copy.ts':
    'd20c47a859d9cf602d8541c477154c28506a32863cd6bfd391df3eee6009ed76',
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(ROOT, join(dir, e.name))],
  );
}

type Readable = { text: string; line: number };

function readable(path: string, text: string): Readable[] {
  const json = path.endsWith('.json');
  if (!path.endsWith('.ts') && !json) {
    return text.split('\n').map((text, i) => ({ text, line: i + 1 }));
  }
  const source = json
    ? ts.parseJsonText(path, text)
    : ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const statement = source.statements[0];
  const jsonRoot = json && statement && ts.isExpressionStatement(statement)
    ? statement.expression : undefined;
  const out: Readable[] = [];
  const fold = (n: ts.Node): string | undefined => {
    if (ts.isStringLiteral(n) || ts.isTemplateLiteralToken(n)) return n.text;
    if (ts.isParenthesizedExpression(n)) return fold(n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return part(n.left) + part(n.right);
    }
    if (ts.isTemplateExpression(n)) {
      return n.head.text + n.templateSpans.map((s) => part(s.expression) + s.literal.text).join('');
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'join' &&
      ts.isArrayLiteralExpression(n.expression.expression)
    ) {
      const sep = n.arguments.length ? part(n.arguments[0]) : ',';
      return n.expression.expression.elements.map(part).join(sep);
    }
    return undefined;
  };
  // A part known only at runtime reads as a line break; its own strings are still read.
  const part = (n: ts.Node): string => {
    const s = fold(n);
    if (s === undefined) visit(n);
    return s ?? '\n';
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    // This root metadata field is an operator-only id, not program copy.
    if (
      json && ts.isPropertyAssignment(n) &&
      ts.isStringLiteral(n.name) && n.name.text === 'fixture_version' &&
      jsonRoot && ts.isObjectLiteralExpression(jsonRoot) && jsonRoot.properties.includes(n) &&
      ts.isStringLiteral(n.initializer) &&
      /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/i.test(n.initializer.text)
    ) return;
    const s = fold(n);
    if (s === undefined) ts.forEachChild(n, visit);
    else out.push({ text: s, line: source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1 });
  };
  visit(source);
  return out;
}

const violations = (path: string, parts: Readable[], rendered = false) =>
  parts
    .filter(({ text }) =>
      (rendered ? BARRED : WORD).test(text) && (rendered || sha(text) !== HISTORIC[path]),
    )
    .map(({ line }) => `${mask(path)}:${line}: [C-6 word]`);

const hits = (files: Array<[string, string]>) =>
  files.flatMap(([p, t]) => exempt(p) ? [] : violations(p, readable(p, t)));

const sourceLine = (path: string, marker: string) =>
  readFileSync(join(ROOT, path), 'utf8').split('\n').findIndex((line) => line.includes(marker)) + 1;

describe('C-6: no barred word in any server-side text a model or person reads', () => {
  const scanned = [
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'prisma')).filter((p) => /^prisma\/seed-[^/]+$/.test(p)),
    ...walk(join(ROOT, 'seed')).filter((p) => /^seed\/[^/]+\.v1\.json$/.test(p)),
    // seed-foods.ts reads the client-visible names from this fixture.
    'prisma/data/seed-foods.json',
  ].filter((p) => !exempt(p));

  it('every scanned source and seed file is free of the word', () => {
    const files = scanned.map((p): [string, string] => [p, readFileSync(join(ROOT, p), 'utf8')]);
    expect(hits(files)).toEqual([]);
  });

  it.each([
    'src/roman/tools/roman-read-tools.ts',
    'src/roman/guardrails/safety-router.ts',
    'src/roman/guardrails/roman-post-check.ts',
    'src/roman/guardrails/roman-guardrail.contract.ts',
    'src/roman/memory/roman-client-memory.augmenter.ts',
    'src/wearables/insights/wearable-insights.service.ts',
    'src/community/ai-triage/ai-triage.service.ts',
    'src/coach/brief/coach-brief.service.ts',
    'src/ai/adapters/anthropic.adapter.ts',
    'src/ai/coach/coach-ai-execution.controller.ts',
    'src/ai/ai.service.ts',
    'src/public-pages/trust-pages.html.ts',
    'src/email/templates/payment-receipt.hbs',
    'src/contracts/templates/seed/platform-waiver-v1.md',
    CONSENT,
    'prisma/seed-diagnostic.json',
    'prisma/seed-build-week.json',
    'prisma/seed-foods.ts',
    'prisma/seed-recipes.ts',
    'prisma/data/seed-foods.json',
    PROGRAM_SEED,
  ].map((p) => [mask(p), p]))('%s is scanned', (_label, p) => {
    expect(scanned.map(mask)).toContain(mask(p));
  });

  // Planted rows: [case, real file, line appended to it].
  const dto = 'src/invite-codes/coach-code-tools.dto.ts';
  const consent = CONSENT;
  const historic = CONSULT_CONSENT_COPY_V3.paragraphs[2];
  const [a, b] = [W.slice(0, 2), W.slice(2)];
  const plant = (p: string, line: string) =>
    hits([[p, `${readFileSync(join(ROOT, p), 'utf8')}\n${line}\n`]]);

  it.each<[string, string, unknown, number]>([
    ['diagnostic question', 'prisma/seed-diagnostic.json', { prompt: W }, 2],
    ['day narrative', 'prisma/seed-build-week.json', [{ narrative: `${W}al care` }], 3],
    ['food name', 'prisma/data/seed-foods.json', [{ name: W }], 3],
    ['program description', PROGRAM_SEED, { programs: [{ description: W }] }, 4],
    ['nested version is still copy', PROGRAM_SEED, { programs: [{ fixture_version: `${W}-programs.v1` }] }, 4],
    ['prose is not a machine version', PROGRAM_SEED, { fixture_version: `Ask the ${W}` }, 2],
  ])('seed text fails with a masked file and source line: %s', (_case, p, value, line) => {
    expect(hits([[p, JSON.stringify(value, null, 2)]])).toEqual([
      `${mask(p)}:${line}: [C-6 word]`,
    ]);
  });

  it('decodes JSON escapes before checking seed copy', () => {
    const escaped = [...W].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    expect(hits([[PROGRAM_SEED, `{\n  "name": "${escaped}"\n}`]])).toEqual([
      `${mask(PROGRAM_SEED)}:2: [C-6 word]`,
    ]);
  });

  it('JSON machine identifiers stay allowed', () => {
    expect(hits([[PROGRAM_SEED, JSON.stringify({
      fixture_version: `${W}-programs.v1`,
      code: `program_in_${W}_set`,
    })]])).toEqual([]);
  });

  it.each([
    ['plain string', dto, `export const A = 'Ask the ${W} front desk';`],
    ['upper case, inflected', dto, `export const A = \`${W.toUpperCase()}AL CARE for \${'you'}\`;`],
    ['capitalised plural', dto, `export const A = { description: "C${W.slice(1)}ians only" };`],
    ['concatenated literals', dto, `export const A = 'Ask the ${a}' + '${b} desk';`],
    ['concatenated after a runtime value', dto, `export const A = name + ' ${a}' + ('${b}s');`],
    ['static template', dto, `export const A = \`Ask the \${'${a}'}${b}al team\`;`],
    ['literal-array join', dto, `export const A = ['${a}', '${b}ally'].join('');`],
    ['sub- prefix, upper case', dto, `export const A = 'Sub${W}al signs';`],
    ['non- prefix in a template', dto, `export const A = \`non${W}al \${x}\`;`],
    ['pre- prefix', dto, `export const A = 'pre${W}';`],
    ['contract template a client signs', 'src/contracts/templates/seed/platform-waiver-v1.md', W],
    ['new consent copy', consent, `export const V = 'Ask the ${W} desk';`],
    ['historic string, edited', consent, `export const V = ${JSON.stringify(`${historic} `)};`],
    ['historic string elsewhere', dto, `export const A = ${JSON.stringify(historic)};`],
    ['food seed name', 'prisma/seed-foods.ts', `const NAME = '${W}';`],
    ['recipe seed description', 'prisma/seed-recipes.ts', `const DESC = '${a}' + '${b}al';`],
  ])('a planted word fails the guard: %s', (_case, p, line) => {
    const lineNumber = readFileSync(join(ROOT, p), 'utf8').split('\n').length + 1;
    expect(plant(p, line)).toEqual([`${mask(p)}:${lineNumber}: [C-6 word]`]);
  });

  it.each([
    ['identifier and machine code', dto, `export const ${W}ProgramSet = 'program_in_${W}_set';`],
    ['assembled machine code', dto, `export const A = 'program_in_' + '${a}' + '${b}_set';`],
    ['assembled identifier', dto, `export const A = ['${a}', '${b}ProgramSet'].join('');`],
    ['comment', dto, `// a comment naming the ${W}`],
    ['detector regex', dto, `export const DETECT = /(doctor|${W}ian)/i;`],
    ['import and export paths', dto, `import B from './${W}-a';\nexport { A } from './${W}';`],
    ['README handbook', 'src/consent/README.md', W],
    ['test file', 'src/talent-marketplace/__tests__/specialty-alerts.spec.ts', `const A = '${W}';`],
    ['env names and startup reasons', 'src/common/env-validation.ts', `const A = '${W}';`],
    ['historic string in its file', consent, `export const V = ${JSON.stringify(historic)};`],
  ])('identifiers, comments, detectors, paths and exempt files pass: %s', (_case, p, line) => {
    expect(plant(p, line)).toEqual([]);
  });

  // v1/v2 were retired; v3/v4 are pinned acknowledgements, never server-offered
  // copy. Every other entry, including a future spread of either, must be clean.
  it.each(Object.entries(CONSULT_CONSENT_COPIES).filter(
    ([version]) => version !== CONSULT_CONSENT_V3 && version !== CONSULT_CONSENT_V4,
  ))('%s renders without the word', (_version, { copy }) => {
    expect(violations(CONSENT, [{
      text: consultConsentScreenText(copy),
      line: sourceLine(CONSENT, 'export const CONSULT_CONSENT_COPIES:'),
    }], true)).toEqual([]);
  });

  it.each<ClientAiCopyFamily>(['pre57c', 'coached', 'crisis', 'coach_free', 'health', 'health_crisis'])(
    'every server-offered AI consent scope renders without the word: %s',
    (family) => {
      for (const render of [clientAiConsentCopy, clientAiConsentV5Copy]) {
        const copy = render(family);
        expect(violations(AI_CONSENT, [{
          text: `${copy.paragraph.text}\n\n${copy.box_label.text}`,
          line: sourceLine(AI_CONSENT, `export function ${render.name}(`),
        }], true)).toEqual([]);
      }
    },
  );

  it.each([CONSULT_CONSENT_V3, CONSULT_CONSENT_V4])(
    'a newly rendered spread of pinned %s fails, without its historic exemption',
    (version) => {
      const copy = { ...CONSULT_CONSENT_COPIES[version].copy };
      expect(violations(CONSENT, [{ text: consultConsentScreenText(copy), line: 1 }], true))
        .toEqual([`${CONSENT}:1: [C-6 word]`]);
    },
  );

  const legacy = new AiService(
    fakeOf({}),
    fakeOf({ renderForPrompt: () => '' }),
    fakeOf({}),
    fakeOf({}),
    fakeOf({}),
  ).buildSystemPrompt(
    fakeOf({
      identity: { first_name: 'Sam' },
      coach: { has_coach: true, coach_name: 'Alex', last_coach_message_excerpt: null },
      guardrails: { forbid_calorie_recommendations_below: 1200 },
    }),
  );
  const voice = { quipsInSession: 0, exclamationUsed: false };
  const wear = { samples: [], userContext: {} };
  const triage = buildInboxTriagePrompt([]);
  const hf = buildCoachHfPrompt({ ...wear, bucket: WearableMetricBucket.HEALTH_FITNESS });
  const sr = buildCoachSrPrompt({ ...wear, bucket: WearableMetricBucket.SLEEP_RECOVERY });

  it.each([
    ['legacy assistant', legacy, '- A performance coach with 15 years of experience\n'],
    [
      'Roman client contract',
      buildRomanSystemPrompt({ surface: 'client', voice }),
      'Never cold or medical-sounding, never alarmed.',
    ],
    [
      'coach inbox triage',
      triage.system + triage.user,
      'Do NOT diagnose, do NOT give any medical interpretation, do NOT use alarmist language.',
    ],
    [
      'coach health & fitness insight',
      hf.system + hf.user,
      'This is performance coaching, not medical care.',
    ],
    [
      'coach sleep & recovery insight',
      sr.system + sr.user,
      'Frame everything as recovery and habit coaching, not medical care.',
    ],
  ])('%s renders without the word and keeps its boundary', (_name, text, kept) => {
    expect(violations('rendered-server-prompt', [{ text, line: 1 }], true)).toEqual([]);
    expect(text).toContain(kept);
  });
});
