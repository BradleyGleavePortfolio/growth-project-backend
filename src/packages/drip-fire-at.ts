// PR-9 fire_at computation, extracted so PR-17 ("push to existing") can
// reuse the EXACT same per-cadence math without duplicating it. The
// original lived as a private method on PurchaseFanoutService; the body
// is byte-identical to PR-9's documented rule set (see
// purchase-fanout.service.ts header for the canonical contract).
//
// Anchor semantics (LAW):
//   - `relative_to_purchase` is anchored to the BUYER'S OWN purchase time
//     (or completion/milestone time, when PR-11 expands to those kinds).
//     Callers MUST NOT pass the coach's "now" as the anchor — that would
//     make a relative push collapse every buyer onto the same shifted
//     fire_at, which is precisely the bug decision #2 is designed to
//     avoid.
//   - `fixed_calendar` ignores the anchor and uses payload.release_at.
//   - `immediate` and a past `fixed_calendar` both return `now` so a
//     downstream materialiser/dispatcher picks them up at the next tick.

export type CadenceKind =
  | 'immediate'
  | 'relative_to_purchase'
  | 'fixed_calendar'
  | 'on_completion'
  | 'on_milestone';

export function computeFireAt(
  kind: CadenceKind | string,
  payload: unknown,
  anchor: Date,
  now: Date,
): Date | null {
  switch (kind) {
    case 'immediate':
      return now;
    case 'relative_to_purchase': {
      const offset = readOffsetDays(payload);
      return new Date(anchor.getTime() + offset * 24 * 3600 * 1000);
    }
    case 'fixed_calendar': {
      const releaseAt = readReleaseAt(payload);
      if (!releaseAt) return now;
      if (releaseAt.getTime() <= now.getTime()) return now;
      return releaseAt;
    }
    case 'on_completion':
    case 'on_milestone':
      return null;
    default:
      return null;
  }
}

function readOffsetDays(payload: unknown): number {
  if (
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { offset_days?: unknown }).offset_days === 'number'
  ) {
    const v = (payload as { offset_days: number }).offset_days;
    return Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return 0;
}

function readReleaseAt(payload: unknown): Date | null {
  if (
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { release_at?: unknown }).release_at === 'string'
  ) {
    const raw = (payload as { release_at: string }).release_at;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return null;
}
