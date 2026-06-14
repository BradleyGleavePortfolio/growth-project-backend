import { Injectable, Logger } from '@nestjs/common';
import { CommunitySearchKind } from '@prisma/client';
import { CommunitySearchRepository } from './community-search.repository';
import { composeSearchExcerpt } from './search-pii-strip';

/**
 * Roles a search row can be visible to. The indexer chooses a subset per kind:
 * everything authored into a cohort/hall is visible to coaches + assistants +
 * students who pass the cohort/role check at QUERY time; the role allowlist is
 * the COARSE gate (e.g. a coach-only draft would carry ['coach','assistant']).
 */
export const SEARCH_ROLES = {
  COACH: 'coach',
  ASSISTANT: 'assistant',
  STUDENT: 'student',
} as const;

const ALL_MEMBER_ROLES = [
  SEARCH_ROLES.COACH,
  SEARCH_ROLES.ASSISTANT,
  SEARCH_ROLES.STUDENT,
];

/**
 * Allowlisted, body-free fields an indexable target contributes to its search
 * excerpt. The listener resolves these from the source object; the indexer
 * NEVER reads a body / transcript / DM text directly (PREFLIGHT §8). For voice
 * notes, `transcript` is supplied ONLY when an explicit-consent transcript
 * exists (brief: "voice notes — transcript-only if present").
 */
export interface IndexableTarget {
  workspaceId: string;
  cohortId: string | null;
  kind: CommunitySearchKind;
  targetId: string;
  authorId: string | null;
  /** Public title / name (allowlisted). */
  title?: string | null;
  /** Public tags / labels (allowlisted). */
  tags?: string[];
  /** Voice-note transcript — ONLY if an explicit-consent transcript exists. */
  transcript?: string | null;
  /** Visible-to roles; defaults to all member roles when omitted. */
  visibleToRoles?: string[];
  /** Soft-delete state mirrored from the source (search hides deleted rows). */
  softDeletedAt?: Date | null;
}

/**
 * v3-4 search indexer — writes ONE PII-stripped search row per target on
 * create / update / soft-delete of a community object. Idempotent: re-indexing
 * the same (workspaceId, kind, targetId) is an UPDATE, never a duplicate
 * (brief test 7). NEVER loops a per-target fetch (50-Failures N+1) — the
 * listener hands the indexer a fully-resolved target.
 */
@Injectable()
export class SearchIndexerService {
  private readonly logger = new Logger(SearchIndexerService.name);

  constructor(private readonly repo: CommunitySearchRepository) {}

  async index(target: IndexableTarget): Promise<{ id: string; created: boolean }> {
    const excerpt = composeSearchExcerpt([
      target.title,
      ...(target.tags ?? []),
      // Transcript is allowlisted ONLY when present (consent already gated
      // upstream by the voice subsystem); still PII-stripped here.
      target.transcript,
    ]);

    const result = await this.repo.upsertEntry({
      workspaceId: target.workspaceId,
      cohortId: target.cohortId,
      kind: target.kind,
      targetId: target.targetId,
      authorId: target.authorId,
      excerpt,
      visibleToRoles: target.visibleToRoles ?? ALL_MEMBER_ROLES,
      softDeletedAt: target.softDeletedAt ?? null,
    });

    this.logger.log({
      event: 'community_search_indexed',
      workspace_id: target.workspaceId,
      kind: target.kind,
      target_id: target.targetId,
      created: result.created,
      excerpt_length: excerpt.length,
    });

    return result;
  }

  /** Soft-delete a target's search row (search must stop returning it). */
  async remove(
    workspaceId: string,
    kind: CommunitySearchKind,
    targetId: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.repo.softDeleteEntry(workspaceId, kind, targetId, at);
    this.logger.log({
      event: 'community_search_removed',
      workspace_id: workspaceId,
      kind,
      target_id: targetId,
    });
  }
}
