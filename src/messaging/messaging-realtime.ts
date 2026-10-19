/**
 * MSGRT — coach-client message pings. Every ping about a coach-client chat
 * goes to the PRIVATE topic of each of the two people in it (the client and
 * their coach), `messages:user:<User.id>`, through the one sender,
 * SupabaseService.pingChat. Realtime lets a signed-in person receive on their
 * own topic only (policy messages_realtime_own_topic_receive on
 * realtime.messages, 20270502003700); there is no INSERT policy, so only the
 * server sends, and a private broadcast never reaches a public channel. The
 * payload stays empty: the app refetches through the authenticated REST
 * routes, which enforce tenancy and blocks.
 *
 * `new-message` is a new message; `thread-updated` (A3-MSG-CORE) is a change
 * that is not one (read receipts, edits, deletes, pins), so it never triggers
 * the new-message refresh-and-read path.
 */
export const THREAD_UPDATED_EVENT = 'thread-updated';

export type ChatPingEvent = 'new-message' | typeof THREAD_UPDATED_EVENT;

export type ThreadUpdateKind = 'read' | 'edited' | 'deleted' | 'pinned' | 'unpinned';

/** The two people in a coach-client chat: the thread coach and the client. */
export interface ChatPair {
  coachId: string;
  clientId: string;
}

/** The private topic only this person may receive on. */
export const messagesTopic = (userId: string): string => `messages:user:${userId}`;
