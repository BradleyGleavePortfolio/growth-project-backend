import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';

const root = join(__dirname, '..');
const trustSource = readFileSync(join(root, 'src/public-pages/trust-pages.html.ts'), 'utf8');
const specSource = readFileSync(join(__dirname, 'privacy-openai-photo-check.spec.ts'), 'utf8');
const vendorSource = readFileSync(join(root, 'docs/privacy/vendor-deletion-and-backups.md'), 'utf8');
const compile = (source: string) => transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

/** Run the builder's actual four test callbacks against an in-memory mutation.
 * No repository source, workflow or production setting is changed.
 */
function failedBuilderTests(source: string, vendor = vendorSource): string[] {
  const exports: Record<string, unknown> = {};
  runInNewContext(compile(source), {
    exports,
    require: (id: string) => {
      if (id === '../roman/roman.feature') return {
        ROMAN_CRISIS_TOLD_SENTENCE: '',
        ROMAN_HEALTH_NOTES_SENTENCE: '',
        isRomanCrisisAlertEnabled: () => false,
      };
      throw new Error(`Unexpected trust-page import: ${id}`);
    },
  });
  const tests: Array<{ name: string; run: () => void }> = [];
  runInNewContext(compile(specSource), {
    exports: {},
    __dirname,
    expect,
    describe: (_name: string, run: () => void) => run(),
    it: (name: string, run: () => void) => tests.push({ name, run }),
    require: (id: string) => {
      if (id === 'fs') return { readFileSync: () => vendor };
      if (id === 'path') return { join };
      if (id === '../src/public-pages/trust-pages.html') return exports;
      throw new Error(`Unexpected policy-test import: ${id}`);
    },
  });
  if (tests.length !== 4) throw new Error('Expected the four reviewed builder tests');
  return tests.flatMap(({ name, run }) => {
    try { run(); return []; } catch { return [name]; }
  });
}

describe('LS-1187 independent policy review', () => {
  it('B2: Consumer Health sharing identifies the processor receiving health-related Community captions', () => {
    const html = renderTrustPage('consumer-health');
    expect(html).toContain('anything health-related you write to your coach, in a community space or to Roman');
    const start = html.indexOf('<h2>Categories we share</h2>');
    const section = html.slice(start, html.indexOf('</section>', start));
    expect(section).toContain('OpenAI');
  });

  it('mutation baseline: all four builder tests execute and pass', () => {
    expect(failedBuilderTests(trustSource)).toEqual([]);
  });

  it('mutation: changing the approved em dash makes the exact-line check fail', () => {
    const mutated = trustSource.replace('OpenAI — an automatic safety check', 'OpenAI - an automatic safety check');
    expect(mutated).not.toBe(trustSource);
    expect(failedBuilderTests(mutated)).toContain('shows the approved line word for word in "Service providers", once on the page');
  });

  it('mutation: moving OpenAI before Anthropic makes the order check fail', () => {
    const lines = trustSource.split('\n');
    const openAI = lines.findIndex((line) => line.includes("'OpenAI — an automatic safety check"));
    expect(openAI).toBeGreaterThan(0);
    [lines[openAI - 1], lines[openAI]] = [lines[openAI], lines[openAI - 1]];
    expect(failedBuilderTests(lines.join('\n'))).toContain('sits in the AI group: right after Anthropic, before Perplexity; no other bullet moved');
  });

  it('mutation: restoring the old date makes the date check fail', () => {
    const mutated = trustSource.replace("POLICY_LAST_REVIEWED = '2026-10-30'", "POLICY_LAST_REVIEWED = '2026-10-20'");
    expect(mutated).not.toBe(trustSource);
    expect(failedBuilderTests(mutated)).toContain('bumps the Last reviewed date shown at the top, as the policy says it does');
  });

  it('mutation: restoring the stale vendor status makes the vendor-row check fail', () => {
    const mutated = vendorSource.replace('Named in the Privacy Policy "Service providers" list', 'UNVERIFIED: the Privacy Policy does not name OpenAI yet');
    expect(mutated).not.toBe(vendorSource);
    expect(failedBuilderTests(trustSource, mutated)).toContain('the vendor record no longer says the policy does not name OpenAI');
  });

  it('characterises the date test accurately: later dates are intentionally not pinned', () => {
    const mutated = trustSource.replace("POLICY_LAST_REVIEWED = '2026-10-30'", "POLICY_LAST_REVIEWED = '2026-10-31'");
    expect(mutated).not.toBe(trustSource);
    expect(failedBuilderTests(mutated)).toEqual([]);
  });
});
