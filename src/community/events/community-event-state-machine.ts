/**
 * community-event-state-machine.ts — the v2-3 five-state event lifecycle.
 *
 * The five states (verbatim from the Prisma `CommunityEventState` enum and the
 * product plan §3.2) are a STRICTLY FORWARD machine:
 *
 *   scheduled → tomorrow → live → replay → reflected
 *
 * Design decisions (pure, side-effect-free — the service owns persistence and
 * the cron owns time):
 *
 *  - FORWARD-ONLY. There is no rewind transition. A coach who needs to "undo"
 *    a state cancels the event (canceled_at) and creates a new one. This keeps
 *    the attendance / replay / reflection audit trail honest: a card never
 *    silently regresses out of `live` after members joined.
 *
 *  - SKIPPING IS ALLOWED FORWARD ONLY when the product intent requires it:
 *    a coach may move scheduled → live directly (impromptu live with no
 *    overnight "tomorrow" promotion), or scheduled/tomorrow/live → replay
 *    directly (attach an external replay without a separate live phase, since
 *    there is NO native live room — Step 0). What is NEVER allowed is moving to
 *    an EARLIER state or jumping past `replay` into `reflected` without a
 *    replay artifact (the service enforces the replay-link precondition).
 *
 *  - The `tomorrow` and `live` promotions are ALSO driven automatically by the
 *    transition cron (auto-promote when starts_at crosses the windows). The
 *    machine here only answers "is X → Y a legal edge"; WHO triggers it (coach
 *    PATCH vs cron) is the caller's concern.
 *
 *  - A canceled event (canceled_at != null) accepts NO transitions. The service
 *    checks that before consulting this machine.
 *
 * This module imports nothing app-specific so the state table can be unit
 * tested in isolation (required test: "five-state machine") with zero DB.
 */

import { CommunityEventState } from '@prisma/client';

/** Canonical forward order of the lifecycle. Index = progression rank. */
export const EVENT_STATE_ORDER: readonly CommunityEventState[] = [
  CommunityEventState.scheduled,
  CommunityEventState.tomorrow,
  CommunityEventState.live,
  CommunityEventState.replay,
  CommunityEventState.reflected,
] as const;

/** Numeric rank of a state (0..4); higher = later in the lifecycle. */
export function eventStateRank(state: CommunityEventState): number {
  const idx = EVENT_STATE_ORDER.indexOf(state);
  // EVENT_STATE_ORDER covers every enum member, so -1 is structurally
  // impossible; the guard exists so a future enum addition fails loud.
  if (idx < 0) {
    throw new Error(`unknown community event state: ${String(state)}`);
  }
  return idx;
}

/**
 * Legal forward edges. The map lists, for each state, every state it may move
 * INTO. Empty array = terminal. The machine is forward-only, so every target's
 * rank is strictly greater than the source's rank (asserted by a unit test).
 */
export const EVENT_STATE_TRANSITIONS: Readonly<
  Record<CommunityEventState, readonly CommunityEventState[]>
> = {
  // From scheduled a coach can wait for the overnight promotion (tomorrow),
  // go live immediately, or attach a replay for an event that already happened
  // off-platform.
  [CommunityEventState.scheduled]: [
    CommunityEventState.tomorrow,
    CommunityEventState.live,
    CommunityEventState.replay,
  ],
  // From tomorrow: go live, or skip straight to replay.
  [CommunityEventState.tomorrow]: [
    CommunityEventState.live,
    CommunityEventState.replay,
  ],
  // From live the only forward step is attaching the replay artifact.
  [CommunityEventState.live]: [CommunityEventState.replay],
  // From replay the coach posts the reflection/recap.
  [CommunityEventState.replay]: [CommunityEventState.reflected],
  // Reflected is terminal.
  [CommunityEventState.reflected]: [],
};

/** True when `from → to` is a legal forward edge of the machine. */
export function canTransition(
  from: CommunityEventState,
  to: CommunityEventState,
): boolean {
  if (from === to) return false;
  return EVENT_STATE_TRANSITIONS[from].includes(to);
}

/** Terminal-state check. */
export function isTerminalEventState(state: CommunityEventState): boolean {
  return EVENT_STATE_TRANSITIONS[state].length === 0;
}

/**
 * Reason codes for a rejected transition — typed so the service maps each to a
 * stable error code (no string drift). Returned by `explainTransition`.
 */
export type EventTransitionRejection =
  | 'same_state'
  | 'backward'
  | 'illegal_edge';

/**
 * Describe why a transition is (or is not) allowed. `null` = allowed. The
 * service turns a non-null result into a typed ForbiddenException/Bad-request
 * with a `community.event.*` code so the client sees a deterministic reason.
 */
export function explainTransition(
  from: CommunityEventState,
  to: CommunityEventState,
): EventTransitionRejection | null {
  if (from === to) return 'same_state';
  if (eventStateRank(to) < eventStateRank(from)) return 'backward';
  if (!canTransition(from, to)) return 'illegal_edge';
  return null;
}
