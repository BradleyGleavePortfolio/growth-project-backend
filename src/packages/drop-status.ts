/**
 * ScheduledDrop status vocabulary shared by the drop writers and the buyer
 * read model.
 *
 * Terminal "shipped" statuses (G4 / watchpoint §6.7): the inline fan-out
 * stamps 'fired'; the drip dispatcher stamps 'delivered'. BOTH mean the buyer
 * already received this content.
 */
export const SHIPPED_STATUSES = ['fired', 'delivered'] as const;
export type ShippedStatus = (typeof SHIPPED_STATUSES)[number];

/**
 * Statuses a buyer sees (S-MWB-3 B-640-12). 'dispatching' is a due drop the
 * dispatcher is delivering right now. failed / canceled / skipped never leave
 * the database (they route to the coach alert instead).
 */
export const BUYER_VISIBLE_DROP_STATUSES = [
  'pending',
  'due',
  'dispatching',
  ...SHIPPED_STATUSES,
] as const;

/** The buyer-facing contract status: 'pending' | 'due' | 'fired'. */
export type BuyerDropStatus = 'pending' | 'due' | 'fired';

/**
 * Map a stored status onto the buyer contract the mobile Deliverables screen
 * and the storefront thank-you page read: every shipped status reads as
 * 'fired', an in-flight dispatch reads as 'due'. Anything else is passed as
 * 'pending' (the list query only ever returns BUYER_VISIBLE_DROP_STATUSES).
 */
export function buyerDropStatus(status: string): BuyerDropStatus {
  if ((SHIPPED_STATUSES as readonly string[]).includes(status)) return 'fired';
  if (status === 'due' || status === 'dispatching') return 'due';
  return 'pending';
}
