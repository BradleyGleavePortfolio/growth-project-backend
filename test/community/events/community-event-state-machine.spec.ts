/**
 * community-event-state-machine.spec.ts — the v2-3 five-state machine.
 *
 * Pure, DB-free unit coverage of the forward-only lifecycle:
 *   scheduled → tomorrow → live → replay → reflected
 *
 * Covers the brief's required "five-state machine" test plus the structural
 * invariants the service relies on (forward-only, no rewind, terminal state,
 * typed rejection reasons).
 */

import 'reflect-metadata';
import { CommunityEventState } from '@prisma/client';
import {
  EVENT_STATE_ORDER,
  EVENT_STATE_TRANSITIONS,
  canTransition,
  eventStateRank,
  explainTransition,
  isTerminalEventState,
} from '../../../src/community/events/community-event-state-machine';

describe('community event state machine (v2-3)', () => {
  it('orders the five states exactly as the product lifecycle', () => {
    expect(EVENT_STATE_ORDER).toEqual([
      CommunityEventState.scheduled,
      CommunityEventState.tomorrow,
      CommunityEventState.live,
      CommunityEventState.replay,
      CommunityEventState.reflected,
    ]);
  });

  it('covers every enum member in the transition map', () => {
    for (const state of Object.values(CommunityEventState)) {
      expect(EVENT_STATE_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('is strictly forward: every legal edge increases the rank', () => {
    for (const [from, targets] of Object.entries(EVENT_STATE_TRANSITIONS)) {
      for (const to of targets) {
        expect(eventStateRank(to)).toBeGreaterThan(
          eventStateRank(from as CommunityEventState),
        );
      }
    }
  });

  it('allows the canonical happy-path edges', () => {
    expect(
      canTransition(
        CommunityEventState.scheduled,
        CommunityEventState.tomorrow,
      ),
    ).toBe(true);
    expect(
      canTransition(CommunityEventState.tomorrow, CommunityEventState.live),
    ).toBe(true);
    expect(
      canTransition(CommunityEventState.live, CommunityEventState.replay),
    ).toBe(true);
    expect(
      canTransition(
        CommunityEventState.replay,
        CommunityEventState.reflected,
      ),
    ).toBe(true);
  });

  it('allows forward skips that the product permits', () => {
    // Impromptu live with no overnight promotion.
    expect(
      canTransition(CommunityEventState.scheduled, CommunityEventState.live),
    ).toBe(true);
    // Attach a replay for an event that happened off-platform.
    expect(
      canTransition(CommunityEventState.scheduled, CommunityEventState.replay),
    ).toBe(true);
    expect(
      canTransition(CommunityEventState.tomorrow, CommunityEventState.replay),
    ).toBe(true);
  });

  it('forbids every backward edge', () => {
    expect(
      canTransition(CommunityEventState.live, CommunityEventState.scheduled),
    ).toBe(false);
    expect(
      canTransition(
        CommunityEventState.reflected,
        CommunityEventState.replay,
      ),
    ).toBe(false);
    expect(
      canTransition(
        CommunityEventState.tomorrow,
        CommunityEventState.scheduled,
      ),
    ).toBe(false);
  });

  it('forbids skipping past replay straight to reflected', () => {
    expect(
      canTransition(CommunityEventState.live, CommunityEventState.reflected),
    ).toBe(false);
    expect(
      canTransition(
        CommunityEventState.scheduled,
        CommunityEventState.reflected,
      ),
    ).toBe(false);
  });

  it('treats reflected as terminal', () => {
    expect(isTerminalEventState(CommunityEventState.reflected)).toBe(true);
    expect(EVENT_STATE_TRANSITIONS[CommunityEventState.reflected]).toHaveLength(
      0,
    );
    for (const state of Object.values(CommunityEventState)) {
      if (state !== CommunityEventState.reflected) {
        expect(isTerminalEventState(state)).toBe(false);
      }
    }
  });

  it('rejects a no-op transition (same state)', () => {
    expect(
      canTransition(CommunityEventState.live, CommunityEventState.live),
    ).toBe(false);
    expect(
      explainTransition(CommunityEventState.live, CommunityEventState.live),
    ).toBe('same_state');
  });

  it('explains rejections with typed reasons', () => {
    expect(
      explainTransition(
        CommunityEventState.live,
        CommunityEventState.scheduled,
      ),
    ).toBe('backward');
    expect(
      explainTransition(
        CommunityEventState.live,
        CommunityEventState.reflected,
      ),
    ).toBe('illegal_edge');
    expect(
      explainTransition(
        CommunityEventState.scheduled,
        CommunityEventState.tomorrow,
      ),
    ).toBeNull();
  });
});
