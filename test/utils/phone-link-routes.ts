/**
 * The phone's two route tables and its tap order, copied for server tests (COMMUNITY-LINKS-BE, agent 203).
 *
 * Copied from growth-project-mobile at 868825cc8c472ee120fcab7266b3c76a20a20051 (mobile main on 11-12; the same
 * files as 9b47c2935f8e195e5cb9e66cd7dc52214d6b125c, whose compare lists none of them):
 *   - src/navigation/incomingLinks.ts:5-22 incomingLinkPath and isPublicLinkPath, :32 UUID, :37-105 resolveAppLink;
 *   - src/services/pushTapRouter.ts:97-134 CLIENT_PUSH_ROUTES, :137-179 COACH_PUSH_ROUTES, :342-347
 *     resolvePushTarget, and the tap order of routePushTap (:300-310), routeAppLink (:327-339), flushPendingPushTap
 *     (:364-368) and deliver (:385-401);
 *   - src/services/pushNotifications.ts:159-170 fallbackScreenForKind and pushScreenOf, :179-186 dispatchResponse;
 *   - src/services/notificationsApi.ts:317-325 inboxScreenForKind, :396-412 normalizeNotification's screen, params
 *     and link; src/screens/notifications/NotificationCenterScreen.tsx:82-100 routeNotification.
 * The phone's feature flags are a parameter: every switch on ([R27]) unless a case says otherwise. What is left out:
 * the navigator's mounted-route checks (every role's routes are taken as mounted), the open-work and `pop` handling,
 * the tap dedupe and the session hold. The coach's message chat (coachInbox.ts chatTarget) is named, not opened.
 * One copy: test/community/coach-dm-access.spec.ts reads its link parse from here.
 */

export interface PhoneFlags {
  clientCalendar: boolean;
  communityTab: boolean;
  communityEvents: boolean;
  coachCommunity: boolean;
  coachTabsV2: boolean;
  coachBrief: boolean;
  clientTimelineV2: boolean;
  romanChat: boolean;
  creditPacksHidden: boolean;
}

export const ALL_ON: PhoneFlags = {
  clientCalendar: true,
  communityTab: true,
  communityEvents: true,
  coachCommunity: true,
  coachTabsV2: true,
  coachBrief: true,
  clientTimelineV2: true,
  romanChat: true,
  creditPacksHidden: false,
};

export type PhoneRole = 'student' | 'coach';

/** incomingLinks.ts:5-17, as written. */
export function incomingLinkPath(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)([?#].*)?$/i.exec(url);
  if (!match || /[\s\\]/.test(url)) return null;
  const [, rawScheme, host, path, suffix = ''] = match;
  const scheme = rawScheme.toLowerCase();
  if (scheme === 'https') {
    if (host.toLowerCase() !== 'app.trygrowthproject.com') return null;
    return path.replace(/^\/+/, '') + suffix;
  }
  if (scheme !== 'tgp' && scheme !== 'com.growthproject.app') return null;
  if (/[@:%]/.test(host)) return null;
  return (host + path).replace(/^\/+/, '') + suffix;
}

/** incomingLinks.ts:20-22, as written. */
export function isPublicLinkPath(path: string): boolean {
  return /^(?:welcome|login|auth\/callback|verified|join(?:\/[^/?#]*)?|invite\/accept\/[^/?#]+|reset-password)(?:[?#]|$)/i.test(path);
}

export interface PhoneTarget {
  root: string;
  screen?: string;
  params?: Record<string, string>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nested = (root: string, screen: string, params?: Record<string, string>): PhoneTarget =>
  params ? { root, screen, params } : { root, screen };
/** src/utils/packageShare.ts:27-31. */
const isValidPackageShareToken = (t: string) => t.length > 0 && t.length <= 128 && /^[A-Za-z0-9_-]+$/.test(t);

/** incomingLinks.ts:37-105, as written (the `initial` and `pop` marks dropped). */
export function resolveAppLink(path: string, role: PhoneRole, flags: PhoneFlags = ALL_ON): PhoneTarget | null {
  let segments: string[];
  try {
    segments = path.split(/[?#]/, 1)[0].replace(/\/$/, '').split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  const [first, id] = segments;
  const plain = segments.join('/');
  const pair = segments.length === 2;
  const uuidPair = pair && UUID.test(id);
  if (role === 'student') {
    if (first === 'meal-plan' && uuidPair) return nested('MoreTab', 'ClientDailyMealPlan', { assignmentId: id });
    if (first === 'workouts' && uuidPair) return nested('MoreTab', 'WorkoutAssignmentDetail', { assignmentId: id });
    if (plain === 'workouts') return nested('WorkoutTab', 'WorkoutMain');
    if (plain === 'home') return nested('Home', 'HomeMain');
    if (plain === 'plan') return nested('MoreTab', 'ClientDailyMealPlan');
    if (plain === 'weight') return nested('MoreTab', 'Progress');
    if (plain === 'timeline') return nested('MoreTab', 'Timeline');
    if (plain === 'checkin/today') return nested('Home', 'Habits');
    if (plain === 'messages' || (first === 'messages' && uuidPair)) return nested('Home', 'Messages');
    if (plain === 'billing/update' || plain === 'billing/update-card') return nested('MoreTab', 'UpdateCard');
    if (first === 'p' && pair && isValidPackageShareToken(id)) return nested('MoreTab', 'PackageCheckout', { shareToken: id });
    const query = new URLSearchParams(path.split('?')[1]?.split('#')[0]);
    if (plain === 'wearables/connected') {
      const params: Record<string, string> = {};
      for (const key of ['status', 'provider', 'ticket']) {
        const value = query.get(key);
        if (value !== null && value.length <= 200) params[key] = value;
      }
      return nested('MoreTab', 'Connections', params);
    }
    if (first === 'checkout' && pair && (id === 'success' || id === 'cancel')) {
      const params: Record<string, string> = { outcome: id };
      const sessionId = query.get('session_id');
      if (sessionId && /^[A-Za-z0-9_]{1,200}$/.test(sessionId)) params.session_id = sessionId;
      return nested('MoreTab', 'CheckoutReturn', params);
    }
    if (flags.clientCalendar) {
      const sessionId = first === 'sessions' && uuidPair ? id
        : segments.length === 3 && first === 'client' && id === 'sessions' && UUID.test(segments[2]) ? segments[2] : null;
      if (sessionId) return nested('CalendarTab', 'CalendarSession', { sessionId });
    }
    if (flags.communityTab) {
      if (plain === 'community' || plain === 'community/home') return { root: 'CommunityTab' };
      if (segments.length === 3 && first === 'community' && UUID.test(segments[2])) {
        if (id === 'thread') return nested('CommunityTab', 'CommunityThread', { postId: segments[2] });
        if (id === 'dm') return nested('CommunityTab', 'CommunityDmThread', { recipientId: segments[2] });
      }
    }
    return null;
  }
  if (plain === 'messages' || (first === 'messages' && uuidPair)) {
    return flags.coachTabsV2 ? { root: 'Messages', screen: 'MessagesInbox' } : { root: 'Messages' };
  }
  if (first !== 'coach') return null;
  if (id === 'clients' && UUID.test(segments[2] ?? '') &&
      (segments.length === 3 || (segments.length === 4 && segments[3] === 'checkins'))) {
    return nested('ClientsStack', 'ClientDetail', { clientId: segments[2], clientName: '' });
  }
  if (id === 'sessions' && segments.length === 3 && UUID.test(segments[2])) {
    return flags.coachTabsV2 ? { root: 'CalendarStack', screen: 'CoachBookingInbox' } : nested('ClientsStack', 'CoachBookingInbox');
  }
  if (plain === 'coach/brief/today' && flags.coachBrief) return nested('SettingsStack', 'CoachBrief');
  if (plain === 'coach/alerts') return { root: 'CommandCenter', params: { tab: 'action-queue' } };
  return null;
}

type Resolver = (f: PhoneFlags) => PhoneTarget | null;

/** pushTapRouter.ts:97-134 (PlanRenewal's pop-up hook dropped). */
export const CLIENT_PUSH_ROUTES: Record<string, Resolver> = {
  Messages: () => ({ root: 'Home', screen: 'Messages' }),
  NotificationCenter: () => ({ root: 'Home', screen: 'NotificationCenter' }),
  PlanRenewal: () => ({ root: 'Home', screen: 'HomeMain' }),
  Notifications: () => ({ root: 'Home', screen: 'NotificationCenter' }),
  Habits: () => ({ root: 'Home', screen: 'Habits' }),
  Timeline: () => ({ root: 'MoreTab', screen: 'Timeline' }),
  MoreIndex: () => ({ root: 'MoreTab', screen: 'MoreIndex' }),
  AIGuide: (f) => ({ root: 'MoreTab', screen: f.romanChat ? 'RomanChat' : 'MoreIndex' }),
  Membership: () => ({ root: 'MoreTab', screen: 'Membership' }),
  Deliverables: () => ({ root: 'MoreTab', screen: 'Deliverables' }),
  UpdateCard: () => ({ root: 'MoreTab', screen: 'UpdateCard' }),
  WorkoutMain: () => ({ root: 'WorkoutTab', screen: 'WorkoutMain' }),
  Log: () => ({ root: 'Log' }),
  CalendarSession: (f) =>
    f.clientCalendar ? { root: 'CalendarTab', screen: 'CalendarSession' } : { root: 'Home', screen: 'NotificationCenter' },
  CommunityEventDetail: (f) => (f.communityTab && f.communityEvents ? { root: 'CommunityTab', screen: 'CommunityEventDetail' } : null),
  Community: (f) => (f.communityTab ? { root: 'CommunityTab' } : null),
};

/** pushTapRouter.ts:137-179. */
export const COACH_PUSH_ROUTES: Record<string, Resolver> = {
  Messages: (f) => (f.coachTabsV2 ? { root: 'Messages', screen: 'MessagesInbox' } : { root: 'Messages' }),
  NotificationCenter: () => ({ root: 'ClientsStack', screen: 'NotificationCenter' }),
  Notifications: () => ({ root: 'ClientsStack', screen: 'NotificationCenter' }),
  NotificationPreferences: () => ({ root: 'ClientsStack', screen: 'NotificationPreferences' }),
  CoachBookingInbox: (f) =>
    f.coachTabsV2 ? { root: 'CalendarStack', screen: 'CoachBookingInbox' } : { root: 'ClientsStack', screen: 'CoachBookingInbox' },
  CoachActionQueue: () => ({ root: 'CommandCenter', params: { tab: 'action-queue' } }),
  CoachSafetyAlert: () => ({ root: 'ClientsStack', screen: 'CoachSafetyAlert' }),
  ClientConsultation: () => ({ root: 'ClientsStack', screen: 'ClientConsultation' }),
  CoachBrief: (f) => (f.coachBrief ? { root: 'SettingsStack', screen: 'CoachBrief' } : null),
  CreditPackCheckout: (f) =>
    f.creditPacksHidden ? { root: 'SettingsStack', screen: 'SettingsHome' } : { root: 'SettingsStack', screen: 'CreditPackCheckout' },
  CommunityEventDetail: (f) =>
    f.coachCommunity && f.communityEvents ? { root: 'CommunityStack', screen: 'CoachCommunityEvents' } : null,
  CoachCommunityEvents: (f) =>
    f.coachCommunity && f.communityEvents ? { root: 'CommunityStack', screen: 'CoachCommunityEvents' } : null,
};

const ROLE_ROUTES: Record<PhoneRole, Record<string, Resolver>> = { student: CLIENT_PUSH_ROUTES, coach: COACH_PUSH_ROUTES };
const PUSH_SCREEN_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ROW_SCREEN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/** pushTapRouter.ts:342-347: an unknown or unavailable screen lands on the role's Notifications list. */
export function resolvePushTarget(role: PhoneRole, screen: string, flags: PhoneFlags = ALL_ON): PhoneTarget {
  const routes = ROLE_ROUTES[role];
  const resolver = Object.prototype.hasOwnProperty.call(routes, screen) ? routes[screen] : undefined;
  return (resolver ? resolver(flags) : null) ?? (routes.NotificationCenter(flags) as PhoneTarget);
}

/** pushNotifications.ts:159-164, as written. */
export function fallbackScreenForKind(kind: unknown): string | undefined {
  if (typeof kind !== 'string' || kind.length === 0) return undefined;
  if (kind.startsWith('community_')) return 'Community';
  if (kind === 'workout_reminder') return 'WorkoutMain';
  return 'NotificationCenter';
}

/** notificationsApi.ts:317-325, as written. */
export function inboxScreenForKind(kind: string): string | undefined {
  if (kind.startsWith('community_')) return 'Community';
  if (kind.startsWith('message')) return 'Messages';
  if (kind === 'workout_reminder' || kind === 'workout_assigned') return 'WorkoutMain';
  if (kind === 'drip_released') return 'Deliverables';
  return undefined;
}

/** Where one tap lands: a screen, the role's Notifications list (an unresolved link), or nowhere. */
export type PhoneLanding = PhoneTarget | 'dropped' | 'nothing';

function stringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) continue;
    if (typeof v === 'string' && v.length <= 200) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** deliver (pushTapRouter.ts:377-401): a coach's message naming its client opens that chat, else the table. */
function deliver(role: PhoneRole, screen: string, params: Record<string, string> | undefined, flags: PhoneFlags): PhoneTarget {
  if (screen === 'Messages' && role === 'coach' && params && UUID.test(params.clientId ?? '') && params.clientName?.trim()) {
    return { root: 'Messages', screen: 'ClientChat', params: { clientId: params.clientId } };
  }
  const t = resolvePushTarget(role, screen, flags);
  return params ? { ...t, params: { ...params, ...t.params } } : t;
}

/** routePushTap (pushTapRouter.ts:294-324) through flushPendingPushTap (:350-375). */
export function routePushTap(
  role: PhoneRole,
  actionScreen: string | undefined,
  actionParams: unknown,
  deepLink: string | undefined,
  flags: PhoneFlags = ALL_ON,
): PhoneLanding {
  if (deepLink !== undefined) {
    const path = incomingLinkPath(deepLink);
    if (path === null) return 'dropped';
    if (!actionScreen || actionScreen === 'NotificationCenter') {
      if (isPublicLinkPath(path)) return 'dropped';
      return resolveAppLink(path, role, flags) ?? resolvePushTarget(role, 'NotificationCenter', flags);
    }
  }
  if (!actionScreen || !PUSH_SCREEN_NAME.test(actionScreen)) return 'nothing';
  return deliver(role, actionScreen, stringMap(actionParams), flags);
}

/** A device push's tap: dispatchResponse (pushNotifications.ts:172-187) into routePushTap. */
export function devicePushTap(role: PhoneRole, data: Record<string, unknown>, flags: PhoneFlags = ALL_ON): PhoneLanding {
  const own = data.kind === 'plan_renewal' ? 'PlanRenewal' : typeof data.actionScreen === 'string' ? data.actionScreen : undefined;
  const actionScreen = own ?? fallbackScreenForKind(data.kind);
  const deepLink = data.deepLink ?? data.deep_link;
  return routePushTap(role, actionScreen, data.actionParams, typeof deepLink === 'string' ? deepLink : undefined, flags);
}

/** The screen, params and link the phone reads off an inbox row (notificationsApi.ts:396-412). */
export function rowTapTarget(row: { kind: string; deep_link?: string | null; payload?: unknown }): {
  actionScreen?: string;
  actionParams?: Record<string, string>;
  deepLink?: string;
} {
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
  const blocker = row.kind === 'dunning_blocker' && typeof payload.headline === 'string' && payload.headline.trim();
  const screenRaw = payload.actionScreen;
  const actionScreen =
    typeof screenRaw === 'string' && ROW_SCREEN_NAME.test(screenRaw) ? screenRaw : blocker ? 'UpdateCard' : inboxScreenForKind(row.kind);
  const name = typeof payload.senderName === 'string' ? payload.senderName.trim() : '';
  const actionParams =
    stringMap(payload.actionParams) ??
    (row.kind === 'drip_released' && actionScreen === 'Deliverables'
      ? stringMap({ purchaseId: payload.client_purchase_id })
      : row.kind === 'message_received' && actionScreen === 'Messages' && typeof payload.threadId === 'string' && name && name !== 'Your coach'
        ? stringMap({ clientId: payload.threadId, clientName: name })
        : undefined);
  const link = row.deep_link ?? payload.deepLink ?? payload.deep_link;
  return {
    ...(actionScreen ? { actionScreen } : {}),
    ...(actionParams ? { actionParams } : {}),
    ...(typeof link === 'string' ? { deepLink: link } : {}),
  };
}

/** An inbox row's tap: routeNotification (NotificationCenterScreen.tsx:82-100). */
export function rowTap(
  role: PhoneRole,
  row: { kind: string; deep_link?: string | null; payload?: unknown },
  flags: PhoneFlags = ALL_ON,
): PhoneLanding {
  const t = rowTapTarget(row);
  if (t.deepLink !== undefined) return routePushTap(role, t.actionScreen, t.actionParams, t.deepLink, flags);
  if (!t.actionScreen) return 'nothing';
  return PUSH_SCREEN_NAME.test(t.actionScreen) ? deliver(role, t.actionScreen, t.actionParams, flags) : 'nothing';
}
