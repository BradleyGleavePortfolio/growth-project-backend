/**
 * The coach daily brief must call a model the provider still serves. It used
 * claude-3-5-sonnet-20241022 after that id was retired, so every generation
 * failed and coaches only ever saw the fallback narrative.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { COACH_AI_MODEL } from '../src/ai/coach/coach-ai.constants';
import { BRIEF_CLAUDE_MODEL } from '../src/coach/brief/coach-brief.service';
import { ROMAN_MODEL_PHASE_1 } from '../src/roman/anthropic-client.provider';

const RETIRED = /claude-(?:3-5|3-7)-sonnet|claude-3-(?:opus|sonnet|haiku)|claude-(?:2|instant)/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('coach brief model', () => {
  it('uses current-generation models: Opus 5.5 for the brief, Sonnet 5.5 for Coach AI and Roman (B-ROMANIQ-125)', () => {
    expect(BRIEF_CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(COACH_AI_MODEL).toBe('claude-sonnet-5-5');
    expect(ROMAN_MODEL_PHASE_1).toBe(COACH_AI_MODEL);
    expect(BRIEF_CLAUDE_MODEL).not.toMatch(RETIRED);
  });

  it('no runtime source file names a retired Claude model id (comments excepted)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, '..', 'src'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
          if (RETIRED.test(code)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
