import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * The closed set of report reasons accepted by the API. Mobile sends one of
 * these verbatim — any other value is rejected by class-validator before
 * reaching the service. The list intentionally mirrors what the mobile
 * report sheet renders so the wire shape stays in lockstep with the UI.
 */
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'sexual',
  'self_harm',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export class ReportMessageDto {
  @IsUUID('4')
  messageId!: string;

  @IsEnum(REPORT_REASONS)
  reason!: ReportReason;

  // Free-text context. Optional. Capped to 1000 chars on the server (the
  // mobile DM sheet caps at 500; the server allows up to 1000 in case other
  // surfaces later submit longer notes).
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}
