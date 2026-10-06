// AUD-OPUS-RMN3-122 probe for A-666-3 (drop into test/roman/). FINDING tests fail at #666 8cfad607;
// CONTROL tests must stay green after the fix.
import { classifySafety } from '../../src/roman/guardrails/safety-router';

describe('AUD-OPUS-RMN3-122 A-666-3 overdose named by the medicine, not the word "pills"', () => {
  const crisis = [
    'I took a whole bottle of Tylenol',
    'I just swallowed a bottle of Advil',
    'I took 30 Tylenol',
    'I took 20 ibuprofen an hour ago',
    'I took a bunch of Xanax',
    'I took a whole bottle of my sleeping meds',
  ];
  it.each(crisis)('FINDING: %s -> emergency', (msg) => {
    expect(classifySafety(msg).class).toBe('emergency');
    expect(classifySafety(msg).short_circuit).toBe(true);
  });

  const ordinary = [
    'I took 2 Tylenol for my headache',
    'I took 2 pills of ibuprofen for my headache',
    'Can I take Advil before a run?',
    'I took a whole bottle of water to the gym',
    'I took lots of vitamins',
    'Can I end my workout early today?',
  ];
  it.each(ordinary)('CONTROL: %s -> not emergency / self_harm', (msg) => {
    const cls = classifySafety(msg).class;
    expect(cls === 'emergency' || cls === 'self_harm').toBe(false);
  });
});
