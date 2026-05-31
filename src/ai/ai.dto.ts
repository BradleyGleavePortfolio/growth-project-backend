import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// Global ValidationPipe (main.ts) runs with whitelist=true +
// forbidNonWhitelisted=true + transform=true, so any unknown field on the
// wire is rejected and nested DTOs are instantiated for @ValidateNested.
//
// A1 (non-schema half): cap the free-text fields so a client can't drive a
// token-amplification request. A9: the history `role` is a strict
// 'user'|'assistant' union — a client-supplied 'system' (or any other) role
// is rejected at the HTTP boundary so it can never be folded into the prompt
// with a privileged role. The daily-token-quota (UserAIQuota) persistence is
// now enforced in AiService.chat() via a reserve-then-reconcile atomic
// increment against the Wave-0 UserAIQuota table — see ai.service.ts and the
// build report.
//
// ACCEPTED-LIMITATION (A1, owner-accepted): these character caps and the
// service-side reservation estimate (chars/APPROX_CHARS_PER_TOKEN) bound the
// pre-spend gate only on a BEST-EFFORT basis — char-based estimates are not a
// provable token upper bound (CJK / emoji / base64 can exceed them) and do not
// count the system-prompt tokens. The EXACT post-call reconcile in
// AiService.reconcileDailyTokens() is what makes the daily total authoritative;
// the pre-gate is bounded best-effort. See the ACCEPTED-LIMITATION note in
// ai.service.ts.

// Conservative caps. A single chat turn and the live message share the same
// ceiling; the history is bounded so a request can't smuggle an unbounded
// transcript.
export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_HISTORY_MAX_TURNS = 50;

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export class ChatMessageDto {
  @IsIn(CHAT_ROLES)
  role!: ChatRole;

  @IsString()
  @MaxLength(CHAT_MESSAGE_MAX_LENGTH)
  content!: string;
}

export class ChatRequestDto {
  @IsString()
  @MaxLength(CHAT_MESSAGE_MAX_LENGTH)
  message!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CHAT_HISTORY_MAX_TURNS)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  conversation_history?: ChatMessageDto[];
}
