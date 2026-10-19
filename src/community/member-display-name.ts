/**
 * Client privacy in community (owner rule, community goal state item 9):
 * other members see a person's FIRST name. Full names, emails and
 * membership details stay on coach/owner surfaces (roster coach view,
 * moderation queue, coach inbox). One exception (#C6-MEMBER-NAMES,
 * #C6-NAMES-EVERYWHERE): people in a space open to all of a coach's clients
 * (FULL_NAME_VISIBILITY) see each other's full names on its roster, its posts
 * and comments, and the coach's Hall, wins and leaderboard (fullNamesFor).
 *
 * Returns the first whitespace-separated token of the stored name, or
 * "Member" when no name is stored.
 */
export const MEMBER_NAME_FALLBACK = 'Member';

export function memberFirstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : MEMBER_NAME_FALLBACK;
}

/** #C6-MEMBER-NAMES: the stored name in full, or "Member" when none is stored. */
export function memberFullName(name: string | null | undefined): string {
  return name?.trim() || MEMBER_NAME_FALLBACK;
}

/** The one kind of space whose people see each other's full names. */
export const FULL_NAME_VISIBILITY = 'clients';

/** The full name where the rule allows it (fullNamesFor), else the first name. */
export const memberName = (name: string | null | undefined, full: boolean): string =>
  (full ? memberFullName : memberFirstName)(name);
