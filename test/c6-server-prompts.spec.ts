// Owner rule C-6 (A1): server-side text never uses the barred
// medical-practice word. The pattern is written as a character class so this
// file never carries the word itself.
//
// One guard, class-first: (1) every source file that builds an AI prompt (a
// path with "prompt", or a "You are ..." / REPLY CONTRACT / system: block) is
// free of the word, so a new prompt is covered without editing this list;
// (2) each prompt C6-SERVER reworded renders without it and keeps its
// boundary sentence (meaning kept, wording pinned).
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { WearableMetricBucket } from '@prisma/client';
import { AiService } from '../src/ai/ai.service';
import { buildRomanSystemPrompt } from '../src/roman/roman.prompts';
import buildInboxTriagePrompt from '../src/community/ai-triage/prompts/inbox-triage.prompt';
import { buildCoachHfPrompt } from '../src/wearables/insights/prompts/coach-hf.prompt';
import { buildCoachSrPrompt } from '../src/wearables/insights/prompts/coach-sr.prompt';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const BARRED = /cl[i]nic/i;
const SRC = join(__dirname, '..', 'src');
const PROMPT_BLOCK = /You are (an?|the|GP|Roman)\b|REPLY CONTRACT|\bsystem: /;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('C-6: no barred word in server-side AI prompts', () => {
  const promptFiles = sources(SRC).filter(
    (p) => /prompt/i.test(relative(SRC, p)) || PROMPT_BLOCK.test(readFileSync(p, 'utf8')),
  );

  it('finds the prompt sources (the discovery rule still matches)', () => {
    expect(promptFiles.length).toBeGreaterThanOrEqual(20);
  });

  it('every prompt source file is free of the word', () => {
    const hits = promptFiles.filter((p) => BARRED.test(readFileSync(p, 'utf8')));
    expect(hits.map((p) => relative(SRC, p))).toEqual([]);
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
    [
      'legacy assistant',
      legacy,
      '- A registered dietician with 15 years of performance experience\n',
    ],
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
