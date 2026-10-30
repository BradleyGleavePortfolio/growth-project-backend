// FR-1191 (LS-1191 C1, LO-1191 N3): the approved payment lines are copied
// word for word, two sentences each, so they never use up the brief's own
// 2-to-5 sentence budget. Before this, a brief with every payment state
// (6 approved sentences) could never pass and always fell back.
import 'reflect-metadata';
import {
  buildHeadCoachSystemPrompt,
  buildSoloCoachSystemPrompt,
  validateClaudeNarrative,
} from '../src/coach/brief/coach-brief.service';

const W1 = '1 payment failed. TGP is reminding the client to update their card.';
const W2 = 'Access is paused on 1 plan after 10 days unpaid. It comes back when the client pays.';
const W3 = '1 plan is on hold after a refund or a bank dispute. Only you can restart it.';
const OPEN = 'Good morning, Sarah. $98 came in from 2 payments since midnight.';
const CLOSE = '3 messages are waiting. 2 action items are below.';

describe('FR-1191: payment lines sit outside the sentence budget', () => {
  it.each([
    ['one line', [W1]],
    ['two lines', [W1, W2]],
    ['all three lines', [W1, W2, W3]],
  ])('%s with four sentences of its own passes', (_name, lines) => {
    const narrative = `${OPEN} ${lines.join(' ')} ${CLOSE}`;
    expect(validateClaudeNarrative(narrative, 'Sarah', lines)).toBeNull();
  });

  it('six sentences of its own still fail, payment lines or not', () => {
    const six = `${OPEN} ${W1} ${CLOSE} 4 workouts were done. 1 client is flagged.`;
    expect(validateClaudeNarrative(six, 'Sarah', [W1])).toBe('too_many_sentences:6');
  });

  it('a missing or reworded line is still refused', () => {
    expect(validateClaudeNarrative(`${OPEN} ${W1} ${CLOSE}`, 'Sarah', [W1, W2])).toBe('missing_payment_line');
  });

  it.each([['solo', buildSoloCoachSystemPrompt()], ['head', buildHeadCoachSystemPrompt()]])(
    '%s prompt tells the model the lines are outside its own budget',
    (_name, prompt) => {
      expect(prompt).toContain('not counting the PAYMENT LINES');
      expect(prompt).toContain('under 600 characters');
    },
  );
});
