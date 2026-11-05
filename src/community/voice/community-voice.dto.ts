import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

/**
 * community-voice.dto.ts — request/response shapes for the v3-3 voice-notes
 * surface. class-validator DTOs guard the inbound write/upload bodies; zod
 * schemas validate the outbound view so a shape drift is a runtime parse error,
 * not a silent leak (Failure #8 — phantom validation).
 */

// ─── Server thresholds (brief §Pre-computed thresholds) ─────────────────────

/** Max voice duration — 300000 ms / 5 min. Env: VOICE_NOTE_MAX_DURATION_MS. */
export const MAX_VOICE_DURATION_MS = 300_000;
/** Max voice payload size — 25 MB. Env: VOICE_NOTE_MAX_BYTES. */
export const MAX_VOICE_BYTES = 25_000_000;
/** Min positive duration (a 0/negative duration is never a real recording). */
export const MIN_VOICE_DURATION_MS = 1;

/**
 * The four allowed voice MIME types (brief §Allowed mime types). The server is
 * authoritative; the mobile recorder produces audio/mp4 (iOS), audio/aac, or
 * audio/webm (Android/web), and audio/wav is accepted for completeness. A type
 * outside this set is rejected before any signed URL is minted.
 */
export const VOICE_NOTE_MIME_ALLOWLIST = [
  'audio/mp4',
  'audio/aac',
  'audio/webm',
  'audio/wav',
] as const;
export type VoiceNoteMimeType = (typeof VOICE_NOTE_MIME_ALLOWLIST)[number];

/**
 * Mutable copy for class-validator's @IsIn (it expects a plain string[]). Kept
 * in sync with the readonly tuple above by deriving from it directly — no cast.
 */
export const VOICE_NOTE_MIME_VALUES: string[] = [...VOICE_NOTE_MIME_ALLOWLIST];

/**
 * VOICE-BE: waveform peaks are the phone's loudness bars, each 0..1, at most
 * 64 (the phone's own MAX_PEAKS). Stored one byte per bar (0..255) in
 * community_voice_notes.waveform_peaks and returned as 0..1 to 3 places.
 */
export const MAX_WAVEFORM_PEAKS = 64;
export const peaksToBytes = (peaks: number[] | undefined): Uint8Array<ArrayBuffer> | null =>
  peaks?.length ? Uint8Array.from(peaks, (p) => Math.round(p * 255)) : null;
export const bytesToPeaks = (bytes: Uint8Array | null | undefined): number[] | null =>
  bytes?.length ? Array.from(bytes, (b) => Math.round((b / 255) * 1000) / 1000) : null;

/** Defensive page size for the voice-note list read (Failure #28 unbounded). */
export const VOICE_PAGE_DEFAULT_LIMIT = 20;
export const VOICE_PAGE_MAX_LIMIT = 50;

const toInt = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  }
  return value;
};

// ─── Request DTOs ───────────────────────────────────────────────────────────

/**
 * Body for POST .../voice-notes/upload-url — issue a signed upload URL. The
 * server validates duration/size/mime BEFORE minting the URL so a URL is never
 * issued for a payload that would be rejected at publish time.
 */
export class IssueVoiceUploadDto {
  @IsInt()
  @Min(MIN_VOICE_DURATION_MS)
  @Max(MAX_VOICE_DURATION_MS)
  @Transform(toInt)
  duration_ms!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_VOICE_BYTES)
  @Transform(toInt)
  bytes!: number;

  @IsIn(VOICE_NOTE_MIME_VALUES)
  mime_type!: VoiceNoteMimeType;

  // BPF-1: the space the note is for (the id the create sends). With it, the
  // upload answers to that space's rule; without it, the Hall's.
  @IsOptional()
  @IsUUID('4')
  cohort_id?: string;
}

/**
 * Body for POST .../voice-notes — durably record a voice note AFTER its upload
 * is confirmed. `storage_key` must be the key minted by the upload-url call;
 * exactly one of cohort_id / conversation_id targets the note (a channel note
 * may omit both → workspace hall). The same duration/size/mime limits re-apply
 * server-side; the client is never trusted on the second hop either.
 */
export class CreateVoiceNoteDto {
  @IsOptional()
  @IsUUID('4')
  cohort_id?: string;

  @IsOptional()
  @IsUUID('4')
  conversation_id?: string;

  // The storage key returned by upload-url. Free-form opaque key; the service
  // re-derives + re-asserts the owner namespace prefix so a forged key for
  // another principal's path is rejected (bucket-binding, not client-trusted).
  // Decorated so the global ValidationPipe (whitelist + forbidNonWhitelisted)
  // keeps it: without a decorator every create was rejected with
  // "property storage_key should not exist".
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  storage_key!: string;

  @IsInt()
  @Min(MIN_VOICE_DURATION_MS)
  @Max(MAX_VOICE_DURATION_MS)
  @Transform(toInt)
  duration_ms!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_VOICE_BYTES)
  @Transform(toInt)
  bytes!: number;

  @IsIn(VOICE_NOTE_MIME_VALUES)
  mime_type!: VoiceNoteMimeType;

  // VOICE-BE: the bars the phone drew while recording (bounded, each 0..1).
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WAVEFORM_PEAKS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  @Min(0, { each: true })
  @Max(1, { each: true })
  waveform_peaks?: number[];

  // VOICE-BE: a reply. The chat message (text or voice) in the same space this
  // note answers; a reply to a reply joins the first message's thread.
  @IsOptional()
  @IsUUID('4')
  parent_message_id?: string;
}

/** Query DTO for the list read — clamps the page size server-side. */
export class ListVoiceNotesQueryDto {
  @IsOptional()
  @IsUUID('4')
  cohort_id?: string;

  @IsOptional()
  @IsUUID('4')
  conversation_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VOICE_PAGE_MAX_LIMIT)
  @Transform(toInt)
  limit?: number;

  @IsOptional()
  cursor?: string;
}

// ─── Response schemas (zod, strict) ─────────────────────────────────────────

export const VoiceUploadTargetSchema = z
  .object({
    upload_url: z.string(),
    storage_key: z.string(),
    expires_at: z.string(),
    expires_in_seconds: z.number().int(),
    bucket: z.string(),
  })
  .strict();
export type VoiceUploadTarget = z.infer<typeof VoiceUploadTargetSchema>;

export const VoiceNoteViewSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    cohort_id: z.string().nullable(),
    conversation_id: z.string().nullable(),
    author_id: z.string(),
    // Time-limited signed download URL minted at read time, or null when
    // storage is unconfigured (player renders a disabled state, not a 500).
    url: z.string().nullable(),
    duration_ms: z.number().int(),
    bytes: z.number().int(),
    mime_type: z.string(),
    has_waveform: z.boolean(),
    created_at: z.string(),
    // VOICE-BE: the name the viewer may see (#C6-NAMES-EVERYWHERE), whether
    // the author is the workspace coach, the bars, when this viewer heard it,
    // and the note's chat message (same id; null for a Hall note) and thread.
    author_name: z.string(),
    author_is_coach: z.boolean(),
    waveform_peaks: z.array(z.number()).nullable(),
    heard_at: z.string().nullable(),
    message_id: z.string().nullable(),
    parent_message_id: z.string().nullable(),
  })
  .strict();
export type VoiceNoteView = z.infer<typeof VoiceNoteViewSchema>;

export const VoiceHeardResponseSchema = z
  .object({ voice_note_id: z.string(), heard_at: z.string() })
  .strict();
export type VoiceHeardResponse = z.infer<typeof VoiceHeardResponseSchema>;
export const VoiceConsentResponseSchema = z
  .object({ seen: z.boolean(), seen_at: z.string().nullable() })
  .strict();
export type VoiceConsentResponse = z.infer<typeof VoiceConsentResponseSchema>;

export const VoiceNoteResponseSchema = z.object({ voice_note: VoiceNoteViewSchema }).strict();
export type VoiceNoteResponse = z.infer<typeof VoiceNoteResponseSchema>;

export const VoiceNoteFeedResponseSchema = z
  .object({
    voice_notes: z.array(VoiceNoteViewSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();
export type VoiceNoteFeedResponse = z.infer<typeof VoiceNoteFeedResponseSchema>;
