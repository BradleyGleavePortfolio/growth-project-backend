import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** POST /community/dms/threads — open (or fetch) a 1:1 thread. */
export class CreateDmThreadDto {
  @IsUUID()
  recipient_user_id!: string;
}

/** POST /community/dms/threads/:threadId/messages — send a DM. */
export class SendDmDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'DM body must not be empty' })
  @MaxLength(4000, { message: 'DM body must be 4000 characters or fewer' })
  body!: string;
}

// ── Response schemas (Zod) ─────────────────────────────────────────────────

export const CommunityDmThreadSchema = z
  .object({
    thread_id: z.string(),
    workspace_id: z.string().uuid(),
    other_user_id: z.string().uuid(),
    created_at: z.string().datetime().nullable(),
    last_message_at: z.string().datetime().nullable(),
  })
  .strict();

export type CommunityDmThreadView = z.infer<typeof CommunityDmThreadSchema>;

export const CommunityDmThreadResponseSchema = z
  .object({ thread: CommunityDmThreadSchema })
  .strict();
export type CommunityDmThreadResponse = z.infer<
  typeof CommunityDmThreadResponseSchema
>;

export const CommunityDmThreadListResponseSchema = z
  .object({ threads: z.array(CommunityDmThreadSchema) })
  .strict();
export type CommunityDmThreadListResponse = z.infer<
  typeof CommunityDmThreadListResponseSchema
>;

export const CommunityDmMessageSchema = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string(),
    sender_user_id: z.string().uuid(),
    recipient_user_id: z.string().uuid(),
    body: z.string().nullable(),
    created_at: z.string().datetime(),
    deleted: z.boolean(),
  })
  .strict();

export type CommunityDmMessageView = z.infer<typeof CommunityDmMessageSchema>;

export const CommunityDmMessageResponseSchema = z
  .object({ message: CommunityDmMessageSchema })
  .strict();
export type CommunityDmMessageResponse = z.infer<
  typeof CommunityDmMessageResponseSchema
>;

export const CommunityDmMessageListResponseSchema = z
  .object({ messages: z.array(CommunityDmMessageSchema) })
  .strict();
export type CommunityDmMessageListResponse = z.infer<
  typeof CommunityDmMessageListResponseSchema
>;
