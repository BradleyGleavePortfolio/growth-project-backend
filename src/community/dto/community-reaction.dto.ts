import { IsIn, IsString } from 'class-validator';
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

export const CommunityReactionStateSchema = z
  .object({
    target_type: z.enum(['message', 'post', 'comment']),
    target_id: z.string().uuid(),
    reactions: z.array(CommunityReactionSummarySchema),
  })
  .strict();

export type CommunityReactionState = z.infer<
  typeof CommunityReactionStateSchema
>;
