import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// API-facing report target. `comment` is accepted for API completeness and
// mapped onto the schema's `message` moderation target type (comments are
// stored as CommunityMessage rows — see CommunityCommentsService). The schema
// enum CommunityModerationTargetType has no `comment` member.
export const REPORT_TARGET_TYPES = ['message', 'post', 'comment'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** POST /community/moderation/reports — file a report. */
export class CreateReportDto {
  @IsIn(REPORT_TARGET_TYPES, { message: 'unsupported report target type' })
  target_type!: ReportTargetType;

  @IsUUID()
  target_id!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(80, { message: 'reason must be 80 characters or fewer' })
  reason!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: 'notes must be 2000 characters or fewer' })
  notes?: string;
}

// Coach actions on a moderation item. `dismiss` closes with no enforcement;
// hide/warn/ban record the enforcement taken and mark the item `actioned`.
export const MODERATION_ACTIONS = ['hide', 'warn', 'ban', 'dismiss'] as const;
export type ModerationActionKind = (typeof MODERATION_ACTIONS)[number];

/** PATCH /community/moderation/items/:itemId — act on an item (coach-only). */
export class ActOnItemDto {
  @IsIn(MODERATION_ACTIONS, { message: 'unsupported moderation action' })
  action!: ModerationActionKind;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: 'notes must be 2000 characters or fewer' })
  notes?: string;
}

// ── Response schemas (Zod) ─────────────────────────────────────────────────

export const CommunityModerationItemSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    target_type: z.enum(['message', 'post', 'reaction', 'event', 'challenge', 'member']),
    target_id: z.string().uuid(),
    reported_by_user_id: z.string().uuid().nullable(),
    actor_user_id: z.string().uuid().nullable(),
    status: z.enum(['open', 'reviewed', 'actioned', 'dismissed']),
    reason: z.string(),
    notes: z.string().nullable(),
    action: z.string().nullable(),
    created_at: z.string().datetime(),
    resolved_at: z.string().datetime().nullable(),
  })
  .strict();

export type CommunityModerationItemView = z.infer<
  typeof CommunityModerationItemSchema
>;

export const CommunityModerationItemResponseSchema = z
  .object({ item: CommunityModerationItemSchema })
  .strict();
export type CommunityModerationItemResponse = z.infer<
  typeof CommunityModerationItemResponseSchema
>;

export const CommunityModerationItemListResponseSchema = z
  .object({ items: z.array(CommunityModerationItemSchema) })
  .strict();
export type CommunityModerationItemListResponse = z.infer<
  typeof CommunityModerationItemListResponseSchema
>;
