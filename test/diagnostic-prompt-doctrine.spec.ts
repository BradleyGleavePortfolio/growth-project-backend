import * as fs from 'fs';
import * as path from 'path';

/**
 * Doctrine guard for the Phase 3 diagnostic AI prompt.
 *
 * Voice rules (no emoji, no hype, numbers over adjectives, 300-400 words,
 * second person, no Markdown headings) live inside ROADMAP_SYSTEM_PROMPT.
 * If a future PR softens any of those rules, the prompt is silently no
 * longer Growth-Project voice — and a model that returns "Great job 🎉"
 * because the "no emoji" line was deleted is a copy regression we cannot
 * detect at runtime.
 *
 * This spec asserts the canonical opening line, the explicit "no emoji /
 * exclamation marks / em-dashes" rule, the 300-400 word cap, and the
 * four-paragraph structure. Edits to those rules MUST update both the
 * source AND this spec in the same change — the discomfort is the point.
 */
describe('diagnostic AI prompt doctrine — ROADMAP_SYSTEM_PROMPT pin', () => {
  const promptPath = path.resolve(
    __dirname,
    '..',
    'src',
    'diagnostic',
    'ai-roadmap.service.ts',
  );
  const source = fs.readFileSync(promptPath, 'utf8');

  it('exports the canonical opening line', () => {
    expect(source).toContain(
      'You are the diagnostic analyst for The Growth Project.',
    );
  });

  it('names the three diagnostic sections verbatim', () => {
    expect(source).toContain('Income Architecture');
    expect(source).toContain('Body Protocol');
    expect(source).toContain('Calendar & Lifestyle Architecture');
  });

  it('pins the no-emoji / no-hype voice rules', () => {
    expect(source).toContain('No emoji.');
    expect(source).toContain('No exclamation marks.');
    expect(source).toContain('No em-dashes.');
    expect(source).toContain('No corporate wellness vocabulary.');
    expect(source).toContain('Numbers over adjectives.');
  });

  it('pins the word-count window (300-400)', () => {
    expect(source).toContain('300 to 400 words total. Do not exceed 400.');
  });

  it('pins the four-paragraph output structure', () => {
    expect(source).toContain('Overall assessment');
    expect(source).toContain('Top strength');
    expect(source).toContain('Biggest gap');
    expect(source).toContain('The next 90 days');
  });

  it('forbids Markdown headings in the output', () => {
    expect(source).toContain('Do not use Markdown headings.');
  });

  it('exports a stable prompt_version constant', () => {
    expect(source).toMatch(/export const ROADMAP_PROMPT_VERSION\s*=\s*['"]v1['"]/);
  });
});
