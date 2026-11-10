/**
 * ROMAN-QUOTE-SAFETY-BE: a Reply in the client's Roman room (growth-project-mobile#950) sends one text, the first
 * line "> " and an excerpt of one of Roman's replies, a blank line, then the member's own words. The route takes
 * `content` only, so a member can type the same shape by hand: the shape alone proves nothing. The crisis check
 * reads the member's words alone only when the excerpt is shown to open a stored Roman reply (the service reads
 * those, scoped to the caller); every other text is classified whole, as before. Pure functions, no I/O.
 */

/** The phone's wire form, character for character (mobile src/components/roman/romanQuoteSplit.ts:5). */
const QUOTED = /^> ([^\n]+)\n\n([\s\S]*\S[\s\S]*)$/;

/** The quote line and the member's words of a text in the phone's reply form, or null. Run on the raw text. */
export function splitRomanQuote(text: string): { quote: string; body: string } | null {
  const m = QUOTED.exec(text);
  return m ? { quote: m[1], body: m[2] } : null;
}

/**
 * True when `quote` is the opening of `reply` as the phone excerpts it (mobile romanReply.ts:22-26: `**` and `__`
 * removed, whitespace collapsed, trimmed; a cut excerpt ends in U+2026). A prefix match: every character the check
 * then leaves unread is literally Roman's.
 */
export function quoteOpensReply(quote: string, reply: string): boolean {
  const opening = quote.replace(/…$/, '').trimEnd();
  const view = reply.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  return opening.length > 0 && view.startsWith(opening);
}
