import type {
  ImportedPersonInviteMarkerDto,
  ImportedPersonProposalMarkerDto,
  PersonLinkMarkerDto,
} from './imported-people.dto';

/**
 * S8-D2 — marker resolvers for the coach roster
 * (docs/decisions/2026-09-26-s8d-person-link.md §5.2).
 *
 * The three markers name rows of tables that later slices create:
 *
 *   marker         backing table          created by   marker semantics owned by
 *   person_link    PersonLink             S8-D3        S8-D4b (write), S8-D5 (undo window)
 *   invite         PersonInvite           S8-D3        S8-D4a
 *   proposal       PersonLinkProposal     S8-D3        S8-D6
 *
 * None of those tables exists in this tree (prisma/schema.prisma has no
 * `model PersonLink`, `PersonInvite` or `PersonLinkProposal`), so there is no
 * row to read and each resolver returns `null` — the contract's truthful "no
 * marker" value. The resolvers are the ONE place the later slices replace with a
 * real read; nothing here derives a marker from a Person's `state`, a name match
 * or any other proxy (mission invariant: no fabricated server behaviour).
 *
 * `PERSON_LINK_BACKING_TABLES` records the reason literally so a reader of the
 * response can trace every `null` to an absent table rather than to an absent
 * row.
 */
export const PERSON_LINK_BACKING_TABLES = {
  PersonLink: false,
  PersonInvite: false,
  PersonLinkProposal: false,
} as const;

/** The active link marker for one client row: null until PersonLink exists (S8-D3/D4b/D5). */
export function personLinkMarker(_userId: string): PersonLinkMarkerDto | null {
  return null;
}

/** The open invite marker for one imported Person: null until PersonInvite exists (S8-D4a). */
export function inviteMarker(_personId: string): ImportedPersonInviteMarkerDto | null {
  return null;
}

/** The open proposal marker for one imported Person: null until PersonLinkProposal exists (S8-D6). */
export function proposalMarker(_personId: string): ImportedPersonProposalMarkerDto | null {
  return null;
}
