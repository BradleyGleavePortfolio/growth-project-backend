import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { NotificationKind } from '../notification-kind';

export interface MessageReceivedPayload {
  /** The sender's display name — used in the notification body. */
  senderName: string;
  /** Thread ID for deep-link routing. */
  threadId?: string;
}

/**
 * MessageReceivedEmitter — fires when a coach → client message is delivered.
 *
 * Privacy note: only the sender's name is included in the notification body.
 * No message content, no PII from other users, no financial or body data.
 *
 * Called fire-and-forget from MessagingService.sendMessage.
 */
@Injectable()
export class MessageReceivedEmitter {
  private readonly logger = new Logger(MessageReceivedEmitter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async emit(recipientUserId: string, payload: MessageReceivedPayload): Promise<void> {
    try {
      const body = `New message from ${payload.senderName}`.slice(0, 160);
      const deepLink = payload.threadId
        ? `tgp://messages/${payload.threadId}`
        : 'tgp://messages';

      await this.notifications.createNotification({
        user_id: recipientUserId,
        kind: NotificationKind.MESSAGE_RECEIVED,
        body,
        payload: { senderName: payload.senderName, threadId: payload.threadId },
        deep_link: deepLink,
        channel: 'inapp',
      });

      await this.notifications.createNotification({
        user_id: recipientUserId,
        kind: NotificationKind.MESSAGE_RECEIVED,
        body,
        payload: { senderName: payload.senderName, threadId: payload.threadId },
        deep_link: deepLink,
        channel: 'push',
      });
    } catch (err) {
      this.logger.warn(
        `MessageReceivedEmitter failed for user=${recipientUserId}: ${(err as Error).message}`,
      );
    }
  }
}
