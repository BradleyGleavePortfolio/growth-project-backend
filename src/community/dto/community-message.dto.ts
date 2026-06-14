import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';
import { PlanContextTagSchema } from '../plan-context/plan-context.dto';

// Trim incoming body before validation so a whitespace-only payload fails the
// MinLength(1) check rather than slipping through as a "non-empty" string.
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** POST /community/cohorts/:cohortId/messages — send a cohort message. */
export class CreateMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'message body must not be empty' })
  @MaxLength(4000, { message: 'message body must be 4000 characters or fewer' })
  body!: string;

  // v2-1 plan-context tag (OPTIONAL, additive). Declared as a loose object here
  // so `forbidNonWhitelisted` accepts the field; the precise discriminated-union
  // shape is enforced by PlanContextTagSchema (Zod) in CommunityMessagesService
  // before any persistence, which raises a structured 422 on a malformed tag.
  // When FEATURE_COMMUNITY_PLAN_TAGS is off the field is dropped on send.
  @IsOptional()
  @IsObject()
  plan_context?: unknown;
}

/** PATCH /community/messages/:messageId — edit own message (5-min window). */
export class EditMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'message body must not be empty' })
  @MaxLength(4000, { message: 'message body must be 4000 characters or fewer' })
  body!: string;
}

/** Cursor pagination query for message listings. */
export class ListMessagesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  before?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string;
}

// ── Response schemas (Zod, matching the v1-2 .parse() convention) ──────────

// v2-2: the OPTIONAL coach ack envelope. Present ONLY when
// FEATURE_COMMUNITY_ACKS is on; absent entirely when the flag is off so the
// v1-6/v2-1 response shape is byte-for-byte preserved (back-compat /
// kill-switch invariant). Coach-side-only signals shown TO the client:
// seen/acked/replied timestamps plus the derived read-time SLA state.
export const MessageAckEnvelopeSchema = z
  .object({
    seen_at: z.string().datetime().nullable(),
    acked_at: z.string().datetime().nullable(),
    replied_at: z.string().datetime().nullable(),
    sla_state: z.enum(['within', 'warning', 'breached']),
  })
  .strict();

export type MessageAckEnvelope = z.infer<typeof MessageAckEnvelopeSchema>;

export const CommunityMessageSchema = z
  .object({
    id: z.guid(),
    cohort_id: z.guid().nullable(),
    sender_user_id: z.guid(),
    body: z.string().nullable(),
    kind: z.enum(['text', 'voice', 'system']),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    edited: z.boolean(),
    deleted: z.boolean(),
    // v2-1: the validated plan-context tag persisted on the row, or null when
    // the message carries no tag (the common case, and always null when the
    // FEATURE_COMMUNITY_PLAN_TAGS flag is off — the tag is dropped on send).
    plan_context: PlanContextTagSchema.nullable(),
    // v2-2: OPTIONAL coach ack envelope (see MessageAckEnvelopeSchema). Omitted
    // when FEATURE_COMMUNITY_ACKS is off; .optional() (not .nullable()) so the
    // key is simply absent in the flag-off shape.
    ack: MessageAckEnvelopeSchema.optional(),
  })
  .strict();

export type CommunityMessageView = z.infer<typeof CommunityMessageSchema>;

export const CommunityMessageResponseSchema = z
  .object({
    message: CommunityMessageSchema,
  })
  .strict();

export type CommunityMessageResponse = z.infer<
  typeof CommunityMessageResponseSchema
>;

export const CommunityMessageListResponseSchema = z
  .object({
    messages: z.array(CommunityMessageSchema),
    next_before: z.string().nullable(),
  })
  .strict();

export type CommunityMessageListResponse = z.infer<
  typeof CommunityMessageListResponseSchema
>;
