import {
  buildFallbackNarrative,
  buildHeadCoachActionItems,
} from '../src/coach/brief/coach-brief.service';
import {
  makeBriefContext,
  makeHeadCoachContext,
} from './_fixtures/coach-brief-mocks';

// A refund/dispute pause remains an active DunningState. Both production
// context queries count active states without filtering the pause reason.
// The resulting context therefore has a positive count but no evidence that
// an automatic retry will happen. Only the coach may restart this billing.
describe('LS-PAYFAIL B5: coach-only-restart billing pauses', () => {
  it.each(['solo_coach', 'sub_coach', 'head_coach'] as const)(
    'LS-PAYFAIL B5: %s briefs never promise automatic retries for coach-only-restart pauses',
    (mode) => {
      const context = mode === 'head_coach'
        ? makeHeadCoachContext({
            dunning_in_progress: 1,
            dunning_amount_cents: 10000,
          })
        : makeBriefContext({
            brief_mode: mode,
            dunning_in_progress: 1,
          });

      const narrative = buildFallbackNarrative(context);

      expect(narrative).not.toMatch(
        /being retried automatically|nothing is needed from you/i,
      );
    },
  );

  it('LS-PAYFAIL B5: the deterministic money item does not promise that TGP retries paused billing', () => {
    const context = makeHeadCoachContext({
      dunning_in_progress: 1,
      dunning_amount_cents: 10000,
    });

    const item = buildHeadCoachActionItems(context)
      .find((candidate) => candidate.type === 'dunning_queue');

    expect(item).toBeDefined();
    expect(item!.detail).not.toMatch(/being retried by TGP/i);
  });
});
