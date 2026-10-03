/**
 * Client privacy in community (owner rule, community goal state item 9):
 * other members only ever see a person's FIRST name. Full names, emails and
 * membership details stay on coach/owner surfaces (roster coach view,
 * moderation queue, coach inbox).
 *
 * Returns the first whitespace-separated token of the stored name, or
 * "Member" when no name is stored.
 */
export const MEMBER_NAME_FALLBACK = 'Member';

export function memberFirstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : MEMBER_NAME_FALLBACK;
}
