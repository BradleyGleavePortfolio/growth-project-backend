import type { Prisma } from '@prisma/client';

/**
 * Member-readable moderation notices (B-610-4).
 *
 * When a moderator hides content, warns or bans a member from the queue, the
 * member must actually be told, whether or not they allowed push
 * notifications. The notice is a Notification row (channel 'inapp', kind
 * COMMUNITY_MODERATION_NOTICE_KIND) written in the SAME transaction that
 * resolves the report, so "actioned" always means "the member has a notice".
 * The app reads notices from GET /community/safety/notices and shows them in
 * Community safety (and as a banner on the community screens). Push is a
 * best-effort extra on top, never the record.
 *
 * Idempotent per (report, action): repeating the same action on a report
 * never stores a second notice, and an escalation on the same report (Warn,
 * then Ban) stores the notice for the NEW action (B-610-4 round 5: the key
 * used to be the report alone, so a Ban after a Warn left only the warning
 * while the moderator was told the member could read why they were removed).
 *
 * The body carries no reporter identity, no report reason and no copy of the
 * content: only what happened and what the member can do next.
 */

export const COMMUNITY_MODERATION_NOTICE_KIND = 'community_moderation_notice';

export type ModerationNoticeAction = 'hide' | 'warn' | 'ban';

/** Full notice copy shown in Community safety (owner copy rules: plain, warm, no "!"). */
export const MODERATION_NOTICE_MESSAGES: Record<ModerationNoticeAction, string> = {
  warn: 'Your coach or The Growth Project team reviewed a report about something you shared in the community and is giving you a warning. Please read the community guidelines in Community safety. If you think this is a mistake, email the safety contact there.',
  hide: 'Your coach or The Growth Project team removed something you shared in the community because it did not follow the community guidelines. Please read the guidelines in Community safety. If you think this is a mistake, email the safety contact there.',
  ban: 'Your coach or The Growth Project team removed your access to this community because of content that did not follow the community guidelines. Your coaching itself is not affected. If you think this is a mistake, email the safety contact in Community safety.',
};

/** Short inbox body (Notification.body, under 160 characters). */
export const MODERATION_NOTICE_BODIES: Record<ModerationNoticeAction, string> = {
  warn: 'You have a community warning. Open Community safety to read it.',
  hide: 'Something you shared in the community was removed. Open Community safety to read why.',
  ban: 'Your community access was removed. Open Community safety to read why.',
};

export function moderationNoticeKey(moderationActionId: string, action: string): string {
  return `community:moderation_notice:${moderationActionId}:${action}`;
}

/** 'created' = written now; 'exists' = this exact notice was already stored; 'skipped' = no notice for this action. */
export type ModerationNoticeResult = 'created' | 'exists' | 'skipped';

function isNoticeAction(a: string): a is ModerationNoticeAction {
  return a === 'hide' || a === 'warn' || a === 'ban';
}

/**
 * Store the member's notice inside the caller's transaction. Writes the row
 * directly (not through the preference-gated notification core): a safety
 * notice is not optional marketing and must exist even when the member muted
 * notifications.
 */
export async function storeModerationNotice(
  tx: Pick<Prisma.TransactionClient, 'notification'>,
  input: {
    recipientId: string;
    moderationActionId: string;
    action: string;
    targetType: string;
    targetId: string;
  },
): Promise<ModerationNoticeResult> {
  if (!isNoticeAction(input.action)) return 'skipped';
  const key = moderationNoticeKey(input.moderationActionId, input.action);
  // A member has a handful of these at most, so the idempotency check reads
  // their notices and compares the key (portable, no JSON-path operator).
  const existing = await tx.notification.findMany({
    where: { user_id: input.recipientId, kind: COMMUNITY_MODERATION_NOTICE_KIND },
    select: { payload: true },
  });
  if (existing.some((n) => isJsonObject(n.payload) && n.payload.idempotency_key === key)) {
    return 'exists';
  }
  await tx.notification.create({
    data: {
      user_id: input.recipientId,
      kind: COMMUNITY_MODERATION_NOTICE_KIND,
      body: MODERATION_NOTICE_BODIES[input.action],
      channel: 'inapp',
      deep_link: 'tgp://community/safety',
      payload: {
        idempotency_key: key,
        action: input.action,
        moderation_action_id: input.moderationActionId,
        target_type: input.targetType,
        target_id: input.targetId,
      },
    },
  });
  return 'created';
}

export interface ModerationNoticeView {
  id: string;
  action: ModerationNoticeAction;
  message: string;
  created_at: string;
  read: boolean;
}

function isJsonObject(v: Prisma.JsonValue | null): v is Prisma.JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Map a stored Notification row to the member-facing view (null when malformed). */
export function noticeView(row: {
  id: string;
  payload: Prisma.JsonValue | null;
  created_at: Date;
  read_at: Date | null;
}): ModerationNoticeView | null {
  const payload = isJsonObject(row.payload) ? row.payload : null;
  const action = typeof payload?.action === 'string' ? payload.action : '';
  if (!isNoticeAction(action)) return null;
  return {
    id: row.id,
    action,
    message: MODERATION_NOTICE_MESSAGES[action],
    created_at: row.created_at.toISOString(),
    read: row.read_at instanceof Date,
  };
}
