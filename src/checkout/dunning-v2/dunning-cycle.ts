import type { DunningState } from '@prisma/client';
import type { PrismaService } from '../../prisma.service';

/**
 * The cycle rule the dunning service sends by, on its own (no service
 * imports), so the one push worker can ask it again when a held push goes
 * (FR-1192R2).
 */

/** Stripe's reason on a payment reversed by a dispute: that cycle is paused, not ended. */
export const DUNNING_V2_REVERSAL_REASON = 'charge_disputed';

export function dunningCycleKey(enteredAt: Date): string {
  return String(enteredAt.getTime());
}

type CycleFields = Pick<
  DunningState,
  'status' | 'locked_out_at' | 'last_failure_reason' | 'client_canceled_at' | 'entered_at'
>;

/**
 * The cycle `cycleKey` names is still the live, unlocked one: active, not
 * locked (R-DISPUTE-PAUSE: a paused dispute cycle still sends its notices),
 * not canceled by the client, and not replaced by a later cycle. A notice
 * queued without a key (a legacy claim) is held to the state alone.
 */
export function dunningCycleLive<S extends CycleFields>(state: S | null, cycleKey: string | undefined): state is S {
  return (
    state != null &&
    state.status === 'active' &&
    (state.locked_out_at == null || state.last_failure_reason === DUNNING_V2_REVERSAL_REASON) &&
    state.client_canceled_at == null &&
    state.entered_at != null &&
    (cycleKey === undefined || dunningCycleKey(state.entered_at) === cycleKey)
  );
}

/** FR-1192R2: a dunning push held for 08:00 (or the cap, or a retry) still goes only while its cycle is live. */
export async function dunningPushStillDue(
  prisma: Pick<PrismaService, 'dunningState'>,
  ref: { stateId: string; cycleKey?: string },
): Promise<boolean> {
  const state = await prisma.dunningState.findUnique({
    where: { id: ref.stateId },
    select: { status: true, locked_out_at: true, last_failure_reason: true, client_canceled_at: true, entered_at: true },
  });
  return dunningCycleLive(state, ref.cycleKey);
}
