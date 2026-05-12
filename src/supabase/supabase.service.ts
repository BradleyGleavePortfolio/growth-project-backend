import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;
  private readonly logger = new Logger(SupabaseService.name);

  constructor() {
    // Node 20 lacks native WebSocket; supabase-js >=2.105 requires an explicit
    // transport when running under Node <22.
    this.client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { realtime: { transport: ws as any } },
    );
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  /**
   * Send a Realtime Broadcast ping on the user's message channel. The mobile
   * client subscribes to this channel and refetches its message thread when
   * the ping arrives.
   *
   * Critically: this carries NO message body. Just a refresh signal. The
   * actual data is delivered through the authenticated REST API which
   * enforces tenant isolation. This means we don't depend on RLS being
   * configured for messaging — even a misconfigured Realtime channel can't
   * leak data because no data is sent.
   *
   * Failures are swallowed: if the broadcast can't be sent (network, Supabase
   * outage), the mobile client's 60s backstop poll will still catch up.
   */
  async broadcastNewMessage(userId: string): Promise<void> {
    if (!userId) return;
    try {
      const channel = this.client.channel(`messages:${userId}`);
      // Subscribe-and-send pattern: Realtime requires the channel to be
      // subscribed before send() will deliver. We subscribe, send, then
      // immediately remove — it's a fire-and-forget signal.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 1500);
        channel.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try {
              await channel.send({
                type: 'broadcast',
                event: 'new-message',
                payload: {},
              });
            } catch {
              /* swallow */
            }
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      await this.client.removeChannel(channel);
    } catch (err) {
      // Realtime is best-effort — never fail the request because of it.
      this.logger.warn(
        `broadcastNewMessage failed for ${userId}: ${(err as Error).message}`,
      );
    }
  }
}
