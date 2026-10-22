/**
 * SC-PUSH: who gets which push for one stored space chat message, and how it looks (#167-8, owner model
 * 6348239806). Pure; the service feeds it readers already cleared of blocks and bans.
 *
 * - All messages: one notification per person per space, "{N} unread messages in {space}". The first unread
 *   message rings; later ones update the same notification quietly (one collapseId on iOS, one tag on
 *   Android, no sound, interruptionLevel 'passive'). Reading the space (POST .../read) starts over at 1.
 * - Mute low: only priority pushes. Mute all (and a running silence): nothing, High alerts too.
 * - Priority: a reply rings for the person replied to; a coach's High alert rings for everyone not on Mute all.
 * Lock screen (B-692-1): fixed copy only; never a name or the message text.
 */
import type { NotifyMode } from '../space-reads/community-space-reads.service';

export const spacePushOn = (): boolean => process.env.FEATURE_COMMUNITY_SPACE_PUSH === 'true';

/** High alerts a coach may send in one space per day. */
export const HIGH_ALERT_DAILY_LIMIT = 3;

export type SpacePushKind = 'unread' | 'reply' | 'high_alert';

export interface SpacePushReader {
  userId: string;
  effectiveMode: NotifyMode;
  /** Their unread count in the space after this message (the badge number, capped at 99). */
  unread: number;
}

export interface SpacePushMessage {
  senderId: string;
  /** The author of the message this one replies to, if any. */
  repliedToId: string | null;
  highAlert: boolean;
}

export interface SpacePush {
  userId: string;
  kind: SpacePushKind;
  unread: number;
}

export function planSpacePush(message: SpacePushMessage, readers: readonly SpacePushReader[]): SpacePush[] {
  const out: SpacePush[] = [];
  for (const r of readers) {
    if (r.userId === message.senderId || r.effectiveMode === 'mute_all') continue;
    const kind: SpacePushKind | null = message.highAlert
      ? 'high_alert'
      : r.userId === message.repliedToId
        ? 'reply'
        : r.effectiveMode === 'all' && r.unread > 0
          ? 'unread'
          : null;
    if (kind) out.push({ userId: r.userId, kind, unread: r.unread });
  }
  return out;
}

/** What the outbox row carries (PushContext.spacePush) so the send step can build the lock screen and the
 * Expo fields. Ids, a count and the space name only. */
export interface SpacePushContext {
  kind: SpacePushKind;
  unread: number;
  space: string;
  cohortId: string;
}

/** One id per (member, space): it goes only to that member's own device. */
export const spaceCollapseId = (cohortId: string): string => `space-unread-${cohortId}`;

/** Wording needed (owner rule 137-2): every line here is "needs owner". */
export function spacePushCopy(p: SpacePushContext): { title: string; body: string } {
  if (p.kind === 'high_alert') {
    return { title: 'High alert', body: `Your coach posted a high alert in ${p.space}. Open the app to read it.` };
  }
  if (p.kind === 'reply') {
    return { title: 'New reply', body: `Someone replied to your message in ${p.space}. Open the app to read it.` };
  }
  const n = p.unread >= 99 ? '99+' : String(p.unread);
  return { title: p.space, body: p.unread === 1 ? `1 unread message in ${p.space}` : `${n} unread messages in ${p.space}` };
}

/** Extra Expo fields: the unread notification collapses and goes quiet after the first; priority ones ring. */
export function spacePushExpoFields(p: SpacePushContext | undefined): {
  sound?: 'default' | null;
  interruptionLevel?: 'active' | 'passive' | 'time-sensitive';
  collapseId?: string;
  tag?: string;
} {
  if (!p) return {};
  if (p.kind !== 'unread') return { sound: 'default', interruptionLevel: 'time-sensitive' };
  const id = spaceCollapseId(p.cohortId);
  return p.unread <= 1
    ? { sound: 'default', interruptionLevel: 'active', collapseId: id, tag: id }
    : { sound: null, interruptionLevel: 'passive', collapseId: id, tag: id };
}

/** Reads PushContext.spacePush back from a stored outbox row; anything malformed is dropped. */
export function asSpacePushContext(v: unknown): { spacePush: SpacePushContext } | Record<string, never> {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const kinds: readonly unknown[] = ['unread', 'reply', 'high_alert'];
  if (!kinds.includes(o.kind) || typeof o.unread !== 'number' || typeof o.space !== 'string' || typeof o.cohortId !== 'string') {
    return {};
  }
  return { spacePush: { kind: o.kind as SpacePushKind, unread: o.unread, space: o.space, cohortId: o.cohortId } };
}
