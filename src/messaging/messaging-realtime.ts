import { Logger } from '@nestjs/common';
import type { SupabaseService } from '../supabase/supabase.service';
import { describeFailure } from '../observability/log-pii';

/**
 * A3-MSG-CORE — refresh pings for thread changes that are not a new message
 * (read receipts, edits, deletes, pins). Sent on the SAME per-user channel
 * the mobile app already subscribes to (`messages:<userId>`, see
 * SupabaseService.broadcastNewMessage) under a DISTINCT event name, so an
 * edit or read receipt never triggers the new-message banner or sound.
 *
 * B-709-1: that channel is public (anyone with the anon key and a user id can
 * join it), so the payload is empty, exactly like broadcastNewMessage: no
 * client id, no message id, no change kind. The recipient refetches through
 * the authenticated REST routes, which enforce tenancy and blocks.
 * Best-effort: bounded by a 1500 ms timeout, failures are logged and
 * swallowed (the REST poll floor still catches up). Never awaited by callers
 * on the request path.
 */
export const THREAD_UPDATED_EVENT = 'thread-updated';

export type ThreadUpdateKind = 'read' | 'edited' | 'deleted' | 'pinned' | 'unpinned';

const BROADCAST_TIMEOUT_MS = 1500;
const logger = new Logger('MessagingRealtime');

export async function broadcastThreadUpdated(
  supabase: SupabaseService,
  recipientId: string,
): Promise<void> {
  if (!recipientId) return;
  try {
    const client = supabase.getClient();
    const channel = client.channel(`messages:${recipientId}`);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), BROADCAST_TIMEOUT_MS);
      channel.subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        try {
          await channel.send({
            type: 'broadcast',
            event: THREAD_UPDATED_EVENT,
            payload: {},
          });
        } catch (sendErr) {
          logger.warn(`thread-updated send failed: ${describeFailure(sendErr)}`);
        }
        clearTimeout(timeout);
        resolve();
      });
    });
    await client.removeChannel(channel);
  } catch (err) {
    logger.warn(`thread-updated broadcast failed: ${describeFailure(err)}`);
  }
}
