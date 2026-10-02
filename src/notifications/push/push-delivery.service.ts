import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Expo, ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../../prisma.service';

// Device delivery for inbox notifications (C-643-2).
//
// Before this service, emitters wrote a `channel: 'push'` Notification row
// and nothing ever sent it, so no coach message, booking reminder or
// welcome reached a lock screen. This is the one sender those paths use.
//
// Guarantees:
//   - At most once. A failed send is logged and dropped, never retried, so
//     an outage cannot turn into a retry storm.
//   - Never throws to the caller. Every outcome is a typed result.
//   - Rate limits, per process: one push per user per kind per minute, and
//     at most USER_WINDOW_MAX pushes per user per 10 minutes.
//   - Tokens: an Expo token that Expo reports as DeviceNotRegistered (on the
//     ticket or, later, on the receipt) is cleared, but only if the user
//     still has that exact token, so a newer registration is never wiped.
//   - Android: until the owner uploads the FCM V1 key to Expo, Expo answers
//     Android sends with InvalidCredentials. That is a configuration gap, not
//     a device fault: the token is kept, the send is dropped, and the
//     operator gets one clear PUSH_PROVIDER_NOT_CONFIGURED log line per hour
//     per process, not one error per push. iOS (APNs through Expo) is
//     unaffected.
//   - Receipts are checked by a cron a few minutes after the send (Expo
//     publishes them asynchronously), from a bounded in-memory queue.

export const EXPO_PUSH_CLIENT = Symbol('EXPO_PUSH_CLIENT');

/** The part of the Expo SDK this service uses (mocked in tests). */
export interface ExpoPushClient {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  chunkPushNotificationReceiptIds(ids: string[]): string[][];
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export type DeviceDeliveryCode =
  | 'sent'
  | 'no-token'
  | 'invalid-token'
  | 'rate-limited'
  | 'device-not-registered'
  | 'provider-not-configured'
  | 'rejected'
  | 'transport-error';

export interface DeviceDeliveryResult {
  sent: boolean;
  code: DeviceDeliveryCode;
}

export interface DevicePush {
  userId: string;
  kind: string;
  title: string;
  body: string;
  /** Tap routing for the mobile pushTapRouter: ids and enums only, never user text. */
  data?: Record<string, unknown>;
}

interface PendingReceipt {
  id: string;
  userId: string;
  token: string;
  sentAt: number;
}

export const KIND_INTERVAL_MS = 60_000;
export const USER_WINDOW_MS = 10 * 60_000;
export const USER_WINDOW_MAX = 8;
export const RECEIPT_MIN_AGE_MS = 2 * 60_000;
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000;
export const MAX_PENDING_RECEIPTS = 5_000;
export const PROVIDER_ALERT_INTERVAL_MS = 60 * 60_000;
const MAX_TRACKED_USERS = 20_000;

@Injectable()
export class PushDeliveryService {
  private readonly logger = new Logger(PushDeliveryService.name);
  private readonly client: ExpoPushClient;
  private readonly lastByUserKind = new Map<string, number>();
  private readonly sentByUser = new Map<string, number[]>();
  private pending: PendingReceipt[] = [];
  private droppedReceipts = 0;
  private lastProviderAlertAt = Number.NEGATIVE_INFINITY;
  private receiptSweepRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(EXPO_PUSH_CLIENT) client?: ExpoPushClient,
  ) {
    // Same client config as pushToUser / pushToCoach (no access token): the
    // Expo project does not use "enhanced push security". Adding a token
    // would be a new env name (ENV_RULES + launch manifest), out of scope.
    this.client = client ?? new Expo();
  }

  private now(): number {
    return Date.now();
  }

  async deliver(push: DevicePush): Promise<DeviceDeliveryResult> {
    try {
      if (!this.takeRateSlot(push.userId, push.kind)) {
        this.logger.debug(`push rate-limited: user=${push.userId} kind=${push.kind}`);
        return { sent: false, code: 'rate-limited' };
      }
      const user = await this.prisma.user.findUnique({
        where: { id: push.userId },
        select: { expo_push_token: true },
      });
      const token = user?.expo_push_token ?? null;
      if (!token) return { sent: false, code: 'no-token' };
      if (!Expo.isExpoPushToken(token)) {
        this.logger.warn(
          `push skipped: user=${push.userId} has a token that is not an Expo push token`,
        );
        return { sent: false, code: 'invalid-token' };
      }

      const message: ExpoPushMessage = {
        to: token,
        title: push.title,
        body: push.body,
        data: { ...(push.data ?? {}), kind: push.kind },
        sound: 'default',
        channelId: 'default',
        priority: 'high',
      };
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of this.client.chunkPushNotifications([message])) {
        tickets.push(...(await this.client.sendPushNotificationsAsync(chunk)));
      }
      const ticket = tickets[0];
      if (!ticket) {
        this.logger.warn(`push rejected: user=${push.userId} kind=${push.kind} reason=no-ticket`);
        return { sent: false, code: 'rejected' };
      }
      if (ticket.status === 'ok') {
        this.queueReceipt({ id: ticket.id, userId: push.userId, token, sentAt: this.now() });
        return { sent: true, code: 'sent' };
      }
      return {
        sent: false,
        code: await this.handleError(ticket.details?.error, push.userId, token, 'ticket'),
      };
    } catch (err) {
      // Network or Expo outage: drop this one (at most once), no retry.
      this.logger.warn(
        `push transport error: user=${push.userId} kind=${push.kind} error=${err instanceof Error ? err.name : 'unknown'}`,
      );
      return { sent: false, code: 'transport-error' };
    }
  }

  /** Receipts arrive asynchronously at Expo; check them a few minutes after the send. */
  @Cron('*/5 * * * *', { name: 'push-receipts', timeZone: 'UTC' })
  async checkReceipts(): Promise<{ checked: number; remaining: number }> {
    if (this.receiptSweepRunning) return { checked: 0, remaining: this.pending.length };
    this.receiptSweepRunning = true;
    try {
      const now = this.now();
      this.pending = this.pending.filter((p) => now - p.sentAt < RECEIPT_MAX_AGE_MS);
      const due = this.pending.filter((p) => now - p.sentAt >= RECEIPT_MIN_AGE_MS);
      if (due.length === 0) return { checked: 0, remaining: this.pending.length };
      const byId = new Map(due.map((p) => [p.id, p]));
      const settled = new Set<string>();
      for (const chunk of this.client.chunkPushNotificationReceiptIds([...byId.keys()])) {
        let receipts: Record<string, ExpoPushReceipt>;
        try {
          receipts = await this.client.getPushNotificationReceiptsAsync(chunk);
        } catch (err) {
          // Try again on the next sweep; the entry ages out after a day.
          this.logger.warn(
            `push receipts fetch failed: error=${err instanceof Error ? err.name : 'unknown'}`,
          );
          continue;
        }
        for (const [id, receipt] of Object.entries(receipts)) {
          const entry = byId.get(id);
          if (!entry) continue;
          settled.add(id);
          if (receipt.status === 'error') {
            await this.handleError(receipt.details?.error, entry.userId, entry.token, 'receipt');
          }
        }
      }
      this.pending = this.pending.filter((p) => !settled.has(p.id));
      return { checked: settled.size, remaining: this.pending.length };
    } finally {
      this.receiptSweepRunning = false;
    }
  }

  private async handleError(
    error: string | undefined,
    userId: string,
    token: string,
    stage: 'ticket' | 'receipt',
  ): Promise<DeviceDeliveryCode> {
    if (error === 'DeviceNotRegistered') {
      await this.clearToken(userId, token);
      return 'device-not-registered';
    }
    if (error === 'InvalidCredentials') {
      this.alertProviderNotConfigured();
      return 'provider-not-configured';
    }
    this.logger.warn(
      `push ${stage} error: user=${userId} error=${error ?? 'unknown'} (dropped, not retried)`,
    );
    return 'rejected';
  }

  private async clearToken(userId: string, token: string): Promise<void> {
    try {
      // Only the token Expo rejected: a newer registration stays.
      await this.prisma.user.updateMany({
        where: { id: userId, expo_push_token: token },
        data: { expo_push_token: null },
      });
      this.logger.log(`push token cleared: user=${userId} reason=DeviceNotRegistered`);
    } catch (err) {
      this.logger.warn(
        `push token clear failed: user=${userId} error=${err instanceof Error ? err.name : 'unknown'}`,
      );
    }
  }

  private alertProviderNotConfigured(): void {
    const now = this.now();
    if (now - this.lastProviderAlertAt < PROVIDER_ALERT_INTERVAL_MS) return;
    this.lastProviderAlertAt = now;
    this.logger.error(
      'PUSH_PROVIDER_NOT_CONFIGURED: Expo answered InvalidCredentials, so pushes to these devices (Android until the ' +
        'FCM V1 key is uploaded) are dropped. Fix: upload the FCM V1 service-account key in Expo (eas credentials -> ' +
        'Android -> Push Notifications: FCM V1). iOS delivery is not affected. This line repeats at most once an hour.',
    );
  }

  private queueReceipt(entry: PendingReceipt): void {
    this.pending.push(entry);
    if (this.pending.length > MAX_PENDING_RECEIPTS) {
      this.pending.shift();
      this.droppedReceipts += 1;
      if (this.droppedReceipts % 500 === 1) {
        this.logger.warn(
          `push receipt queue full: dropped=${this.droppedReceipts} (oldest receipts are not checked)`,
        );
      }
    }
  }

  private takeRateSlot(userId: string, kind: string): boolean {
    const now = this.now();
    const kindKey = `${userId}:${kind}`;
    const last = this.lastByUserKind.get(kindKey);
    if (last !== undefined && now - last < KIND_INTERVAL_MS) return false;
    const recent = (this.sentByUser.get(userId) ?? []).filter((t) => now - t < USER_WINDOW_MS);
    if (recent.length >= USER_WINDOW_MAX) {
      this.sentByUser.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.sentByUser.set(userId, recent);
    this.lastByUserKind.set(kindKey, now);
    if (
      this.sentByUser.size > MAX_TRACKED_USERS ||
      this.lastByUserKind.size > MAX_TRACKED_USERS * 4
    )
      this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [k, t] of this.lastByUserKind)
      if (now - t >= KIND_INTERVAL_MS) this.lastByUserKind.delete(k);
    for (const [u, ts] of this.sentByUser) {
      const keep = ts.filter((t) => now - t < USER_WINDOW_MS);
      if (keep.length === 0) this.sentByUser.delete(u);
      else this.sentByUser.set(u, keep);
    }
  }
}
