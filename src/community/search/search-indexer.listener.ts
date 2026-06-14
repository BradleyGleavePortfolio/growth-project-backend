import { Injectable, Logger } from '@nestjs/common';
import { CommunitySearchKind } from '@prisma/client';
import { SearchIndexerService } from './search-indexer.service';

/**
 * v3-4 search-indexer listener — the in-process ADAPTER that maps a community
 * object's create / update / soft-delete signal onto the SearchIndexerService.
 *
 * WHY a method-based adapter (not a NestJS EventEmitter subscriber): the
 * community subsystem does NOT run an event bus — write services call their
 * collaborators directly (see CommunityVoiceService → CommunityRealtimeService).
 * Re-using that established pattern, this listener exposes typed `onXCreated`
 * methods a write service calls AFTER its durable insert. The v3-4 lane OWNS
 * only the search/ folder; per R77 it does NOT edit the posts / voice / events
 * write services to call these methods — that wiring lands when each producer
 * lane opts in. The listener + its tests prove the mapping is correct and the
 * indexer is idempotent, so the producer side is a one-line call when enabled.
 *
 * Every method extracts ONLY allowlisted, body-free metadata (title / tags /
 * an explicit-consent transcript) — never a post body, DM body, or raw
 * transcript without consent (PREFLIGHT §8).
 */
@Injectable()
export class SearchIndexerListener {
  private readonly logger = new Logger(SearchIndexerListener.name);

  constructor(private readonly indexer: SearchIndexerService) {}

  /** A community post was created/updated — index its title + tags only. */
  async onPostUpserted(post: {
    id: string;
    workspaceId: string;
    cohortId: string | null;
    authorId: string | null;
    title: string | null;
    tags?: string[];
    softDeletedAt?: Date | null;
  }): Promise<void> {
    await this.indexer.index({
      kind: CommunitySearchKind.post,
      targetId: post.id,
      workspaceId: post.workspaceId,
      cohortId: post.cohortId,
      authorId: post.authorId,
      title: post.title,
      tags: post.tags,
      softDeletedAt: post.softDeletedAt ?? null,
    });
  }

  /** A classroom lesson was published/updated — index its title + tags. */
  async onClassroomLessonUpserted(lesson: {
    id: string;
    workspaceId: string;
    cohortId: string | null;
    authorId: string | null;
    title: string | null;
    tags?: string[];
    softDeletedAt?: Date | null;
  }): Promise<void> {
    await this.indexer.index({
      kind: CommunitySearchKind.classroom_lesson,
      targetId: lesson.id,
      workspaceId: lesson.workspaceId,
      cohortId: lesson.cohortId,
      authorId: lesson.authorId,
      title: lesson.title,
      tags: lesson.tags,
      softDeletedAt: lesson.softDeletedAt ?? null,
    });
  }

  /**
   * A voice note was published — index its TRANSCRIPT only if an
   * explicit-consent transcript exists (brief: "transcript-only if present").
   * When `transcript` is null/absent the excerpt falls back to title/tags and
   * the row is still searchable by metadata.
   */
  async onVoiceNoteUpserted(note: {
    id: string;
    workspaceId: string;
    cohortId: string | null;
    authorId: string | null;
    title?: string | null;
    transcript?: string | null;
    softDeletedAt?: Date | null;
  }): Promise<void> {
    await this.indexer.index({
      kind: CommunitySearchKind.voice_note_transcript,
      targetId: note.id,
      workspaceId: note.workspaceId,
      cohortId: note.cohortId,
      authorId: note.authorId,
      title: note.title ?? null,
      transcript: note.transcript ?? null,
      softDeletedAt: note.softDeletedAt ?? null,
    });
  }

  /** An event was created/updated — index its title + tags only. */
  async onEventUpserted(event: {
    id: string;
    workspaceId: string;
    cohortId: string | null;
    authorId: string | null;
    title: string | null;
    tags?: string[];
    softDeletedAt?: Date | null;
  }): Promise<void> {
    await this.indexer.index({
      kind: CommunitySearchKind.event,
      targetId: event.id,
      workspaceId: event.workspaceId,
      cohortId: event.cohortId,
      authorId: event.authorId,
      title: event.title,
      tags: event.tags,
      softDeletedAt: event.softDeletedAt ?? null,
    });
  }

  /** A target was soft-deleted — stop returning it from search. */
  async onTargetRemoved(
    workspaceId: string,
    kind: CommunitySearchKind,
    targetId: string,
  ): Promise<void> {
    await this.indexer.remove(workspaceId, kind, targetId);
    this.logger.log({
      event: 'community_search_listener_remove',
      workspace_id: workspaceId,
      kind,
      target_id: targetId,
    });
  }
}
