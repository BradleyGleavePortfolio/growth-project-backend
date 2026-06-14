import { IsOptional, IsString, MaxLength } from 'class-validator';
import { z } from 'zod';

/** Cursor pagination query for the coach inbox. */
export class CoachInboxQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(96)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string;
}

// ── Response schema (Zod) ──────────────────────────────────────────────────

// v2-2: OPTIONAL per-thread ack summary, present ONLY when
// FEATURE_COMMUNITY_ACKS is on (omitted entirely when off, preserving the v1-6
// inbox shape byte-for-byte). Summarises the coach ack state for the item plus
// the derived read-time SLA state so the inbox can render a badge + SLA chip
// without a second round-trip. Posts have no coach-ack columns, so this is
// only attached to message-type items.
export const InboxAckSummarySchema = z
  .object({
    state: z.enum(['none', 'seen', 'acked', 'replied']),
    sla_state: z.enum(['within', 'warning', 'breached']),
  })
  .strict();

export type InboxAckSummary = z.infer<typeof InboxAckSummarySchema>;

export const InboxItemSchema = z
  .object({
    id: z.guid(),
    type: z.enum(['message', 'post']),
    cohort_id: z.guid(),
    cohort_name: z.string(),
    author_user_id: z.guid(),
    author_display_name: z.string(),
    preview: z.string().max(200),
    created_at: z.string().datetime(),
    item_url_path: z.string(),
    // v2-2: see InboxAckSummarySchema. .optional() so the key is simply absent
    // when the flag is off.
    ack: InboxAckSummarySchema.optional(),
  })
  .strict();

export type InboxItemView = z.infer<typeof InboxItemSchema>;

export const CoachInboxResponseSchema = z
  .object({
    items: z.array(InboxItemSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();

export type CoachInboxResponse = z.infer<typeof CoachInboxResponseSchema>;
