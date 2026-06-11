import { IsOptional, IsString, MaxLength } from 'class-validator';
import { z } from 'zod';
import { AckStateSchema } from '../ack/ack.dto';

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

// v2-2 (R1 fixer, B-NEW — contract alignment): the per-thread inbox ack
// envelope is the FULL canonical ack shape (`AckStateSchema` from ack.dto.ts):
// `{ state, seen_at, acked_at, replied_at, sla }`. It is present ONLY when
// FEATURE_COMMUNITY_ACKS is on (omitted entirely when off, preserving the v1-6
// inbox shape byte-for-byte).
//
// Why the full shape (not the prior `{ state, sla_state }` summary)? The mobile
// client parses every ack envelope — inbox row, message detail, and transition
// response — through ONE schema (`AckStateSchema`). Emitting a narrower summary
// here meant the mobile parse silently failed for inbox rows and the badge fell
// back to `none`, dropping real backend state (the R1 P0 silent-failure). One
// canonical envelope across all three surfaces removes that footgun for good.
// Posts have no coach-ack columns, so this is only attached to message items.
export const InboxAckSummarySchema = AckStateSchema;

export type InboxAckSummary = z.infer<typeof InboxAckSummarySchema>;

export const InboxItemSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['message', 'post']),
    cohort_id: z.string().uuid(),
    cohort_name: z.string(),
    author_user_id: z.string().uuid(),
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
