/**
 * community-realtime.types.ts — typed + runtime-validated broadcast payloads.
 *
 * Every payload is a Zod schema with `.strict()` so an unexpected key (e.g. a
 * stray `body` someone adds in a future refactor) fails the runtime parse
 * BEFORE it ever reaches Supabase. This is failure #8 (phantom validation):
 * TypeScript types alone don't stop a runtime leak — the Zod gate does.
 *
 * ABSOLUTE RULE: no payload may carry user-authored text. Only ids,
 * timestamps (ISO strings), enum state values, and numeric deltas/percents.
 */

import { z } from 'zod';

// ─── Per-event payload schemas (strict — no extra keys) ────────────────────

export const MessageCreatedPayloadSchema = z
  .object({
    id: z.string(),
    cohortId: z.string(),
    authorId: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const MessageUpdatedPayloadSchema = z
  .object({
    id: z.string(),
    cohortId: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const PostCreatedPayloadSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    authorId: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const PostUpdatedPayloadSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const ReactionChangedPayloadSchema = z
  .object({
    targetType: z.enum(['message', 'post', 'comment']),
    targetId: z.string(),
    // `kind` is an opaque response-kind discriminator, NOT the emoji glyph.
    // The mobile client refetches the aggregated reaction state via REST.
    kind: z.string(),
    delta: z.number().int(),
  })
  .strict();

export const EventStateChangedPayloadSchema = z
  .object({
    eventId: z.string(),
    fromState: z.string(),
    toState: z.string(),
    at: z.string(),
  })
  .strict();

export const ChallengeProgressChangedPayloadSchema = z
  .object({
    challengeId: z.string(),
    userId: z.string(),
    percent: z.number(),
  })
  .strict();

export const ModerationActionCreatedPayloadSchema = z
  .object({
    actionId: z.string(),
    wsId: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    action: z.string(),
  })
  .strict();

export const MembershipChangedPayloadSchema = z
  .object({
    wsId: z.string(),
    userId: z.string(),
    change: z.enum(['joined', 'left', 'promoted', 'demoted']),
  })
  .strict();

// ─── Inferred TS types ─────────────────────────────────────────────────────

export type MessageCreatedPayload = z.infer<typeof MessageCreatedPayloadSchema>;
export type MessageUpdatedPayload = z.infer<typeof MessageUpdatedPayloadSchema>;
export type PostCreatedPayload = z.infer<typeof PostCreatedPayloadSchema>;
export type PostUpdatedPayload = z.infer<typeof PostUpdatedPayloadSchema>;
export type ReactionChangedPayload = z.infer<
  typeof ReactionChangedPayloadSchema
>;
export type EventStateChangedPayload = z.infer<
  typeof EventStateChangedPayloadSchema
>;
export type ChallengeProgressChangedPayload = z.infer<
  typeof ChallengeProgressChangedPayloadSchema
>;
export type ModerationActionCreatedPayload = z.infer<
  typeof ModerationActionCreatedPayloadSchema
>;
export type MembershipChangedPayload = z.infer<
  typeof MembershipChangedPayloadSchema
>;

/** Union of every broadcast payload shape v1-4 can emit. */
export type CommunityBroadcastPayload =
  | MessageCreatedPayload
  | MessageUpdatedPayload
  | PostCreatedPayload
  | PostUpdatedPayload
  | ReactionChangedPayload
  | EventStateChangedPayload
  | ChallengeProgressChangedPayload
  | ModerationActionCreatedPayload
  | MembershipChangedPayload;
