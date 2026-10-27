import { z } from 'zod';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import type { CommunityAccessService } from '../community-access.service';
import { memberName } from '../member-display-name';
import type { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { RemovedBySchema } from '../voice/community-voice.service';

/**
 * FR-1165R3 (owner B "3.) b", LO-1165R2 C-8, LS-1165R2 B1): a coach's removal
 * of someone else's post, post comment or challenge comment stays as a
 * "Removed by Coach {name}" placeholder, as chats and voice notes do.
 *
 * Today's phone (mobile main 1dd970e7) cannot draw such a row: a comment needs
 * a string body (src/api/communityApi.ts:256), a challenge comment allows no
 * other key (src/api/communityChallengesApi.ts:125-133) and a post without a
 * title draws as an "Untitled post" card (src/components/community/PostCard.tsx:34).
 * So the placeholders go only to a phone that sends this header with "1"
 * (REMOVED-BY-M3). Without it the row is left out, as today.
 */
export const REMOVED_ROWS_HEADER = 'x-client-removed-rows';
export const showsRemoved = (header: string | undefined): boolean => header === '1';

/** The keys a placeholder adds; absent on every live row and without the header. */
export const RemovedKeys = {
  removed_at: z.string().datetime().optional(),
  removed_by: RemovedBySchema.optional(),
};
export type Removed = { removed_at: string; removed_by: z.infer<typeof RemovedBySchema> };

type Row = { deleted_at: Date | null; removed_by_user_id: string | null; workspace_id: string; cohort_id: string | null };

/** A coach's removal of someone else's row (a placeholder), not an author's delete. */
export function coachRemoved<T extends Row>(r: T): r is T & { deleted_at: Date; removed_by_user_id: string } {
  return !!r.deleted_at && !!r.removed_by_user_id;
}

/**
 * Who removed each coach-removed row of one page (one workspace), named by
 * the author_name rule for that coach in that place. One batched read.
 */
export async function removedByOf<T extends Row>(
  access: Pick<CommunityAccessService, 'fullNamesFor'>,
  names: (ids: string[]) => Promise<ReadonlyMap<string, string | null>>,
  viewerId: string,
  rows: T[],
): Promise<(r: T) => Removed | undefined> {
  const gone = rows.filter(coachRemoved);
  if (gone.length === 0) return () => undefined;
  const [stored, full] = await Promise.all([
    names(gone.map((r) => r.removed_by_user_id)),
    access.fullNamesFor(viewerId, gone[0].workspace_id, gone.map((r) => [r.cohort_id, r.removed_by_user_id] as const)),
  ]);
  return (r) =>
    coachRemoved(r)
      ? {
          removed_at: r.deleted_at.toISOString(),
          removed_by: {
            role: 'coach',
            user_id: r.removed_by_user_id,
            name: memberName(stored.get(r.removed_by_user_id), full(r.cohort_id, r.removed_by_user_id)),
          },
        }
      : undefined;
}

/**
 * The removal's live update to the post's readers: the post (or the post a
 * removed comment sits under) changed, ids only; the phone refetches over REST.
 */
export function publishPostChanged(
  realtime: Pick<CommunityRealtimeService, 'broadcastCommunityEvent'>,
  post: { id: string; workspaceId: string; cohortId: string | null },
  removedBy: string,
  at: Date,
): Promise<void> {
  return realtime.broadcastCommunityEvent(
    { workspaceId: post.workspaceId, cohortId: post.cohortId },
    COMMUNITY_BROADCAST_EVENTS.postUpdated,
    { id: post.id, workspaceId: post.workspaceId, updatedAt: at.toISOString() },
    { distinctId: removedBy, channelKind: 'workspace' },
  );
}
