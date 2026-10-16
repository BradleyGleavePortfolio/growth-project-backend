// Owner rule C-6 (A1): no text a model or a person reads uses the barred
// medical-practice word. The word is only ever assembled at runtime, so this
// file never carries it.
//
// One guard, class-first (SoT A2 items 12-13): every file under src/ is
// scanned except the short EXEMPT list below. In .ts files the guard reads
// every string and template literal, which is where prompts, Roman tool
// descriptions, safety-router hints, Roman's fixed safe replies, JSON-repair
// prompts, coach drafting prompts, Swagger text, errors, pushes, emails and
// pages live. It skips comments, import paths and regex literals (detector
// patterns), and only a whole word trips it, so identifiers and machine codes
// built on the word do not. Other files (email templates, JSON) are read whole.
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';
import { WearableMetricBucket } from '@prisma/client';
import { AiService } from '../src/ai/ai.service';
import { buildRomanSystemPrompt } from '../src/roman/roman.prompts';
import buildInboxTriagePrompt from '../src/community/ai-triage/prompts/inbox-triage.prompt';
import { buildCoachHfPrompt } from '../src/wearables/insights/prompts/coach-hf.prompt';
import { buildCoachSrPrompt } from '../src/wearables/insights/prompts/coach-sr.prompt';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const BARRED = /cl[i]nic/i;
const WORD = /(?<![\w$])cl[i]nic(?:al(?:ly)?|ians?|s)?(?![\w$])/i;
const W = ['cl', 'inic'].join('');
const ROOT = join(__dirname, '..');

// Path (from the repo root) -> why nobody reads it. Keep this list short.
const EXEMPT: Array<[RegExp, string]> = [
  [/^src\/onboarding\/consult-consent-copy\.ts$/, 'pinned historical consent copy v3/v4 (sha256-pinned)'],
  [/^src\/common\/env-validation\.ts$/, 'env var names and operator-only startup reasons'],
  [/\.md$/, 'developer handbooks, never sent to a model or shown in the app'],
  [/\.spec\.ts$/, 'tests, never shipped'],
];
const exempt = (path: string) => EXEMPT.some(([re]) => re.test(path));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(ROOT, join(dir, e.name))],
  );
}

function readable(path: string, text: string): string[] {
  if (!path.endsWith('.ts')) return [text];
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isTemplateLiteralToken(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest));
  return out;
}

const hits = (files: Array<[string, string]>) =>
  files
    .filter(([p, t]) => !exempt(p) && BARRED.test(t) && readable(p, t).some((s) => WORD.test(s)))
    .map(([p]) => p);

describe('C-6: no barred word in any server-side text a model or person reads', () => {
  const scanned = walk(join(ROOT, 'src')).filter((p) => !exempt(p));

  it('every scanned file under src/ is free of the word', () => {
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
  ])('%s is scanned', (p) => {
    expect(scanned).toContain(p);
  });

  const dto = 'src/invite-codes/coach-code-tools.dto.ts';
  const plant = (line: string) => hits([[dto, `${readFileSync(join(ROOT, dto), 'utf8')}\n${line}\n`]]);

  it.each([
    `export const A = 'Ask the ${W} front desk';`,
    `export const A = \`${W.toUpperCase()}AL CARE for \${'you'}\`;`,
    `export const A = { description: "${W[0].toUpperCase()}${W.slice(1)}ians only" };`,
  ])('a planted word fails the guard: %s', (line) => {
    expect(plant(line)).toEqual([dto]);
  });

  it.each([
    `export const ${W}ProgramSet = 'program_in_${W}_set';`,
    `// a comment naming the ${W}`,
    `export const DETECT = /(doctor|${W}ian)/i;`,
    `export { A } from './${W}-programs';`,
  ])('identifiers, comments, detectors and paths pass: %s', (line) => {
    expect(plant(line)).toEqual([]);
  });

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
    expect(text).not.toMatch(BARRED);
    expect(text).toContain(kept);
  });
});
