// B-AIG2-122 — AI guide crisis router phrase table. Crisis phrases a client
// types route to 911 / 988; ordinary training, food and supplement phrasing
// returns null so the client gets the normal answer.
import { classifyAiGuideCrisis } from '../src/ai/ai-crisis-router';

describe('classifyAiGuideCrisis (B-AIG2-122)', () => {
  it.each([
    'I took a whole bottle of Tylenol',
    'I swallowed a whole bottle of ibuprofen',
    'I took 20 Tylenol',
    'I took a whole bottle of pills',
    'I took 20 of my sleeping pills',
    'I overdosed',
    'I took an overdose',
    'my friend overdosed',
    'I can’t breathe',
    'my friend is unconscious',
  ])('"%s" is an emergency (911)', (message) => {
    expect(classifyAiGuideCrisis(message)).toBe('emergency');
  });

  it.each([
    'I am going to hang myself',
    'I want to hang myself',
    'I am going to shoot myself',
    'I want to jump off a bridge',
    'I am going to jump off the roof',
    'I want to slit my wrists',
    'I just want it all to end',
    'I want to kill myself',
    'I want to hurt myself',
    'I have been cutting myself',
  ])('"%s" is self-harm (988)', (message) => {
    expect(classifyAiGuideCrisis(message)).toBe('self_harm');
  });

  it.each([
    'overdose on cardio',
    'can you overdose on creatine?',
    'I think I overdosed on cardio this week',
    'is it possible to overdose on caffeine from pre-workout',
    'how much protein is an overdose',
    'did I overdose on carbs last night',
    'is mercury poisoning a risk if I eat tuna every day',
    'I hurt myself deadlifting, can I train?',
    'I find it hard to breathe during heavy squats, how should I brace',
    'I can’t breathe through my nose when I run, any tips',
    'I have trouble breathing on long runs',
    'how do I stop unconscious snacking at night',
    'kill this workout',
    "I'm dying after leg day",
    'took 2 Tylenol for my headache',
  ])('"%s" is an ordinary question (no crisis reply)', (message) => {
    expect(classifyAiGuideCrisis(message)).toBeNull();
  });
});

// B-AIG3-123 — a stated plan to overdose (988) and an explicit inability to
// breathe after training (911) still get the crisis reply.
describe('classifyAiGuideCrisis (B-AIG3-123)', () => {
  it.each([
    ['I want to overdose tonight', 'self_harm'],
    ['I am going to overdose', 'self_harm'],
    ['I cannot breathe after my workout. I need help now.', 'emergency'],
    ['I can’t breathe during my workout. Please help me.', 'emergency'],
    ['my chest hurts and I can’t breathe after my run', 'emergency'],
  ])('"%s" is %s', (message, expected) => {
    expect(classifyAiGuideCrisis(message)).toBe(expected);
  });
});
