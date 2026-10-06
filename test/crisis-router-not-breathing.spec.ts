// F9 (B-CRISIS2-123) — router table for both crisis routers (AI guide and
// Roman share one 911 list). A person who is not breathing or will not wake
// up, and an overdose typed as "ODed", "OD'd", "OD'ed" or "O.D.", gets the
// fixed 911 reply on both surfaces. Ordinary gym talk keeps its normal answer.
import { classifyAiGuideCrisis } from '../src/ai/ai-crisis-router';
import { classifySafety } from '../src/roman/guardrails/safety-router';

// Each of these got no 911 reply on main e9b82e13 (AI guide null, Roman
// normal or medical_scope).
const NOT_BREATHING_911 = [
  'my teammate passed out and is not breathing',
  "he's not breathing",
  "she's not breathing",
  'my teammate is not breathing',
  'unconscious and not breathing',
  'he stopped breathing',
  "she won't wake up",
  "he won't wake up",
  "my friend won't wake up",
  'she will not wake up',
  "my teammate passed out and won't wake up",
  "she's not waking up",
  'my son is not waking up',
  "the baby won't wake up",
];

const OD_SPELLINGS_911 = [
  'my friend ODed',
  'he ODed',
  'they ODed',
  'I ODed',
  'I think my roommate ODed',
  'my teammate ODed last night',
  'a guy at my gym ODed',
  "my brother OD'ed",
  "she OD'ed",
  'my friend O.D.',
  'he O.D.',
  "my friend O.D.'d",
  'she O.D.ed',
  "someone at the gym O.D.'d",
  'possible O.D.',
];

// Already 911 on main (b#744); kept here so the new spellings do not lose them.
const STILL_911 = [
  "my friend OD'd",
  "he OD'd",
  "he's ODing",
  'my teammate overdosed',
  'he overdosed',
  'I think she overdosed',
  'he is unconscious and not breathing',
  'my dad is not breathing',
  "I can't breathe",
  'I cannot breathe after my workout',
  'I cannot breathe after my workout. I need help now.',
  'I can’t breathe during my workout. Please help me.',
  "I can't breathe during squats and my chest hurts",
];

// Got 911 on main; ordinary gym talk.
const NOW_NORMAL = [
  "can't breathe during burpees",
  "I can't breathe during burpees",
  'he is odd',
  'I have odd soreness after leg day',
];

// Normal on main and still normal.
const GYM_CONTROLS = [
  'hold your breath on the brace',
  'should I hold my breath on the brace',
  'I get out of breath on the stairs',
  'out of breath after sprints',
  'creatine overdose?',
  'can you overdose on creatine?',
  'suicide sprints today',
  'we did suicide sprints',
  'not breathing properly during squats',
  'I keep not breathing on the way up',
  'I stopped breathing through my mouth when I run',
  "she won't wake up early for training",
  "he won't wake up for morning cardio",
  "my husband won't wake up early to train with me",
  "I can't wake up early for the gym",
  "my legs won't wake up this morning",
  'I ODed on cardio this week',
  'Oded is my training partner',
];

function expect911(message: string): void {
  expect(classifyAiGuideCrisis(message)).toBe('emergency');
  const roman = classifySafety(message);
  expect(roman.class).toBe('emergency');
  expect(roman.short_circuit).toBe(true);
}

function expectNormal(message: string): void {
  expect(classifyAiGuideCrisis(message)).toBeNull();
  const roman = classifySafety(message);
  expect(['emergency', 'self_harm']).not.toContain(roman.class);
  expect(roman.short_circuit).toBe(false);
}

describe('F9 a person who is not breathing or will not wake up is 911 on both routers', () => {
  it.each(NOT_BREATHING_911)('"%s" is 911 on both', expect911);
});

describe("F9 an overdose typed as ODed / OD'ed / O.D. is 911 on both routers", () => {
  it.each(OD_SPELLINGS_911)('"%s" is 911 on both', expect911);
  it.each(STILL_911)('"%s" is still 911 on both', expect911);
});

describe('F9 gym talk keeps the normal answer on both routers', () => {
  it.each(NOW_NORMAL)('"%s" is no longer sent to 911', expectNormal);
  it.each(GYM_CONTROLS)('"%s" stays normal', expectNormal);
});
