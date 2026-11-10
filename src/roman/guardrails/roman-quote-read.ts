/**
 * ROMAN-QUOTE-READERS-BE: the one read and proof every server reader of a stored client turn shares (the crisis
 * checks through RomanService.ownWordsOf, the notes writer, the history tool). A turn in the phone's Reply form
 * (roman-quote.ts) gives the member's words alone only when its quote is the phone's exact excerpt of a Roman reply
 * in that turn's own client-surface chat, owned by `userId`, not deleted; every other turn stays whole.
 */
import type { PrismaService } from '../../prisma.service';
import { withoutCites } from '../../copilot/copilot-turn';
import { ROMAN_MESSAGES_MAX_LIMIT } from '../roman.constants';
import { romanErrorTag } from '../roman-error-tag';
import { quoteLimitFor, quoteOpensReply, splitRomanQuote } from './roman-quote';

/** A turn's raw text as stored or sent, and the chat it belongs to. */
export interface RomanTurnText {
  text: string;
  sessionId: string;
}

/**
 * One string per turn: the member's own words, or the text as sent. No turn in the shape: no read. Else one read
 * of the newest ROMAN_MESSAGES_MAX_LIMIT Roman rows of those chats (@@index([session_id, created_at])), before
 * `before` when given, with no interrupted filter (a partial reply can be quoted too), each compared as the room
 * reads it (a Copilot reply without its [n], as GET messages gives it). A reply past that page is unproven. A failed
 * read hands `warn` the error's code (never its text) and leaves every turn whole.
 */
export async function ownWordsOfTurns(
  prisma: Pick<PrismaService, 'romanMessage'>,
  userId: string,
  turns: RomanTurnText[],
  warn: (code: string) => void,
  before?: Date,
): Promise<string[]> {
  const split = turns.map((t) => splitRomanQuote(t.text));
  const chats = [...new Set(turns.filter((_, i) => split[i]).map((t) => t.sessionId))];
  if (chats.length === 0) return turns.map((t) => t.text);
  const views = new Map<string, string[]>();
  try {
    const rows = await prisma.romanMessage.findMany({
      where: {
        session_id: { in: chats },
        user_id: userId,
        role: 'roman',
        session: { user_id: userId, surface: 'client', deleted_at: null },
        ...(before ? { created_at: { lt: before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: ROMAN_MESSAGES_MAX_LIMIT,
      select: { session_id: true, content: true, copilot: true },
    });
    for (const r of rows) {
      views.set(r.session_id, [...(views.get(r.session_id) ?? []), r.copilot ? withoutCites(r.content) : r.content]);
    }
  } catch (err) {
    warn(romanErrorTag(err));
    return turns.map((t) => t.text);
  }
  return turns.map((t, i) => {
    const q = split[i];
    if (!q) return t.text;
    const limit = quoteLimitFor(q.body);
    return (views.get(t.sessionId) ?? []).some((v) => quoteOpensReply(q.quote, v, limit)) ? q.body : t.text;
  });
}
