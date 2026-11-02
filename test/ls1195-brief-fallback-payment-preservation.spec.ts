import {
  BRIEF_MAX_NARRATIVE_CHARS,
  briefPaymentLines,
  buildFallbackNarrative,
} from '../src/coach/brief/coach-brief.service';
import { coachAccountWaitingLine } from '../src/checkout/dunning-v2/coach-account-hold';
import { makeBriefContext, makeHeadCoachContext } from './_fixtures/coach-brief-mocks';

describe('LS-1195: deterministic fallback preserves the existing payment story', () => {
  it.each([
    makeBriefContext({
      revenue_today_cents: 9800,
      paid_today_count: 1,
      dunning_in_progress: 3,
      dunning_locked: 2,
      dunning_on_hold: 1,
      unread_messages: 2,
      weight_logs_flagged: 1,
      coach_account_waiting: 1,
    }),
    makeHeadCoachContext({
      dunning_in_progress: 3,
      dunning_amount_cents: 44700,
      dunning_locked: 1,
      dunning_locked_amount_cents: 14900,
      dunning_on_hold: 1,
      coach_account_waiting: 1,
    }),
  ])('$brief_mode keeps every approved payment line alongside PF-W9', (context) => {
    const narrative = buildFallbackNarrative(context);
    expect(narrative).toContain(coachAccountWaitingLine(1));
    for (const paymentLine of briefPaymentLines(context)) {
      expect(narrative).toContain(paymentLine);
    }
    expect(narrative.length).toBeLessThanOrEqual(BRIEF_MAX_NARRATIVE_CHARS);
  });
});
