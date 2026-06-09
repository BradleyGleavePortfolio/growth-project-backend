/**
 * community-notifications.types.ts — typed Community push payloads + the
 * code-level preference-defaults and lock-screen-privacy tables (v1-4).
 *
 * No schema migration: the v1-1 NotificationPreferences table has no column
 * for these seven kinds, so their channel defaults live HERE and are applied
 * at the read path. Each kind maps onto an EXISTING NotificationCategory.
 *
 * LOCK-SCREEN PRIVACY (DIRTY-CRITICAL): when privacy is on, the push body MUST
 * be a fixed safe string that contains NO user names, message excerpts, post
 * content, cohort names, event titles, or any tenant-scoped data.
 */

import { NotificationCategory } from '../../notifications/notification-category.enum';
import { NotificationKind } from '../../notifications/notification-kind';

/** The seven community push-kind string values (the new NotificationKinds). */
export type CommunityPushKind =
  | typeof NotificationKind.COMMUNITY_MESSAGE_RECEIVED
  | typeof NotificationKind.COMMUNITY_DM_RECEIVED
  | typeof NotificationKind.COMMUNITY_POST_REPLIED
  | typeof NotificationKind.COMMUNITY_EVENT_STARTING_SOON
  | typeof NotificationKind.COMMUNITY_CHALLENGE_MILESTONE
  | typeof NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME
  | typeof NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED;

/** Per-channel default flags for one kind. */
export interface CommunityChannelDefaults {
  readonly category: NotificationCategory;
  readonly push: boolean;
  readonly inapp: boolean;
  readonly email: boolean;
}

/**
 * §8.1 preference-defaults table. Applied at the read path (no migration).
 * Membership-changed push defaults OFF (too noisy); everything else push ON.
 */
export const COMMUNITY_PUSH_DEFAULTS: Readonly<
  Record<CommunityPushKind, CommunityChannelDefaults>
> = {
  [NotificationKind.COMMUNITY_MESSAGE_RECEIVED]: {
    category: NotificationCategory.COACH_DIRECT,
    push: true,
    inapp: true,
    email: false,
  },
  [NotificationKind.COMMUNITY_DM_RECEIVED]: {
    category: NotificationCategory.COACH_DIRECT,
    push: true,
    inapp: true,
    email: false,
  },
  [NotificationKind.COMMUNITY_POST_REPLIED]: {
    category: NotificationCategory.CLIENT_BOT,
    push: true,
    inapp: true,
    email: false,
  },
  [NotificationKind.COMMUNITY_EVENT_STARTING_SOON]: {
    category: NotificationCategory.MILESTONE,
    push: true,
    inapp: true,
    email: false,
  },
  [NotificationKind.COMMUNITY_CHALLENGE_MILESTONE]: {
    category: NotificationCategory.MILESTONE,
    push: true,
    inapp: true,
    email: false,
  },
  [NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME]: {
    category: NotificationCategory.SYSTEM,
    push: true,
    inapp: true,
    email: true,
  },
  [NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED]: {
    category: NotificationCategory.SYSTEM,
    push: false, // too noisy — in-app only by default
    inapp: true,
    email: false,
  },
};

/**
 * §8.2 lock-screen-privacy bodies. `privacyOn` is the fixed safe string used
 * when the recipient has lock-screen privacy enabled — it NEVER interpolates
 * tenant data. `privacyOff(ctx)` builds the richer body from caller-supplied,
 * pre-approved short context (cohort name, initials, event title). Only the
 * four high-signal kinds have a privacy-off template per the brief; the other
 * three fall back to the safe string in both states.
 */
export interface CommunityPushBodyContext {
  cohortName?: string;
  senderInitial?: string;
  replierInitial?: string;
  eventTitle?: string;
}

interface CommunityPushBodyCopy {
  readonly privacyOn: string;
  readonly privacyOff: (ctx: CommunityPushBodyContext) => string;
}

export const COMMUNITY_PUSH_BODIES: Readonly<
  Record<CommunityPushKind, CommunityPushBodyCopy>
> = {
  [NotificationKind.COMMUNITY_MESSAGE_RECEIVED]: {
    privacyOn: 'New community message',
    privacyOff: (c) =>
      c.cohortName ? `${c.cohortName} · new message` : 'New community message',
  },
  [NotificationKind.COMMUNITY_DM_RECEIVED]: {
    privacyOn: 'New direct message',
    privacyOff: (c) =>
      c.senderInitial
        ? `${c.senderInitial} sent you a message`
        : 'New direct message',
  },
  [NotificationKind.COMMUNITY_POST_REPLIED]: {
    privacyOn: 'New reply on your post',
    privacyOff: (c) =>
      c.replierInitial
        ? `${c.replierInitial} replied to your post`
        : 'New reply on your post',
  },
  [NotificationKind.COMMUNITY_EVENT_STARTING_SOON]: {
    privacyOn: 'Event starting soon',
    privacyOff: (c) =>
      c.eventTitle ? `${c.eventTitle} starts in 15 min` : 'Event starting soon',
  },
  // The remaining three carry no privacy-off template (no per-brief richer
  // copy); the safe string is used regardless of privacy state.
  [NotificationKind.COMMUNITY_CHALLENGE_MILESTONE]: {
    privacyOn: 'Challenge milestone reached',
    privacyOff: () => 'Challenge milestone reached',
  },
  [NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME]: {
    privacyOn: 'A moderation update affects your content',
    privacyOff: () => 'A moderation update affects your content',
  },
  [NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED]: {
    privacyOn: 'Your community membership changed',
    privacyOff: () => 'Your community membership changed',
  },
};

/** Per-kind notification title (generic; never tenant-scoped). */
export const COMMUNITY_PUSH_TITLES: Readonly<
  Record<CommunityPushKind, string>
> = {
  [NotificationKind.COMMUNITY_MESSAGE_RECEIVED]: 'Community',
  [NotificationKind.COMMUNITY_DM_RECEIVED]: 'Direct message',
  [NotificationKind.COMMUNITY_POST_REPLIED]: 'Community',
  [NotificationKind.COMMUNITY_EVENT_STARTING_SOON]: 'Community event',
  [NotificationKind.COMMUNITY_CHALLENGE_MILESTONE]: 'Challenge',
  [NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME]: 'Moderation',
  [NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED]: 'Community',
};
