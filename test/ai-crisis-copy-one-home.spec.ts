/**
 * CRISIS-TEXT-BE step 6 (#202-S5): one copy of each crisis sentence on the server. The sentences live in
 * src/ai/ai-crisis-router.ts; every full message that uses one keeps every byte, pinned by sha-256 of the message as
 * it stood at main 76a1de0c, and this walk fails if a homed sentence is typed anywhere else in a .ts file under src.
 * Prose copies in src/*\/README.md are docs, not code. Guideline 7 has one server code copy (community-safety.service.ts,
 * pinned by community-safety-copy.spec.ts); the 911/988 lines that have only one copy stay where they are.
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  AI_GUIDE_CRISIS_REPLIES,
  CRISIS_LINE_CALL_911_NOW,
  CRISIS_LINE_DANGER_911,
  CRISIS_LINE_REACH_988,
  CRISIS_LINE_STAY_WHERE_YOU_ARE,
  CRISIS_LINE_TELL_SOMEONE,
} from '../src/ai/ai-crisis-router';
import { romanEatingDisorderFallback, ROMAN_SAFETY_TEMPLATES } from '../src/roman/guardrails/safety-router';

const SRC = join(__dirname, '../src');
const HOME = 'ai/ai-crisis-router.ts';
const HOMED = [
  CRISIS_LINE_CALL_911_NOW,
  CRISIS_LINE_STAY_WHERE_YOU_ARE,
  CRISIS_LINE_REACH_988,
  CRISIS_LINE_DANGER_911,
  CRISIS_LINE_TELL_SOMEONE,
];

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

/** Every place a homed sentence is typed outside its home. */
export function typedElsewhere(files: Array<{ name: string; text: string }>): string[] {
  return files.flatMap(({ name, text }) =>
    name === HOME ? [] : HOMED.filter((sentence) => text.includes(sentence)).map((sentence) => `${name}: ${sentence}`),
  );
}

describe('#202-S5: one copy of each crisis sentence on the server', () => {
  it('no homed sentence is typed anywhere under src but its home', () => {
    const files = walk(SRC).map((p) => ({ name: relative(SRC, p), text: readFileSync(p, 'utf8') }));
    expect(files.length).toBeGreaterThan(100);
    expect(typedElsewhere(files)).toEqual([]);
  });

  it('the home holds each sentence once, and the walk would catch a typed copy', () => {
    const home = readFileSync(join(SRC, HOME), 'utf8');
    for (const sentence of HOMED) expect(home.split(sentence).length - 1).toBe(1);
    expect(typedElsewhere([{ name: 'x.ts', text: `const a = '${CRISIS_LINE_DANGER_911}';` }])).toHaveLength(1);
  });

  it.each([
    ['ROMAN_SAFETY_TEMPLATES.emergency', ROMAN_SAFETY_TEMPLATES.emergency, '2ada51918751d10596ed25ac4a379c18494da59e04d95a100ce5ac0e86241250'],
    ['ROMAN_SAFETY_TEMPLATES.self_harm', ROMAN_SAFETY_TEMPLATES.self_harm, '983a207c5c92d240e3ecf4137c13a1def48dfc531d97920177ee34373f6eadd7'],
    ['ROMAN_SAFETY_TEMPLATES.urgent_symptoms', ROMAN_SAFETY_TEMPLATES.urgent_symptoms, '53225e75f97316ec7610a9aee8ec3ed416db29666e90590eeb6de8a5d7478ca9'],
    ['AI_GUIDE_CRISIS_REPLIES.emergency', AI_GUIDE_CRISIS_REPLIES.emergency, '69708d30372307c780cfe5fa721465b1b4e9e12be2a5b9f81a92ae033753716e'],
    ['AI_GUIDE_CRISIS_REPLIES.self_harm', AI_GUIDE_CRISIS_REPLIES.self_harm, '2147fd372253f72f151fb81b5c8c39dea95340ac5cda6829fcf73dab25cda147'],
    ['romanEatingDisorderFallback(false)', romanEatingDisorderFallback(false), '8e54f17119750b6505a6ac9d0773523ac1d9e63ceb1608eb66679fab58eeebd7'],
    ['romanEatingDisorderFallback(true,false)', romanEatingDisorderFallback(true, false), '32d79443f63884bd3c3aa9304effdb98080b00d00be2e4b5f7088f2a7882c824'],
    ['romanEatingDisorderFallback(true,true)', romanEatingDisorderFallback(true, true), '12c72d68fdb5e43ab1381fd8483994939a9b86e290cb5658e674cdd70d8ded65'],
  ])('%s keeps every byte of main', (_name, message, hash) => {
    expect(sha(message)).toBe(hash);
  });
});
