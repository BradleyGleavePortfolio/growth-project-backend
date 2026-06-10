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
