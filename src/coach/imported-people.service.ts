import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE,
  IMPORTED_PEOPLE_HIDDEN_STATES,
  IMPORTED_PEOPLE_LABEL,
  IMPORTED_PEOPLE_MAX_PAGE_SIZE,
  IMPORTED_PEOPLE_MAX_SUGGESTIONS,
  ImportedPeopleResult,
  ImportedPersonDto,
  ImportedPersonSuggestionDto,
} from './imported-people.dto';
import { inviteMarker, proposalMarker } from './person-link-markers';

/** The Person columns this reader selects — the whole privacy surface of the collection. */
const PERSON_SELECT = {
  id: true,
  display_name: true,
  state: true,
  source_platform: true,
} as const;

/**
 * S8-D2 — reader for the coach roster's "imported, not yet joined" collection
 * (docs/decisions/2026-09-26-s8d-person-link.md §5.2).
 *
 * Tenant rule: every query is scoped by `coach_id = callerId`, where the caller
 * id comes from the bearer token (never a query or body field). There is no
 * owner platform-wide read and no sub-coach overlay: a `Person` is owned by the
 * coach whose import created it (§2.2), so an owner or sub-coach calling this
 * sees only Persons of their OWN coach id (the risk-board precedent in
 * coach.controller.ts). Suggestions are looked up under the same coach id, so
 * no other coach's students can appear.
 *
 * Reads only. Nothing here writes a Person, a link, an invite or a proposal.
 */
@Injectable()
export class ImportedPeopleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(coachId: string, cursor?: string, take?: number): Promise<ImportedPeopleResult> {
    const limit = clampLimit(take);

    // Newest first, id ascending as the tiebreak so the order is total; the
    // cursor names the last row's id (same shape as GET /coach/clients). One
    // extra row tells us whether another page follows without a count query.
    const rows = await this.prisma.person.findMany({
      where: {
        coach_id: coachId,
        state: { notIn: [...IMPORTED_PEOPLE_HIDDEN_STATES] },
      },
      select: PERSON_SELECT,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const suggestions = await this.suggestionsFor(coachId, page);

    const imported: ImportedPersonDto[] = page.map((p) => ({
      person_id: p.id,
      display_name: p.display_name,
      state: p.state,
      source_platform: p.source_platform,
      joined: false,
      invite: inviteMarker(p.id),
      proposal: proposalMarker(p.id),
      suggestions: suggestions.get(p.id) ?? [],
    }));

    const last = hasMore && page.length > 0 ? page[page.length - 1] : undefined;
    return {
      imported_people: imported,
      label: IMPORTED_PEOPLE_LABEL,
      page: { limit, next_cursor: last ? last.id : null, has_more: hasMore },
    };
  }

  /**
   * Read-time name suggestions (§3.3 L1): same-coach, non-archived students
   * whose account `name` equals the Person's `display_name` after normalisation
   * (`normaliseName`: trim, collapse inner whitespace, case-fold). Exact-after-
   * normalisation is the deliberately narrow v1 — no fuzzy scoring, so no
   * threshold to tune and no near-miss ever surfaces as a candidate. The DB read
   * is bounded to the page's trimmed names (`name IN (...)`, case-insensitive);
   * a student the pre-filter excludes (e.g. different inner whitespace) is simply
   * not suggested — the pre-filter narrows, never widens.
   *
   * Never persisted, never applied: the result is a list of `{user_id,
   * display_name}` the coach can already see in their own client list.
   */
  private async suggestionsFor(
    coachId: string,
    page: ReadonlyArray<{ id: string; display_name: string | null }>,
  ): Promise<Map<string, ImportedPersonSuggestionDto[]>> {
    const out = new Map<string, ImportedPersonSuggestionDto[]>();
    const wanted = new Map<string, string[]>(); // normalised name -> person ids
    const rawNames = new Set<string>();
    for (const p of page) {
      const key = normaliseName(p.display_name);
      if (key === null || p.display_name === null) continue;
      rawNames.add(p.display_name.trim());
      const ids = wanted.get(key) ?? [];
      ids.push(p.id);
      wanted.set(key, ids);
    }
    if (wanted.size === 0) return out;

    const students = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        role: 'student',
        archived_at: null,
        name: { in: [...rawNames], mode: 'insensitive' },
      },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });

    for (const s of students) {
      const key = normaliseName(s.name);
      if (key === null) continue;
      const personIds = wanted.get(key);
      if (!personIds) continue;
      for (const personId of personIds) {
        const list = out.get(personId) ?? [];
        if (list.length >= IMPORTED_PEOPLE_MAX_SUGGESTIONS) continue;
        list.push({ user_id: s.id, display_name: s.name });
        out.set(personId, list);
      }
    }
    return out;
  }
}

/** 1..IMPORTED_PEOPLE_MAX_PAGE_SIZE; anything else (undefined, NaN, 0, negative, over) → default/cap. */
function clampLimit(take: number | undefined): number {
  if (take === undefined || !Number.isInteger(take) || take < 1) {
    return IMPORTED_PEOPLE_DEFAULT_PAGE_SIZE;
  }
  return Math.min(take, IMPORTED_PEOPLE_MAX_PAGE_SIZE);
}

/** Trim, collapse inner whitespace, case-fold; null when nothing is left to compare. */
export function normaliseName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const folded = name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return folded.length === 0 ? null : folded;
}
