/**
 * B-SCHED2-121: booking pushes go through NotificationsService.sendPush (the
 * push stack's outbox sender). Scheduling specs fake that one call: each
 * push is recorded with the lock-screen copy the real sender would store
 * (push/lock-screen-copy.ts, the same function), the exactly-once key and
 * the context. The fake never de-duplicates, so a double send by the
 * scheduling claim logic still shows up as two pushes.
 */
import { lockScreenCopy, type PushContext } from '../../src/notifications/push/lock-screen-copy';
import type { EnqueueResult } from '../../src/notifications/push/push-delivery.service';

export interface SendPushInput {
  user_id: string;
  kind: string;
  body: string;
  deep_link?: string;
  context?: PushContext | null;
  dedupe_key?: string | null;
}

export interface RecordedPush {
  userId: string;
  kind: string;
  /** What the lock screen shows (the real sender's copy). */
  title: string;
  body: string;
  /** The inbox body the emitter handed over; the sender never shows it. */
  inboxBody: string;
  dedupeKey: string | null;
  context: PushContext | null;
  data: Record<string, unknown>;
}

export const QUEUED: EnqueueResult = { code: 'queued', notBefore: new Date(0) };

export function recordPush(pushes: RecordedPush[], input: SendPushInput, now?: Date): void {
  const copy = lockScreenCopy(input.kind, input.body, input.context, now ?? new Date());
  pushes.push({
    userId: input.user_id,
    kind: input.kind,
    title: copy.title,
    body: copy.body,
    inboxBody: input.body,
    dedupeKey: input.dedupe_key ?? null,
    context: input.context ?? null,
    data: { kind: input.kind, sessionId: input.context?.sessionId, deepLink: input.deep_link },
  });
}
