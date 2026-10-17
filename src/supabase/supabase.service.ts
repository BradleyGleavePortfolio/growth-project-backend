import { Injectable, Logger } from '@nestjs/common';
import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { WebSocket as WS } from 'ws';
import { describeFailure } from '../observability/log-pii';
import { messagesTopic, type ChatPair, type ChatPingEvent } from '../messaging/messaging-realtime';

const PING_TIMEOUT_MS = 1500;
const logger = new Logger('SupabaseService');

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;

  constructor() {
    // Node 20 lacks native WebSocket; supabase-js >=2.105 requires an explicit
    // transport when running under Node <22. We use the named `WebSocket`
    // export rather than `import ws from 'ws'` because this repo's tsconfig
    // does not set `esModuleInterop`, so the default-import shim compiles to
    // `ws_1.default` — which is undefined for ws (a CommonJS module whose
    // module.exports IS the constructor). The named import is safe under
    // both interop modes.
    this.client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { realtime: { transport: WS as any } },
    );
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  /**
   * MSGRT: the one sender of coach-client message pings. Every send path, edit,
   * delete, pin and read receipt calls it with the chat's two people (see
   * messaging-realtime.ts). Each gets one REST broadcast (httpSend, no socket
   * join) on their own PRIVATE topic with an empty payload: a refresh signal,
   * never message content. Bounded by a 1500 ms timeout and never rejects (a
   * failure is logged; the app's 60 s poll catches up), so callers `void` it.
   */
  async pingChat(chat: ChatPair, event: ChatPingEvent): Promise<void> {
    const people = [...new Set([chat.coachId, chat.clientId])].filter(Boolean);
    await Promise.all(
      people.map(async (userId) => {
        let channel: RealtimeChannel | null = null;
        try {
          channel = this.getClient().channel(messagesTopic(userId), { config: { private: true } });
          const res = await channel.httpSend(event, {}, { timeout: PING_TIMEOUT_MS });
          if (!res.success) throw new Error(res.error);
        } catch (err) {
          logger.warn(`${event} ping failed: ${describeFailure(err)}`);
        } finally {
          if (channel) {
            await this.getClient().removeChannel(channel)
              .catch((err) => logger.warn(`${event} ping cleanup failed: ${describeFailure(err)}`));
          }
        }
      }),
    );
  }
}
