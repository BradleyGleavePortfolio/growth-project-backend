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
 * The revisions one plan edit writes: a meal changed (from -> to), a meal removed (from -> null) and a meal
 * added (null -> to). Every row of one edit carries the same `changedAt`.
 * FIX-1221R2 (LO-1221R2B C1): slot rows are keyed by label#order, so removing one meal shifts the meals
 * after it onto other rows. The meals of each slot label are compared as a multiset instead: a meal on
 * both sides is not a change (wherever its row moved), a surplus meal before is removed, a surplus meal
 * after is added, and what is left under the same label pairs as from -> to (a row keeping its own id
 * first). So one removal is one change.
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
  const row = (slot_id: string, slot_label: string, from: string | null, to: string | null): RevisionRow => ({
    id: newId(),
    plan_id: planId,
    slot_id,
    slot_label,
    from_template_id: from,
    to_template_id: to,
    changed_at: changedAt,
  });
  const before: SlotRow[] = [...kept.map((k) => k.before), ...removed];
  const after: SlotRow[] = [...kept.map((k) => ({ ...k.before, meal_template_id: k.afterTemplateId })), ...added];
  const changes: RevisionRow[] = [];
  const gone: RevisionRow[] = [];
  const fresh: RevisionRow[] = [];
  for (const label of [...new Set([...before, ...after].map((s) => s.slot_label))]) {
    let b = before.filter((s) => s.slot_label === label);
    const a = after.filter((s) => s.slot_label === label);
    // The same meal on both sides is no change: its own row first, then any row under the label.
    const take = (match: (x: SlotRow, y: SlotRow) => boolean) => {
      b = b.filter((x) => {
        const i = a.findIndex((y) => x.meal_template_id === y.meal_template_id && match(x, y));
        if (i < 0) return true;
        a.splice(i, 1);
        return false;
      });
    };
    take((x, y) => x.id === y.id);
    take(() => true);
    // A row whose own meal changed is that row's change; the rest pair in order.
    b = b.filter((x) => {
      const i = a.findIndex((y) => y.id === x.id);
      if (i < 0) return true;
      changes.push(row(x.id, label, x.meal_template_id, a[i].meal_template_id));
      a.splice(i, 1);
      return false;
    });
    const pairs = Math.min(b.length, a.length);
    for (let i = 0; i < pairs; i++) changes.push(row(a[i].id, label, b[i].meal_template_id, a[i].meal_template_id));
    for (const x of b.slice(pairs)) gone.push(row(x.id, label, x.meal_template_id, null));
    for (const y of a.slice(pairs)) fresh.push(row(y.id, label, null, y.meal_template_id));
  }
  return [...changes, ...gone, ...fresh];
}
