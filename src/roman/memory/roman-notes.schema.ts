/**
 * Roman v1.1 slice R11-M4: the shape of one note Roman keeps from a client's
 * own chat messages (RomanClientNote, prisma/schema.prisma:8718-8721).
 *
 * validateRomanNote is the single gate for model output: a closed kind, key
 * `<kind>.<slug>`, text of 3-160 characters with no contact details or
 * prompt-injection markers, and a source that is one of the turns sent. A
 * drop carries a code only, never the offending text, so it is safe to log.
 */
import { z } from 'zod';
import { sanitizePromptInput } from '../../ai/utils/sanitize-prompt-input';
import { containsContact } from '../playbook/playbook-scrub';

/** Closed kinds (SQL CHECK RomanClientNote_kind_check). */
export const ROMAN_NOTE_KINDS = [
  'preference', 'schedule', 'household', 'work', 'injury_history', 'goal',
  'equipment', 'diet_like', 'diet_dislike', 'travel', 'other',
] as const;
export type RomanNoteKind = (typeof ROMAN_NOTE_KINDS)[number];

export const ROMAN_NOTE_SLUG_RE = /^[a-z0-9_]{1,40}$/;
export const ROMAN_NOTE_TEXT_MIN = 3;
export const ROMAN_NOTE_TEXT_MAX = 160;
/** Most notes one model reply may add or change. */
export const ROMAN_NOTES_PER_REPLY_MAX = 12;
/** Kinds that go stale: they expire 30 days after the client said them. */
export const ROMAN_NOTE_EXPIRING_KINDS: ReadonlySet<string> = new Set(['schedule', 'travel']);
export const ROMAN_NOTE_EXPIRY_DAYS = 30;

export type RomanNoteDropCode = 'shape' | 'kind' | 'key' | 'text' | 'contact' | 'unsafe' | 'source';

/** A storable note; `source` is the turn reference it came from ("t3"). */
export type RomanNoteCandidate = { kind: RomanNoteKind; key: string; text: string; source: string };

const itemSchema = z.object({
  kind: z.string(),
  key: z.string(),
  text: z.string(),
  source: z.string(),
});

/** One model item -> a storable note, or the reason it is dropped. */
export function validateRomanNote(
  raw: unknown,
  sources: ReadonlySet<string>,
): { ok: true; note: RomanNoteCandidate } | { ok: false; code: RomanNoteDropCode } {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'shape' };
  const { kind, key, source } = parsed.data;
  const known = ROMAN_NOTE_KINDS.find((k) => k === kind);
  if (!known) return { ok: false, code: 'kind' };
  const prefix = `${known}.`;
  if (!key.startsWith(prefix) || !ROMAN_NOTE_SLUG_RE.test(key.slice(prefix.length))) {
    return { ok: false, code: 'key' };
  }
  const text = parsed.data.text.replace(/\s+/g, ' ').trim();
  if (text.length < ROMAN_NOTE_TEXT_MIN || text.length > ROMAN_NOTE_TEXT_MAX) {
    return { ok: false, code: 'text' };
  }
  if (containsContact(text)) return { ok: false, code: 'contact' };
  if (sanitizePromptInput(text, ROMAN_NOTE_TEXT_MAX * 2).includes('[REDACTED]')) {
    return { ok: false, code: 'unsafe' };
  }
  if (!sources.has(source)) return { ok: false, code: 'source' };
  return { ok: true, note: { kind: known, key, text, source } };
}

/** The `notes` list of a model reply, or null when the reply is not that JSON. */
export function parseRomanNotesReply(reply: string): unknown[] | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(reply.slice(start, end + 1));
    if (typeof value !== 'object' || value === null || !('notes' in value)) return null;
    return Array.isArray(value.notes) ? value.notes : null;
  } catch {
    return null;
  }
}

/** Default expiry: 30 days after the source turn for schedule and travel, none otherwise. */
export function romanNoteExpiresAt(kind: RomanNoteKind, sourceAt: Date): Date | null {
  if (!ROMAN_NOTE_EXPIRING_KINDS.has(kind)) return null;
  return new Date(sourceAt.getTime() + ROMAN_NOTE_EXPIRY_DAYS * 86_400_000);
}
