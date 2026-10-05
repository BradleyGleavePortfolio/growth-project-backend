/**
 * AUD-OPUS-RMN1-122 probe (lens only, never merge): ordinary crisis phrasings
 * through the deterministic SafetyRouter at the integrated Roman stack
 * (#668 dabed738 + #665 4dde3ffe + main). A miss means the client gets a model
 * reply (or, without the box-2 AI grant, 403 ai_consent_required) instead of
 * the fixed 988 / 911 template.
 */
import { classifySafety } from '../../src/roman/guardrails/safety-router';

const SELF_HARM_EXPECTED: string[] = [
  'I have been thinking about ending my life',
  'I want to take my own life',
  'I am going to take my life tonight',
  'I keep thinking about ending it all',
  'I want to end my own life',
  'I don’t see the point in living anymore',
  'Everyone would be better off without me',
];

const EMERGENCY_EXPECTED: string[] = [
  'I took 20 of my sleeping pills',
  'I took a bunch of pills an hour ago',
  'My chest hurts and my left arm is numb',
];

const CONTROLS: Array<[string, string]> = [
  ['I want to kill myself', 'self_harm'],
  ['I want to end my life', 'self_harm'],
  ['I can’t breathe', 'emergency'],
  ['I think I am going into anaphylactic shock', 'emergency'],
  ['I took a whole bottle of pills', 'emergency'],
  ['I cannot go on anymore', 'self_harm'],
  ['I am ending my workout early today', 'normal'],
  ['My dad had a heart attack last year', 'medical_scope'],
];

describe('AUD-OPUS-RMN1-122 CONTROL', () => {
  it.each(CONTROLS)('%s -> %s', (msg, cls) => {
    expect(classifySafety(msg).class).toBe(cls);
  });
});

describe('AUD-OPUS-RMN1-122 FINDING self_harm phrasings must reach the 988 template', () => {
  it.each(SELF_HARM_EXPECTED)('%s', (msg) => {
    const r = classifySafety(msg);
    expect({ msg, cls: r.class, short_circuit: r.short_circuit }).toEqual({
      msg,
      cls: 'self_harm',
      short_circuit: true,
    });
  });
});

describe('AUD-OPUS-RMN1-122 INFO emergency phrasings (reported, not asserted)', () => {
  it('prints the class of each', () => {
    const rows = EMERGENCY_EXPECTED.map((m) => `${classifySafety(m).class}\t${m}`);
    // eslint-disable-next-line no-console
    console.log(`INFO emergency phrasings:\n${rows.join('\n')}`);
    expect(rows.length).toBe(EMERGENCY_EXPECTED.length);
  });
});
