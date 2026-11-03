import {
  BRIEF_MAX_NARRATIVE_CHARS,
  briefPaymentLines,
  validateClaudeNarrative,
  withCoachAccountWaiting,
} from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import { makeBriefContext } from './_fixtures/coach-brief-mocks';

// HOLD-FU-BE F3 (LS-1195 C3): this test documented the follow-up (PF-W9 put in
// could cut the coach-restart line). Fixed: every payment line is kept.
describe('LS-1195 follow-up fixed: long approved AI payment text keeps every payment line', () => {
  it('PF-W9 insertion never removes the coach-restart instruction', () => {
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
    for (const line of lines) expect(shown).toContain(line);
  });
});
