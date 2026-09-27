import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PersonState } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * S8-D2 — the coach roster's "imported, not yet joined" collection
 * (docs/decisions/2026-09-26-s8d-person-link.md §5.2; owner D-S8-2 (a)).
 *
 * `GET /api/coach/clients/imported` lists the calling coach's imported `Person`
 * rows whose state is not `Claimed` and not `Deleted`, as a SIBLING of the
 * `User`-based `GET /api/coach/clients` array — never interleaved into it, so no
 * existing consumer of the client list sees a non-`User` row. Every field here
 * is server state; the link/invite/proposal markers are emitted as `null` while
 * their backing tables (S8-D3+) do not exist. Nothing here is fabricated.
 *
 * Privacy: a `Person` holds no email, phone or contact column (§2.3). This DTO
 * emits `person_id`, `display_name`, `state`, `source_platform` and the
 * markers — never `source_person_id` (the source platform's record id is
 * importer-G's provenance concern, not the roster's), never a User email.
 */

/** Fixed label copy for every row of the collection (§5.2). */
export const IMPORTED_PEOPLE_LABEL = 'imported, not yet joined' as const;

/** Default page size when the caller does not specify `take` (mirrors `GET /coach/clients`). */
export const IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE = 20;

/** Hard ceiling on rows per page (mirrors `GET /coach/clients`'s `take` cap of 50). */
export const IMPORTED_PEOPLE_MAX_PAGE_SIZE = 50;

/** A Person id is a Prisma uuid; a cursor longer than this can never resolve. */
export const IMPORTED_PEOPLE_CURSOR_MAX_LENGTH = 64;

/** Upper bound of same-coach name suggestions emitted per imported Person. */
export const IMPORTED_PEOPLE_MAX_SUGGESTIONS = 5;

/**
 * Person states the collection lists. `Claimed` is a linked client (its marker
 * lives on the client's `User` row); `Deleted` is erased. `Suspended` IS shown,
 * with its state, so the coach sees the freeze (§5.2).
 */
export const IMPORTED_PEOPLE_HIDDEN_STATES: readonly PersonState[] = [
  PersonState.Claimed,
  PersonState.Deleted,
];

/** GET /api/coach/clients/imported query. coach_id comes from the bearer identity only. */
export class ImportedPeopleQueryDto {
  @ApiPropertyOptional({
    description:
      'Opaque forward-only page cursor returned as `page.next_cursor` by a prior call. ' +
      'Omit for the first page.',
    maxLength: IMPORTED_PEOPLE_CURSOR_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(IMPORTED_PEOPLE_CURSOR_MAX_LENGTH)
  cursor?: string;

  @ApiPropertyOptional({
    description: `Page size (1..${IMPORTED_PEOPLE_MAX_PAGE_SIZE}). Defaults to ${IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE}.`,
    minimum: 1,
    maximum: IMPORTED_PEOPLE_MAX_PAGE_SIZE,
    default: IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE,
    example: IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(IMPORTED_PEOPLE_MAX_PAGE_SIZE)
  take?: number;
}

/** Open invite on an imported Person (S8-D4a). Emitted `null` until that table exists. */
export class ImportedPersonInviteMarkerDto {
  @ApiProperty({ description: 'Invite status.', example: 'sent' })
  status!: string;

  @ApiProperty({ description: 'Delivery channel the invite went out on.', example: 'email' })
  sent_via!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the invite expires.' })
  expires_at!: string;
}

/** Open link proposal on an imported Person (S8-D6). Emitted `null` until that table exists. */
export class ImportedPersonProposalMarkerDto {
  @ApiProperty({ description: 'Proposal status.', example: 'pending' })
  status!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the proposal expires.' })
  expires_at!: string;
}

/**
 * A same-coach student whose account name equals the imported display name
 * (normalised, read-time only). Suggestions are NEVER persisted as links and
 * NEVER auto-applied (§3.3, L1); the coach's only action on one is the ordinary
 * proposal flow once S8-D6 lands.
 */
export class ImportedPersonSuggestionDto {
  @ApiProperty({ description: 'The same-coach student account suggested.', format: 'uuid' })
  user_id!: string;

  @ApiProperty({ description: "That student's account display name.", example: 'Jordan Ellis' })
  display_name!: string;
}

/** One "imported, not yet joined" row. */
export class ImportedPersonDto {
  @ApiProperty({ description: 'Opaque server-issued Person id.', format: 'uuid' })
  person_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Display name for the roster row, if the source provided one.',
    example: 'Jordan Ellis',
  })
  display_name!: string | null;

  @ApiProperty({
    description:
      'Lifecycle state of the imported record. Never `Claimed` or `Deleted` here; `Suspended` is ' +
      'shown with its state.',
    enum: PersonState,
    example: PersonState.InvitePending,
  })
  state!: PersonState;

  @ApiProperty({ description: 'Source platform slug (provenance).', example: 'truecoach' })
  source_platform!: string;

  @ApiProperty({
    description:
      'Always false in this collection: an imported Person has no signed-up account. A joined ' +
      '(Claimed) Person is not listed here; its `person_link` marker lives on the client row.',
    example: false,
  })
  joined!: false;

  @ApiProperty({
    type: ImportedPersonInviteMarkerDto,
    nullable: true,
    description:
      'The open Person invite, or null. Null for every row until the PersonInvite table exists ' +
      '(S8-D4a); never fabricated.',
  })
  invite!: ImportedPersonInviteMarkerDto | null;

  @ApiProperty({
    type: ImportedPersonProposalMarkerDto,
    nullable: true,
    description:
      'The open link proposal, or null. Null for every row until the PersonLinkProposal table ' +
      'exists (S8-D6); never fabricated.',
  })
  proposal!: ImportedPersonProposalMarkerDto | null;

  @ApiProperty({
    type: [ImportedPersonSuggestionDto],
    description:
      'Same-coach students whose account name equals this display name (normalised). Read-time ' +
      'only; never persisted or applied. Empty when the Person has no display name.',
  })
  suggestions!: ImportedPersonSuggestionDto[];
}

/** Deterministic forward-only pagination envelope. */
export class ImportedPeoplePageDto {
  @ApiProperty({ description: 'Page size applied to this response.', example: 20 })
  limit!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page, or null when this is the last page.',
  })
  next_cursor!: string | null;

  @ApiProperty({ description: 'True when another page follows.', example: false })
  has_more!: boolean;
}

/** 200 body for GET /api/coach/clients/imported. */
export class ImportedPeopleResult {
  @ApiProperty({
    type: [ImportedPersonDto],
    description:
      "The calling coach's imported Persons with state not in {Claimed, Deleted}, newest first.",
  })
  imported_people!: ImportedPersonDto[];

  @ApiProperty({
    description: `Fixed label copy for every row of this collection: "${IMPORTED_PEOPLE_LABEL}".`,
    example: IMPORTED_PEOPLE_LABEL,
  })
  label!: typeof IMPORTED_PEOPLE_LABEL;

  @ApiProperty({ type: ImportedPeoplePageDto, description: 'Pagination envelope.' })
  page!: ImportedPeoplePageDto;
}

/**
 * S8-D2 marker on a `GET /api/coach/clients` client row: the active link of a
 * Claimed Person while `now < undo_until`, else null (§5.2). Null for every row
 * until the PersonLink table exists (S8-D3) and the link transaction writes it
 * (S8-D4b); the undo semantics are S8-D5's.
 */
export class PersonLinkMarkerDto {
  @ApiProperty({ description: 'The active PersonLink id.', format: 'uuid' })
  link_id!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the link committed.' })
  linked_at!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'End of the undo window.' })
  undo_until!: string;
}
