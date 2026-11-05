/**
 * PLAN-SWAPS-BE (agent 196; C2 Style C S2): the pieces of a plan meal's swaps, its recipe and today's plan
 * changes that are pure. RealMealPlansService does the reads and writes.
 *
 *   * A meal template carries the coach's swaps (`swap_template_ids`: their own live templates, never the
 *     template itself) and the coach's own recipe (`recipe_id`). The coach meal routes refuse any other id
 *     with MEAL_SWAP_INVALID or MEAL_RECIPE_INVALID (400, the house `{ code, error, message }` body).
 *   * Each meal change in a coach's plan edit writes one DailyMealPlanRevision in the same transaction
 *     (revisionsFor). A time-only change is not a meal change and writes none.
 *   * GET /me/meal-plan/today reports the revisions made since the client's local midnight
 *     (sameLocalDay over resolveRecipientTimeZone, src/notifications/recipient-timezone.ts; UTC when no
 *     zone is known).
 */
import { BadRequestException } from '@nestjs/common';
import { localDayNumber } from '../notifications/local-time';

export const MEAL_SWAP_INVALID = 'MEAL_SWAP_INVALID';
export const MEAL_RECIPE_INVALID = 'MEAL_RECIPE_INVALID';

export const PLAN_SWAPS_ERROR_MESSAGES = {
  [MEAL_SWAP_INVALID]:
    'A swap must be one of your own meals that is not archived, and not this meal. Pick swaps from your meals and save again.',
  [MEAL_RECIPE_INVALID]:
    'The recipe must be one of your own recipes. Pick a recipe you created and save again.',
} as const;

type PlanSwapsErrorCode = keyof typeof PLAN_SWAPS_ERROR_MESSAGES;

export function planSwapsError(code: PlanSwapsErrorCode): BadRequestException {
  return new BadRequestException({ code, error: code, message: PLAN_SWAPS_ERROR_MESSAGES[code] });
}

/** The longest a local day can reach back from now (a 25-hour DST day, plus slack). */
export const LOCAL_DAY_LOOKBACK_MS = 26 * 60 * 60 * 1000;

/**
 * At most this many of today's changes are returned (G15: bounded lists). The read is bounded to the
 * client's local day first (localDayStartBefore), so the cap keeps today's earliest 100 changes, oldest
 * first; yesterday's rows can never use it up (FIX-1221, LS-1221 C1).
 */
export const CHANGES_TODAY_LIMIT = 100;

/** YYYY-MM-DD of `d` in `tz`. */
export function localDateKey(d: Date, tz: string): string {
  return new Date(localDayNumber(d, tz) * 86_400_000).toISOString().slice(0, 10);
}

export function sameLocalDay(a: Date, b: Date, tz: string): boolean {
  return localDayNumber(a, tz) === localDayNumber(b, tz);
}

/**
 * The first instant of `now`'s local day in `tz` (DST-safe): a search over the LOCAL_DAY_LOOKBACK_MS
 * window before `now`, where "same local day as now" turns from false to true exactly once.
 */
export function localDayStartBefore(now: Date, tz: string): Date {
  let lo = now.getTime() - LOCAL_DAY_LOOKBACK_MS;
  let hi = now.getTime();
  if (sameLocalDay(new Date(lo), now, tz)) return new Date(lo);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (sameLocalDay(new Date(mid), now, tz)) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

export interface SlotRow {
  id: string;
  slot_label: string;
  meal_template_id: string;
}

export interface RevisionRow {
  id: string;
  plan_id: string;
  slot_id: string;
  slot_label: string;
  from_template_id: string | null;
  to_template_id: string | null;
  changed_at: Date;
}

/**
 * The revisions one plan edit writes: a kept slot whose meal changed (from -> to), a removed slot
 * (from -> null) and an added slot (null -> to). Every row of one edit carries the same `changedAt`.
 * FIX-1221 (LO-1221 C3): a removed slot and an added slot with the same label and meal are the same meal
 * moved (a reorder or a renumbered save), not a change, and write nothing.
 */
export function revisionsFor(
  planId: string,
  kept: { before: SlotRow; afterTemplateId: string }[],
  removed: SlotRow[],
  added: SlotRow[],
  changedAt: Date,
  newId: () => string,
): RevisionRow[] {
  // A revision is history, not a slot write (test/c2-c0-planned-times.spec.ts walks slot writers).
  const row = ({ id: slot_id, slot_label }: SlotRow, from: string | null, to: string | null): RevisionRow => ({
    id: newId(),
    plan_id: planId,
    slot_id,
    slot_label,
    from_template_id: from,
    to_template_id: to,
    changed_at: changedAt,
  });
  const same = (a: SlotRow, b: SlotRow) => a.slot_label === b.slot_label && a.meal_template_id === b.meal_template_id;
  const gone = [...removed];
  const fresh = added.filter((s) => {
    const i = gone.findIndex((g) => same(g, s));
    if (i < 0) return true;
    gone.splice(i, 1);
    return false;
  });
  return [
    ...kept
      .filter((k) => k.before.meal_template_id !== k.afterTemplateId)
      .map((k) => row(k.before, k.before.meal_template_id, k.afterTemplateId)),
    ...gone.map((s) => row(s, s.meal_template_id, null)),
    ...fresh.map((s) => row(s, null, s.meal_template_id)),
  ];
}
