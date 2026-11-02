import {
  BRIEF_MAX_NARRATIVE_CHARS,
  briefPaymentLines,
  validateClaudeNarrative,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import { makeBriefContext } from './_fixtures/coach-brief-mocks';

describe('LS-1195 known follow-up: long approved AI payment text is trimmed', () => {
  it('documents that PF-W9 insertion can remove the coach-restart instruction', () => {
    const context = makeBriefContext({
      dunning_in_progress: 1,
      dunning_locked: 1,
      dunning_on_hold: 1,
      coach_account_waiting: 1,
    });
    const lines = briefPaymentLines(context);
    const prose =
      'Sarah, five of seven clients checked in today, with their completed sessions, ' +
      'recent progress, and questions ready for your review before you plan the next ' +
      'round of coaching conversations and decide which clients need a closer look. ' +
      'Two client messages still need a reply, and the remaining check-ins are listed below for you to review today.';
    const original = `${prose} ${lines.join(' ')}`;
    expect(original.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
    expect(validateClaudeNarrative(original, 'Sarah', lines)).toBeNull();

    const shown = withCoachAccountWaiting(original, context);
    expect(shown).toContain(coachAccountWaitingLine(1));
    expect(shown.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
    expect(shown).not.toContain(lines[lines.length - 1]);
  });
});
