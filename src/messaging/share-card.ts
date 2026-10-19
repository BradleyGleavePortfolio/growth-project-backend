import { BadRequestException } from '@nestjs/common';

/**
 * SHARE-BE (#SHARE-SEND option 1): the one card a CLIENT may send, a picture
 * card of their own progress, into the thread with their current coach. It
 * is kept apart from the coach CARD_TYPES (broadcasts/cards.service.ts) and
 * stored in coach_message_cards (RLS enabled and forced, service_role only)
 * with ref_id NULL. The snapshot IS the card, so it must match this closed
 * schema: a kind, one number, its words and its dates, nothing else, under a
 * hard byte cap. A share travels alone (no body, no voice). Any failure is
 * 400 SHARE_CARD_INVALID, a code only: the phone owns the words.
 */
export const SHARE_CARD_TYPE = 'share';
export const SHARE_KINDS = ['weigh_in_run', 'recent_best'] as const;
export const SHARE_SNAPSHOT_MAX_BYTES = 512;
export const SHARE_WORDS_MAX = 60;
export const SHARE_VALUE_MAX = 10_000;

export type ShareSnapshot = {
  kind: (typeof SHARE_KINDS)[number];
  /** weigh_in_run: days in the run. recent_best: the weight in lb. */
  value: number;
  /** The card's own words next to the number: "days in a row", or the lift. */
  words: string;
  /** First day of a run (YYYY-MM-DD); absent on a one-day card. */
  from?: string;
  /** Last day of the run, or the day of the best (YYYY-MM-DD). */
  to: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isKind = (v: unknown): v is ShareSnapshot['kind'] =>
  SHARE_KINDS.some((k) => k === v);
const isValue = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= SHARE_VALUE_MAX;
const isWords = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= SHARE_WORDS_MAX &&
  v.trim() === v &&
  !/\p{Cc}/u.test(v);
/** A real calendar day: 2026-02-30 fails the round trip. */
const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/** The checked share snapshot of a client send, or null when it carries no card. */
export function shareCardOf(payload: {
  card?: unknown;
  body?: string;
  voice?: unknown;
}): ShareSnapshot | null {
  const { card } = payload;
  if (card === undefined) return null;
  const invalid = () => new BadRequestException({ error: 'SHARE_CARD_INVALID' });
  if (!isRecord(card) || card.type !== SHARE_CARD_TYPE || !isRecord(card.snapshot)) {
    throw invalid();
  }
  const snapshot = card.snapshot;
  if (
    Object.keys(card).length !== 2 ||
    payload.body !== undefined ||
    payload.voice !== undefined ||
    Buffer.byteLength(JSON.stringify(snapshot)) > SHARE_SNAPSHOT_MAX_BYTES
  ) {
    throw invalid();
  }
  const { kind, value, words, from, to, ...extra } = snapshot;
  if (Object.keys(extra).length > 0) throw invalid();
  if (!isKind(kind) || !isValue(value) || !isWords(words) || !isDay(to)) throw invalid();
  if (from !== undefined && !(isDay(from) && from <= to)) throw invalid();
  return { kind, value, words, ...(isDay(from) ? { from } : {}), to };
}
