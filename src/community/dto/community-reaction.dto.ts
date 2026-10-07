import { IsIn, IsString } from 'class-validator';
import type { CommunityResponse } from '@prisma/client';
import { z } from 'zod';
import {
  COMMUNITY_REACTION_EMOJI,
  CommunityReactionEmoji,
} from '../reactions/community-emoji.allowlist';

/**
 * POST .../reactions — react with one allowlisted emoji.
 *
 * The emoji set is the canonical v1-1 roundtrip allowlist (see
 * community-emoji.allowlist.ts). @IsIn rejects anything outside it with a 400
 * before the service runs, so the VARCHAR(32) response_kind column never
 * receives an unbounded or non-emoji string.
 */
export class ReactDto {
  @IsString()
  @IsIn(COMMUNITY_REACTION_EMOJI, {
    message: 'emoji is not in the allowed reaction set',
  })
  emoji!: CommunityReactionEmoji;
}

export const CommunityReactionSummarySchema = z
  .object({
    emoji: z.string(),
    count: z.number().int().nonnegative(),
    reacted_by_me: z.boolean(),
  })
  .strict();
export type CommunityReactionSummary = z.infer<typeof CommunityReactionSummarySchema>;

/**
 * One target's reactions grouped by emoji, in first-reaction order (rows come
 * oldest first), with `reacted_by_me` for the viewer. The one summary rule for
 * the reaction endpoints' responses and the post/reply views, so a thread
 * shows the same counts before and after a tap.
 */
export function summariseReactions(
  rows: ReadonlyArray<Pick<CommunityResponse, 'response_kind' | 'user_id'>>,
  viewerId: string,
): CommunityReactionSummary[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    const entry = byEmoji.get(r.response_kind) ?? { count: 0, mine: false };
    entry.count += 1;
    if (r.user_id === viewerId) entry.mine = true;
    byEmoji.set(r.response_kind, entry);
  }
  return [...byEmoji.entries()].map(([emoji, e]) => ({
    emoji,
    count: e.count,
    reacted_by_me: e.mine,
  }));
}

export const CommunityReactionStateSchema = z
  .object({
    target_type: z.enum(['message', 'post', 'comment']),
    target_id: z.guid(),
    reactions: z.array(CommunityReactionSummarySchema),
  })
  .strict();

export type CommunityReactionState = z.infer<
  typeof CommunityReactionStateSchema
>;
