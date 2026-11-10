/**
 * ROMAN-QUOTE-SAFETY-BE: a Reply in the client's Roman room (growth-project-mobile#950) sends one text, the first
 * line "> " and an excerpt of one of Roman's replies, a blank line, then the member's own words. The route takes
 * `content` only, so a member can type the same shape by hand: the shape alone proves nothing. A reader takes the
 * member's words alone only when the quote is the phone's own excerpt of a stored Roman reply (roman-quote-read.ts
 * reads those, scoped to the member); every other text is read whole, as before. Pure functions, no I/O.
 */

/** The phone's wire form, character for character (mobile src/components/roman/romanQuoteSplit.ts:5). */
const QUOTED = /^> ([^\n]+)\n\n([\s\S]*\S[\s\S]*)$/;

/**
 * ROMAN-QUOTE-READERS-BE: the phone's two numbers, mirrored. growth-project-mobile at
 * cd791b8c4532bfd017ecdd3980534b658f7b3365: ROMAN_QUOTE_MAX, src/components/roman/romanReply.ts:14;
 * ROMAN_MESSAGE_MAX_LENGTH, src/api/romanApi.ts:97, the same cap as SendMessageDto's @MaxLength(8000)
 * (src/roman/roman.dto.ts:35). A change there leaves quotes unproven (today's whole-turn answer), never wider.
 */
export const ROMAN_QUOTE_MAX = 200;
export const ROMAN_SEND_MAX = 8000;

/** The quote line and the member's words of a text in the phone's reply form, or null. Run on the raw text. */
export function splitRomanQuote(text: string): { quote: string; body: string } | null {
  const m = QUOTED.exec(text);
  return m ? { quote: m[1], body: m[2] } : null;
}

/** The phone's excerpt, character for character (mobile romanReply.ts:22-26 at cd791b8c). */
export function romanQuoteExcerpt(content: string, max: number = ROMAN_QUOTE_MAX): string {
  const line = content.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The excerpt limit the phone used for a reply with this body (withRomanQuote, romanReply.ts:35-37); below 1 it sent none. */
export function quoteLimitFor(body: string): number {
  return Math.min(ROMAN_QUOTE_MAX, ROMAN_SEND_MAX - body.length - 4);
}

/**
 * True when `quote` is exactly the phone's excerpt of `reply` at `limit` (LS-1236R1 C1 = LO-1236R1 C1): no prefix
 * or substring proves, so a member's own opening words on the quote line are read with the rest. A whole reply under
 * the limit is its own excerpt. Below 1 the phone sends no quote, so nothing proves.
 */
export function quoteOpensReply(quote: string, reply: string, limit: number = ROMAN_QUOTE_MAX): boolean {
  return limit >= 1 && quote === romanQuoteExcerpt(reply, limit);
}
